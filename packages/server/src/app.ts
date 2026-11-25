import { readFile } from "node:fs/promises";
import {
  type Actor,
  AXIOM_VERSION,
  type Axiom,
  AxiomError,
  type Epic,
  notificationKindSchema,
  providerSchema,
  type Thread,
  type Ticket,
  TOPIC_STATUSES,
  type TopicDetail,
  type TopicSummary,
  taskStatusSchema,
  topicStatusSchema,
  VIEWS,
} from "@axiom/core";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { backupDir, newestBackupMs } from "./backup.js";
import { artifactMeta, DocsError, readDoc, readImage, resolveArtifact } from "./docs.js";
import type { ChangeBus } from "./events.js";
import type { T3Provider } from "./providers/t3/provider.js";
import { serveWeb } from "./static.js";

const owner: Actor = { kind: "owner" };
const PING_MS = 15_000;

export interface AppContext {
  ax: Axiom;
  bus: ChangeBus;
  t3: T3Provider;
  dbPath: string;
  webDist: string;
  startedAt: string;
  /** Closes open SSE streams on shutdown. */
  streams: Set<() => void>;
  pingMs?: number;
}

const STATUS_CODES = { "not-found": 404, permission: 403, validation: 400, conflict: 409 } as const;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function bad(message: string): AxiomError {
  return new AxiomError("validation", message);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw bad(
      r.error.issues
        .map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
        .join("; "),
    );
  }
  return r.data;
}

function intParam(value: string, what: string): number {
  if (!/^\d+$/.test(value)) throw bad(`${what} must be a positive integer`);
  return Number(value);
}

const bodies = {
  status: z.strictObject({ status: topicStatusSchema, reason: z.string().optional() }),
  taskStatus: z.strictObject({ status: taskStatusSchema }),
  mute: z.strictObject({ muted: z.boolean() }),
  linkUpdate: z.strictObject({ label: z.string().optional(), description: z.string().optional() }),
  thread: z.strictObject({
    provider: providerSchema,
    providerThreadId: z.string().min(1),
    environmentId: z.string().min(1).optional(),
    title: z.string().optional(),
  }),
  favorite: z.strictObject({ on: z.boolean() }),
  deskHidden: z.strictObject({ hidden: z.boolean() }),
  deskOrder: z.strictObject({ slugs: z.array(z.string()) }),
  settings: z.strictObject({
    summaries: z.strictObject({ enabled: z.boolean() }).optional(),
    mutedKinds: z.array(notificationKindSchema).optional(),
    staleAfterDays: z.number().int().positive().optional(),
    layout: z.enum(["inbox", "board", "console"]).optional(),
    theme: z.enum(["dark", "light", "system"]).optional(),
  }),
};

function parent(kind: "ticket" | "epic", p: Ticket | Epic) {
  return {
    kind,
    slug: p.slug,
    title: p.title,
    status: p.status,
    jiraKey: p.jiraKey,
    jiraStatus: p.jiraStatus,
    locked: p.jiraKey !== null,
  };
}

export interface Attention {
  reason: "agent asked" | "error";
  text: string;
  at: string;
}

const ATTENTION_STATUSES: readonly string[] = ["hitl", "error"];

/**
 * Why a topic is in "requires attention": the latest waiting-on-owner or error thread event, or a
 * manual status change to hitl/error with its reason when that is newer. Survives the owner
 * opening the topic (which dismisses the notification).
 */
function attentionOf(
  ax: Axiom,
  topic: { slug: string; status: string | null; openThreadStatuses: readonly string[] },
): Attention | null {
  const needs =
    topic.status === null
      ? topic.openThreadStatuses.some((s) => ATTENTION_STATUSES.includes(s))
      : ATTENTION_STATUSES.includes(topic.status);
  if (!needs) return null;
  let best: Attention | null = null;
  for (const e of ax.listEntries(topic.slug)) {
    const data = (e.data ?? {}) as { event?: string; to?: string | null; reason?: string };
    if (
      e.kind === "thread event" &&
      (data.event === "waiting on owner" || data.event === "error")
    ) {
      best = {
        reason: data.event === "error" ? "error" : "agent asked",
        text: (e.body ?? "")
          .replace(/^Waiting on the owner:\s*/, "")
          .replace(/^Thread error:\s*/, ""),
        at: e.at,
      };
    } else if (
      e.kind === "status change" &&
      data.to &&
      ATTENTION_STATUSES.includes(data.to) &&
      !data.reason?.startsWith("thread ")
    ) {
      best = {
        reason: data.to === "error" ? "error" : "agent asked",
        text: data.reason ?? "",
        at: e.at,
      };
    }
  }
  return best;
}

export function createApp(ctx: AppContext): Hono {
  const { ax, bus } = ctx;
  const app = new Hono();

  const hasOpenStalePrompt = (topicId: number): boolean =>
    !!ax.db
      .prepare(
        "SELECT 1 FROM notification WHERE topic_id = ? AND kind = 'stale prompt' AND dismissed_at IS NULL",
      )
      .get(topicId);

  /** Runs a write and tells the UI. */
  function write<T>(fn: () => T): T {
    const result = fn();
    bus.emit();
    return result;
  }

  function listItem(s: TopicSummary) {
    const d = ax.getTopic(s.slug);
    return {
      id: s.id,
      slug: s.slug,
      title: s.title,
      status: s.status,
      statusNote: s.statusNote,
      goal: s.goal,
      muted: s.muted,
      taskCounts: s.taskCounts,
      views: s.views,
      highlighted: s.highlighted,
      stalePrompt: hasOpenStalePrompt(s.id),
      attention: attentionOf(ax, { ...s, openThreadStatuses: s.openThreadStatuses }),
      parents: [
        ...d.tickets.map((t) => parent("ticket", t)),
        ...d.epics.map((e) => parent("epic", e)),
      ],
      threads: d.threads.map((t) => ({
        id: t.id,
        provider: t.provider,
        title: t.title,
        status: t.status,
        open: t.endedAt === null,
      })),
      createdAt: s.createdAt,
      lastWorkedAt: s.lastWorkedAt,
    };
  }

  /** How the owner opens a thread: T3's web UI, or the command that resumes a Claude Code session. */
  function threadOpen(th: Pick<Thread, "id" | "provider" | "providerThreadId" | "environmentId">) {
    if (th.provider === "t3") {
      const url = ctx.t3.threadUrl(th.providerThreadId, th.environmentId);
      return url ? { kind: "url" as const, url } : null;
    }
    if (th.provider === "claude-code") {
      const cwd = ax.threadCwd(th.id);
      const resume = `claude --resume ${th.providerThreadId}`;
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      return { kind: "command" as const, command: cwd ? `cd ${q(cwd)} && ${resume}` : resume };
    }
    return null;
  }

  function detail(d: TopicDetail) {
    return {
      ...d,
      // The full reply is fetched on its own (GET /api/threads/:id/reply).
      threads: d.threads.map(({ lastReply, ...th }) => ({
        ...th,
        hasReply: lastReply !== null,
        open: threadOpen(th),
      })),
      stalePrompt: hasOpenStalePrompt(d.id),
      attention: attentionOf(ax, d),
      parents: [
        ...d.tickets.map((t) => parent("ticket", t)),
        ...d.epics.map((e) => parent("epic", e)),
      ],
    };
  }

  // ---- guards -------------------------------------------------------------

  // Reject DNS-rebinding (foreign Host) and cross-site requests (foreign Origin).
  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
    if (host !== "" && !LOOPBACK.has(host)) return c.json(err("permission", "bad host"), 403);
    const origin = c.req.header("origin");
    if (origin) {
      let name = "";
      try {
        name = new URL(origin).hostname;
      } catch {}
      if (!LOOPBACK.has(name) && !LOOPBACK.has(`[${name}]`)) {
        return c.json(err("permission", "cross-origin request refused"), 403);
      }
    }
    await next();
  });

  app.onError((e, c) => {
    if (e instanceof AxiomError) {
      return c.json(err(e.code, e.message), STATUS_CODES[e.code]);
    }
    console.error(e);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });

  async function json(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
    try {
      return await c.req.json();
    } catch {
      throw bad("request body must be valid JSON");
    }
  }

  // ---- topics -------------------------------------------------------------

  app.get("/api/topics", (c) => {
    const view = c.req.query("view");
    const status = c.req.query("status");
    if (view !== undefined && !(VIEWS as readonly string[]).includes(view)) {
      throw bad(`unknown view "${view}"`);
    }
    if (status !== undefined && !(TOPIC_STATUSES as readonly string[]).includes(status)) {
      throw bad(`unknown status "${status}"`);
    }
    const all = ["1", "true"].includes(c.req.query("all") ?? "");
    const topics = ax.listTopics({
      view: view as (typeof VIEWS)[number] | undefined,
      status: status as (typeof TOPIC_STATUSES)[number] | undefined,
    });
    // Without a filter, closed topics (done, stale) stay out unless `all` is set.
    const hideClosed = !all && view === undefined && status === undefined;
    return c.json(topics.filter((t) => !(hideClosed && t.views.includes("closed"))).map(listItem));
  });

  app.get("/api/topics/:slug", (c) => c.json(detail(ax.getTopic(c.req.param("slug")))));

  app.get("/api/topics/:slug/entries", (c) => {
    const limitRaw = c.req.query("limit");
    const beforeRaw = c.req.query("before");
    const limit = limitRaw === undefined ? 100 : intParam(limitRaw, "limit");
    if (limit < 1 || limit > 500) throw bad("limit must be between 1 and 500");
    const before =
      beforeRaw === undefined ? Number.POSITIVE_INFINITY : intParam(beforeRaw, "before");
    const entries = ax
      .listEntries(c.req.param("slug"))
      .filter((e) => e.id < before)
      .reverse()
      .slice(0, limit);
    return c.json(entries);
  });

  app.get("/api/topics/:slug/tasks", (c) => c.json(ax.listTasks(c.req.param("slug"))));

  app.post("/api/topics/:slug/tasks/:key/status", async (c) => {
    const body = parse(bodies.taskStatus, await json(c));
    const slug = c.req.param("slug");
    const key = c.req.param("key");
    return c.json(write(() => ax.setTaskStatus(slug, key, body.status, owner)));
  });

  app.patch("/api/topics/:slug/links/:id", async (c) => {
    const body = parse(bodies.linkUpdate, await json(c));
    const slug = c.req.param("slug");
    const id = intParam(c.req.param("id"), "link id");
    return c.json(write(() => ax.updateLink(slug, id, body, owner)));
  });

  app.post("/api/topics/:slug/open", (c) => {
    write(() => ax.openTopic(c.req.param("slug"), owner));
    return c.json({ ok: true });
  });

  app.post("/api/topics/:slug/status", async (c) => {
    const body = parse(bodies.status, await json(c));
    const slug = c.req.param("slug");
    write(() => ax.setTopicStatus(slug, body.status, owner, body.reason));
    return c.json(detail(ax.getTopic(slug)));
  });

  app.post("/api/topics/:slug/mute", async (c) => {
    const body = parse(bodies.mute, await json(c));
    const slug = c.req.param("slug");
    write(() => ax.setTopicMuted(slug, body.muted, owner));
    return c.json(detail(ax.getTopic(slug)));
  });

  app.post("/api/topics/:slug/stale", (c) => {
    const slug = c.req.param("slug");
    write(() => ax.markStale(slug, owner));
    return c.json(detail(ax.getTopic(slug)));
  });

  app.post("/api/topics/:slug/stale-prompt/dismiss", (c) => {
    const slug = c.req.param("slug");
    write(() => ax.dismissStalePrompt(slug, owner));
    return c.json(detail(ax.getTopic(slug)));
  });

  app.post("/api/topics/:slug/threads", async (c) => {
    const body = parse(bodies.thread, await json(c));
    const thread = write(() => ax.attachThread(c.req.param("slug"), body, owner));
    return c.json(thread, 201);
  });

  // ---- the Desk (02) ------------------------------------------------------

  function deskThread(t: TopicDetail["threads"][number]) {
    return {
      id: t.id,
      provider: t.provider,
      providerThreadId: t.providerThreadId,
      title: t.title,
      status: t.status,
      open: t.endedAt === null,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      lastReplyAt: t.lastReplyAt,
      summary:
        t.summaryNow === null
          ? null
          : { now: t.summaryNow, next: t.summaryNext ?? "Nothing", at: t.summaryAt },
      summaryError: t.summaryError,
      hasReply: t.lastReply !== null,
    };
  }

  app.get("/api/desk", (c) => {
    const topics = ax
      .listTopics()
      // Closed topics leave the Desk unless the owner favourited them.
      .filter((t) => t.favorite || (t.status !== "done" && t.status !== "stale"))
      .map((s) => {
        const d = ax.getTopic(s.slug);
        return {
          slug: s.slug,
          title: s.title,
          status: s.status,
          statusNote: s.statusNote,
          favorite: s.favorite,
          deskHidden: s.deskHidden,
          deskOrder: s.deskOrder,
          taskCounts: s.taskCounts,
          linkCount: d.links.length,
          lastWorkedAt: s.lastWorkedAt,
          highlighted: s.highlighted,
          attention: attentionOf(ax, s),
          threads: d.threads.map(deskThread),
        };
      });
    return c.json({ topics });
  });

  app.get("/api/threads/:id/reply", (c) => {
    const th = ax.getThread(intParam(c.req.param("id"), "thread id"));
    if (th.lastReply === null) throw new AxiomError("not-found", "this thread has no reply yet");
    return c.json({ text: th.lastReply, at: th.lastReplyAt });
  });

  app.post("/api/topics/:slug/favorite", async (c) => {
    const body = parse(bodies.favorite, await json(c));
    const slug = c.req.param("slug");
    write(() => ax.setTopicFavorite(slug, body.on, owner));
    return c.json({ slug, favorite: body.on });
  });

  app.post("/api/topics/:slug/desk-hidden", async (c) => {
    const body = parse(bodies.deskHidden, await json(c));
    const slug = c.req.param("slug");
    write(() => ax.setTopicDeskHidden(slug, body.hidden, owner));
    return c.json({ slug, deskHidden: body.hidden });
  });

  app.put("/api/desk/order", async (c) => {
    const body = parse(bodies.deskOrder, await json(c));
    write(() => ax.setDeskOrder(body.slugs, owner));
    return c.json({ slugs: body.slugs });
  });

  app.post("/api/monitors/:id/confirm", (c) => {
    const id = intParam(c.req.param("id"), "monitor id");
    return c.json(write(() => ax.confirmMonitorTarget(id, owner)));
  });

  app.delete("/api/entries/:id", (c) => {
    const id = intParam(c.req.param("id"), "entry id");
    write(() => ax.deleteEntry(id, owner));
    return c.json({ ok: true });
  });

  // ---- documents and images linked from a topic -----------------------------

  const docsFailure = (c: Context, e: unknown) => {
    if (!(e instanceof DocsError)) throw e;
    return c.json(err(e.code, e.message), e.status);
  };

  app.get("/api/topics/:slug/docs/:linkId", async (c) => {
    try {
      const linkId = intParam(c.req.param("linkId"), "link id");
      return c.json(await readDoc(ax, c.req.param("slug"), linkId, c.req.query("path")));
    } catch (e) {
      return docsFailure(c, e);
    }
  });

  app.get("/api/topics/:slug/artifacts/:linkId", (c) => {
    try {
      const linkId = intParam(c.req.param("linkId"), "link id");
      return c.json(artifactMeta(resolveArtifact(ax, c.req.param("slug"), linkId)));
    } catch (e) {
      return docsFailure(c, e);
    }
  });

  app.get("/api/topics/:slug/artifacts/:linkId/raw", async (c) => {
    try {
      const linkId = intParam(c.req.param("linkId"), "link id");
      const a = resolveArtifact(ax, c.req.param("slug"), linkId);
      const headers: Record<string, string> = {
        "content-type": a.type,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      };
      // HTML runs its own scripts in an opaque origin: no access to Axiom's origin, cookies or API.
      // An SVG opened on its own must not run scripts at all.
      if (a.kind === "html") {
        headers["content-security-policy"] =
          "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads";
      } else if (a.type === "image/svg+xml") {
        headers["content-security-policy"] = "sandbox";
      }
      return new Response(new Uint8Array(await readFile(a.path)), { headers });
    } catch (e) {
      return docsFailure(c, e);
    }
  });

  app.get("/api/topics/:slug/files", async (c) => {
    try {
      const path = c.req.query("path");
      if (!path) throw bad("path is required");
      const file = await readImage(ax, c.req.param("slug"), path);
      const headers: Record<string, string> = {
        "content-type": file.type,
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache",
      };
      // An SVG opened on its own must not run scripts.
      if (file.type === "image/svg+xml") headers["content-security-policy"] = "sandbox";
      return new Response(new Uint8Array(file.bytes), { headers });
    } catch (e) {
      return docsFailure(c, e);
    }
  });

  // ---- tickets and epics --------------------------------------------------

  const count = (sql: string, id: number): number =>
    (ax.db.prepare(sql).get(id) as { n: number }).n;

  app.get("/api/tickets", (c) =>
    c.json(
      ax.listTickets().map((t) => ({
        ...t,
        locked: t.jiraKey !== null,
        topicCount: count("SELECT count(*) AS n FROM topic_ticket WHERE ticket_id = ?", t.id),
        epics: ax.listTicketEpics(t.id).map((e) => ({ slug: e.slug, title: e.title })),
      })),
    ),
  );

  app.get("/api/epics", (c) =>
    c.json(
      ax.listEpics().map((e) => ({
        ...e,
        locked: e.jiraKey !== null,
        ticketCount: count("SELECT count(*) AS n FROM ticket_epic WHERE epic_id = ?", e.id),
        // Topics directly under the epic plus topics under its tickets, each counted once.
        topicCount: count(
          `SELECT count(DISTINCT topic_id) AS n FROM (
             SELECT topic_id FROM topic_epic WHERE epic_id = ?1
             UNION ALL
             SELECT topic_ticket.topic_id FROM topic_ticket
               JOIN ticket_epic ON ticket_epic.ticket_id = topic_ticket.ticket_id
               WHERE ticket_epic.epic_id = ?1)`,
          e.id,
        ),
      })),
    ),
  );

  // ---- notifications and settings ----------------------------------------

  app.get("/api/notifications", (c) => {
    const visible = ax.listNotifications();
    const open = (
      ax.db.prepare("SELECT count(*) AS n FROM notification WHERE dismissed_at IS NULL").get() as {
        n: number;
      }
    ).n;
    return c.json({ notifications: visible, hiddenCount: open - visible.length });
  });

  const readSettings = () => ({
    mutedKinds: ax.getSetting("mutedKinds"),
    staleAfterDays: ax.getSetting("staleAfterDays"),
    layout: (ax.getSetting("layout") as string | undefined) ?? "inbox",
    theme: (ax.getSetting("theme") as string | undefined) ?? "system",
    summaries: ax.getSetting("summaries"),
  });

  app.get("/api/settings", (c) => c.json(readSettings()));

  app.put("/api/settings", async (c) => {
    const body = parse(bodies.settings, await json(c));
    write(() => {
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) ax.setSetting(key, value, owner);
      }
    });
    return c.json(readSettings());
  });

  // ---- health -------------------------------------------------------------

  const newestIso = (a: string | null, b: string | null) =>
    a === null ? b : b === null ? a : a > b ? a : b;

  app.get("/api/health", (c) => {
    const last = newestBackupMs(backupDir(ctx.dbPath));
    const event = ax.db
      .prepare(
        `SELECT max(entry.at) AS at FROM entry JOIN thread ON thread.id = entry.thread_id
         WHERE entry.kind = 'thread event' AND thread.provider = 'claude-code'`,
      )
      .get() as { at: string | null };
    return c.json({
      server: {
        startedAt: ctx.startedAt,
        version: AXIOM_VERSION,
        dbPath: ctx.dbPath,
        lastBackupAt: last === null ? null : new Date(last).toISOString(),
      },
      // Any hook run counts (T3-run and unattached sessions too); thread events are the fallback
      // for databases written before hooks recorded this.
      claudeCode: { lastEventAt: newestIso(ax.lastHookEventAt(), event.at) },
      t3: ctx.t3.health(),
    });
  });

  // ---- T3 threads ---------------------------------------------------------

  app.get("/api/t3/threads", (c) => {
    const unattachedOnly = ["1", "true"].includes(c.req.query("unattached") ?? "");
    try {
      return c.json(ctx.t3.listThreads({ unattachedOnly, limit: 50 }));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return c.json(err("unavailable", `T3 cannot be read: ${why}`), 503);
    }
  });

  // ---- server-sent events -------------------------------------------------

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      let done!: () => void;
      const closed = new Promise<void>((resolve) => {
        done = resolve;
      });
      const send = (event: string, data: string) => {
        stream.writeSSE({ event, data }).catch(done);
      };
      const unsubscribe = ctx.bus.subscribe((at) => send("change", JSON.stringify({ at })));
      const ping = setInterval(
        () => send("ping", JSON.stringify({ at: ax.now().toISOString() })),
        ctx.pingMs ?? PING_MS,
      );
      ctx.streams.add(done);
      stream.onAbort(done);
      // An immediate ping flushes the headers so clients know they are connected.
      send("ping", JSON.stringify({ at: ax.now().toISOString() }));
      await closed;
      clearInterval(ping);
      unsubscribe();
      ctx.streams.delete(done);
    }),
  );

  app.all("/api/*", (c) => c.json(err("not-found", "no such endpoint"), 404));

  // ---- web app ------------------------------------------------------------

  app.on(["GET", "HEAD"], "*", (c) => serveWeb(c, ctx.webDist));

  return app;
}

function err(code: string, message: string) {
  return { error: { code, message } };
}
