import {
  type Actor,
  AXIOM_VERSION,
  type Axiom,
  AxiomError,
  type Epic,
  notificationKindSchema,
  providerSchema,
  type Ticket,
  TOPIC_STATUSES,
  type TopicDetail,
  type TopicSummary,
  topicStatusSchema,
  VIEWS,
} from "@axiom/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { backupDir, newestBackupMs } from "./backup.js";
import type { ChangeBus } from "./events.js";
import { serveWeb } from "./static.js";

const owner: Actor = { kind: "owner" };
const PING_MS = 15_000;

export interface AppContext {
  ax: Axiom;
  bus: ChangeBus;
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
  mute: z.strictObject({ muted: z.boolean() }),
  thread: z.strictObject({
    provider: providerSchema,
    providerThreadId: z.string().min(1),
    environmentId: z.string().min(1).optional(),
    title: z.string().optional(),
  }),
  settings: z.strictObject({
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
      views: s.views,
      highlighted: s.highlighted,
      stalePrompt: hasOpenStalePrompt(s.id),
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

  function detail(d: TopicDetail) {
    return {
      ...d,
      stalePrompt: hasOpenStalePrompt(d.id),
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

  app.post("/api/monitors/:id/confirm", (c) => {
    const id = intParam(c.req.param("id"), "monitor id");
    return c.json(write(() => ax.confirmMonitorTarget(id, owner)));
  });

  app.delete("/api/entries/:id", (c) => {
    const id = intParam(c.req.param("id"), "entry id");
    write(() => ax.deleteEntry(id, owner));
    return c.json({ ok: true });
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
      claudeCode: { lastEventAt: event.at },
      t3: { state: "not-configured" },
    });
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
