import { vi } from "vitest";
import type {
  ArtifactData,
  AxiomNotification,
  DeskThread,
  DeskTopic,
  DocData,
  Entry,
  EpicItem,
  MemoryEntry,
  MemoryView,
  NewMemoryBody,
  PendingRequest,
  Settings,
  StewardItem,
  StewardSettings,
  StewardView,
  TaskItem,
  Thread,
  TicketItem,
  TopicDetailData,
  TopicListItem,
} from "../api";

export const STEWARD_DEFAULTS: StewardSettings = {
  enabled: false,
  workingHours: { start: "09:00", end: "19:00", days: [1, 2, 3, 4, 5] },
  wakeIntervalMin: 30,
  ghPollIntervalMin: 10,
  stages: {
    gather: { model: "haiku", effort: "low" },
    decide: { model: "sonnet", effort: "low" },
  },
  complexity: {
    simple: { model: "sonnet", effort: "medium" },
    medium: { model: "opus", effort: "high" },
    hard: null,
  },
  dailyCaps: { haiku: 5_000_000, sonnet: 1_500_000, opus: 400_000 },
  stageTimeoutMin: 10,
  memoryCoreTokens: 2000,
  prSignals: [
    "ci failed",
    "changes requested",
    "new review comments",
    "conflict coming",
    "no reviewer",
    "ready to merge",
  ],
  sources: { github: true, slack: true, googleDrive: true },
};

export function emptyStewardView(): StewardView {
  const off = { on: true, ok: null, reason: null };
  return {
    enabled: false,
    nextWakeAt: null,
    running: false,
    count: 0,
    brief: null,
    blindSpots: [],
    sources: { github: off, slack: off, googleDrive: off },
    needs: [],
    questions: [],
    ready: [],
    info: [],
    usage: [
      { family: "haiku", models: [], runs: 0, used: 0, cap: 5_000_000 },
      { family: "sonnet", models: [], runs: 0, used: 0, cap: 1_500_000 },
      { family: "opus", models: [], runs: 0, used: 0, cap: 400_000 },
    ],
    wakes: [],
    memory: [],
  };
}

export function stewardItem(
  over: Partial<StewardItem> & { id: number; kind: StewardItem["kind"] },
): StewardItem {
  return {
    wakeId: null,
    topicId: null,
    topicSlug: null,
    level: null,
    title: `Item ${over.id}`,
    body: null,
    signal: null,
    source: null,
    state: "open",
    createdAt: T0,
    notified: false,
    action: null,
    note: null,
    fix: null,
    prepared: null,
    ...over,
  };
}

export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

let nextId = 100;
const T0 = "2026-11-25T09:00:00.000Z";

export function topic(over: Partial<TopicListItem> & { slug: string }): TopicListItem {
  return {
    id: nextId++,
    title: over.slug,
    status: "idle",
    statusNote: null,
    goal: null,
    muted: false,
    taskCounts: { total: 0, done: 0 },
    views: ["piles"],
    highlighted: false,
    stalePrompt: false,
    attention: null,
    parents: [],
    threads: [],
    createdAt: T0,
    lastWorkedAt: T0,
    ...over,
  };
}

export function task(over: Partial<TaskItem> & { key: string }): TaskItem {
  return {
    id: nextId++,
    title: `Task ${over.key}`,
    doneWhen: null,
    status: "to do",
    position: 0,
    specLinkId: null,
    dependsOn: [],
    dependents: [],
    waiting: false,
    ...over,
  };
}

/** Fills dependents and waiting from dependsOn and statuses, like the server does. */
export function linkTasks(tasks: TaskItem[]): TaskItem[] {
  for (const t of tasks) {
    t.dependents = tasks.filter((o) => o.dependsOn.includes(t.key)).map((o) => o.key);
    t.waiting = t.dependsOn.some((k) => tasks.find((o) => o.key === k)?.status !== "done");
  }
  return tasks;
}

export function thread(over: Partial<Thread> & { id: number }): Thread {
  return {
    topicId: 1,
    provider: "t3",
    providerThreadId: `pt-${over.id}`,
    environmentId: null,
    title: `Thread ${over.id}`,
    status: "wip",
    startedAt: T0,
    endedAt: null,
    endReason: null,
    ...over,
  };
}

export function deskThread(over: Partial<DeskThread> & { id: number }): DeskThread {
  return {
    provider: "t3",
    providerThreadId: `pt-${over.id}`,
    title: `Thread ${over.id}`,
    status: "idle",
    open: true,
    startedAt: T0,
    endedAt: null,
    lastReplyAt: null,
    summary: null,
    summaryError: null,
    activity: null,
    runtime: null,
    subagents: [],
    hasReply: false,
    pendingRequests: 0,
    ...over,
  };
}

export function deskTopic(over: Partial<DeskTopic> & { slug: string }): DeskTopic {
  return {
    title: over.slug,
    status: "idle",
    statusNote: null,
    favorite: false,
    deskHidden: false,
    deskOrder: null,
    stewardEnabled: true,
    steward: null,
    taskCounts: { total: 0, done: 0 },
    linkCount: 0,
    artifacts: [],
    lastWorkedAt: T0,
    highlighted: false,
    attention: null,
    threads: [],
    ...over,
  };
}

export function entry(over: Partial<Entry> & { id: number }): Entry {
  return {
    topicId: 1,
    at: T0,
    author: "agent",
    threadId: null,
    kind: "note",
    body: "body",
    data: null,
    refs: [],
    ...over,
  };
}

export function notification(over: Partial<AxiomNotification> & { id: number }): AxiomNotification {
  return {
    topicId: 1,
    topicSlug: "a",
    kind: "agent stopped",
    body: "stopped",
    createdAt: T0,
    ...over,
  };
}

export class FakeServer {
  topics: TopicListItem[] = [];
  details = new Map<string, Partial<TopicDetailData>>();
  entries = new Map<string, Entry[]>();
  tasks = new Map<string, TaskItem[]>();
  notifications: AxiomNotification[] = [];
  epics: EpicItem[] = [];
  tickets: TicketItem[] = [];
  settings: Settings = {
    mutedKinds: [],
    staleAfterDays: 14,
    layout: "inbox",
    theme: "dark",
    steward: structuredClone(STEWARD_DEFAULTS),
  };
  /** The Steward page's data (GET /api/steward). */
  steward: StewardView = emptyStewardView();
  /** The diff GET /api/steward/items/:id/diff returns, and a reason Adopt is refused with. */
  fixDiff = { diff: "", truncated: false, branch: "axiom/fix/x" };
  adoptRefusal: string | null = null;
  /** Steward's memory (GET /api/steward/memory). */
  memory: MemoryEntry[] = [];
  memoryKeys: MemoryView["keys"] = { topics: [], repos: [] };
  calls: Call[] = [];
  desk: DeskTopic[] = [];
  /** Full replies by thread id; a missing one is a 404. */
  replies = new Map<number, { text: string; at: string | null }>();
  /** Pending requests by thread id (GET /api/threads/:id/requests). */
  requests = new Map<number, PendingRequest[]>();
  /** How many answer / decision calls answer 502 before one succeeds. */
  answerFails = 0;
  /** Documents by `<slug>:<linkId>` or `<slug>:<linkId>:<?path>`; a missing key is a 404. */
  docs = new Map<string, DocData>();
  /** Artifact metadata by `<slug>:<linkId>`; a missing key is a 404. */
  artifacts = new Map<string, ArtifactData>();

  workspaces: { path: string; label: string; source: string }[] = [];
  /** Answers GET /api/t3/projects; `null` answers 503 unavailable. */
  t3Projects:
    | {
        id: string;
        title: string;
        workspaceRoot: string;
        hasDefaultModel: boolean;
        pinned: boolean;
      }[]
    | null = [];
  composeOptions = {
    source: "static",
    providers: {
      t3: { models: ["claude-opus-5-5", "claude-sonnet-5-5"], efforts: ["low", "high"] },
      "claude-code": { models: ["claude-opus-5-5", "claude-sonnet-5-5"], efforts: ["low", "high"] },
    },
  };
  createTopicFails = false;
  /** How many POST .../threads/new calls answer 502 before one succeeds. */
  newThreadFails = 0;

  install(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => this.handle(input, init)),
    );
  }

  called(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private find(slug: string): TopicListItem | undefined {
    return this.topics.find((t) => t.slug === slug);
  }

  private detail(slug: string): TopicDetailData | undefined {
    const t = this.find(slug);
    if (!t) return undefined;
    const extra = this.details.get(slug) ?? {};
    return {
      ...t,
      openThreadStatuses: t.threads.filter((x) => x.open).map((x) => x.status),
      threads: [],
      links: [],
      monitorTargets: [],
      ...extra,
    } as TopicDetailData;
  }

  private memoryView(): MemoryView {
    const active = this.memory.filter((m) => !m.retiredAt);
    const groups = new Map<
      string,
      { kind: MemoryEntry["attachedKind"]; key: string; count: number }
    >();
    for (const m of active.filter((m) => m.scope === "attached")) {
      const g = groups.get(`${m.attachedKind}:${m.attachedKey}`) ?? {
        kind: m.attachedKind,
        key: m.attachedKey as string,
        count: 0,
      };
      g.count++;
      groups.set(`${m.attachedKind}:${m.attachedKey}`, g);
    }
    const core = active.filter((m) => m.scope === "core");
    const general = active.filter((m) => m.scope === "general");
    const coreTokens = Math.ceil(core.reduce((n, m) => n + m.text.length, 0) / 4);
    return {
      budget: 2000,
      coreTokens,
      overBudget: coreTokens > 2000,
      items: this.memory,
      index: {
        attached: [...groups.values()] as MemoryView["index"]["attached"],
        general: general.length ? ["general facts"] : [],
        generalCount: general.length,
        writtenAt: null,
      },
      keys: this.memoryKeys,
      lastTidy: null,
    };
  }

  /** The memory endpoints of the fake: add, edit, retire, delete and the tidy-up. */
  private memoryApi(method: string, path: string, body: NewMemoryBody): Response {
    const id = /^\/api\/steward\/memory\/(\d+)/.exec(path)?.[1];
    const find = id ? this.memory.find((m) => m.id === Number(id)) : undefined;
    if (method === "GET" && path === "/api/steward/memory") return this.json(this.memoryView());
    if (method === "POST" && path === "/api/steward/memory") {
      const m: MemoryEntry = {
        id: Math.max(0, ...this.memory.map((x) => x.id)) + 1,
        scope: body.scope,
        attachedKind: body.attachedKind ?? null,
        attachedKey: body.attachedKey ?? null,
        text: body.text.trim(),
        source: "owner",
        createdAt: "2026-11-25T14:30:00.000Z",
        updatedAt: "2026-11-25T14:30:00.000Z",
        retiredAt: null,
      };
      this.memory.push(m);
      return this.json(m, 201);
    }
    if (method === "POST" && path === "/api/steward/memory/tidy-up") {
      return this.json({ wake: { id: 1 }, memory: this.memoryView() });
    }
    if (!find) return this.json({ error: { code: "not-found", message: "no such item" } }, 404);
    if (method === "PUT") {
      find.text = body.text.trim();
      find.source = "owner";
      return this.json(find);
    }
    if (method === "POST" && path.endsWith("/retire")) {
      find.retiredAt = "2026-11-25T14:31:00.000Z";
      return this.json(find);
    }
    if (method === "POST" && path.endsWith("/restore")) {
      find.retiredAt = null;
      return this.json(find);
    }
    if (method === "DELETE") {
      this.memory = this.memory.filter((m) => m !== find);
      return this.json({ ok: true });
    }
    return this.json({ error: { code: "not-found", message: "no route" } }, 404);
  }

  private async handle(input: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const [path = "", query] = input.split("?");
    this.calls.push({ method, path: query ? `${path}?${query}` : path, body });
    const entriesM = /^\/api\/topics\/([^/]+)\/entries$/.exec(path);
    const topicM = /^\/api\/topics\/([^/]+)$/.exec(path);
    const actionM = /^\/api\/topics\/([^/]+)\/(open|mute|stale|stale-prompt\/dismiss)$/.exec(path);
    const confirmM = /^\/api\/monitors\/(\d+)\/confirm$/.exec(path);
    const tasksM = /^\/api\/topics\/([^/]+)\/tasks$/.exec(path);
    const taskStatusM = /^\/api\/topics\/([^/]+)\/tasks\/([^/]+)\/status$/.exec(path);
    const docM = /^\/api\/topics\/([^/]+)\/docs\/(\d+)$/.exec(path);
    const artM = /^\/api\/topics\/([^/]+)\/artifacts\/(\d+)$/.exec(path);
    const entryM = /^\/api\/entries\/(\d+)$/.exec(path);

    if (method === "GET" && path === "/api/topics") {
      return this.json(
        this.topics.map((t) => {
          const own = this.tasks.get(t.slug);
          return own
            ? {
                ...t,
                taskCounts: {
                  total: own.length,
                  done: own.filter((x) => x.status === "done").length,
                },
              }
            : t;
        }),
      );
    }
    if (docM && method === "GET") {
      const sub = new URLSearchParams(query ?? "").get("path");
      const key = `${decodeURIComponent(docM[1] ?? "")}:${docM[2]}${sub ? `:${sub}` : ""}`;
      const doc = this.docs.get(key);
      return doc
        ? this.json(doc)
        : this.json({ error: { code: "not-found", message: "no such file" } }, 404);
    }
    if (artM && method === "GET") {
      const art = this.artifacts.get(`${decodeURIComponent(artM[1] ?? "")}:${artM[2]}`);
      return art
        ? this.json(art)
        : this.json({ error: { code: "not-found", message: "no such file" } }, 404);
    }
    if (method === "GET" && path === "/api/workspaces") return this.json(this.workspaces);
    if (method === "GET" && path === "/api/t3/projects") {
      return this.t3Projects
        ? this.json(this.t3Projects)
        : this.json({ error: { code: "unavailable", message: "T3 cannot be read: gone" } }, 503);
    }
    if (method === "GET" && path === "/api/compose/options") return this.json(this.composeOptions);
    if (method === "POST" && path === "/api/topics") {
      if (this.createTopicFails) {
        return this.json({ error: { code: "conflict", message: "slug taken" } }, 409);
      }
      const slug = String(body.slug ?? body.title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
      this.desk.push(deskTopic({ slug, title: body.title }));
      return this.json({ slug, title: body.title }, 201);
    }
    const newThreadM = /^\/api\/topics\/([^/]+)\/threads\/new$/.exec(path);
    if (newThreadM && method === "POST") {
      if (this.newThreadFails > 0) {
        this.newThreadFails--;
        return this.json(
          { error: { code: "provider", message: "t3 thread start exited with 1" } },
          502,
        );
      }
      return this.json({ id: 900 }, 201);
    }
    if (method === "GET" && path === "/api/desk") return this.json({ topics: this.desk });
    const reqM = /^\/api\/threads\/(\d+)\/requests$/.exec(path);
    if (reqM && method === "GET") {
      return this.json({ requests: this.requests.get(Number(reqM[1])) ?? [] });
    }
    const ansM = /^\/api\/threads\/(\d+)\/requests\/([^/]+)\/answer$/.exec(path);
    const decM = /^\/api\/approvals\/([^/]+)$/.exec(path);
    if ((ansM || decM) && method === "POST") {
      if (this.answerFails > 0) {
        this.answerFails--;
        return this.json({ error: { code: "provider", message: "T3: that request is gone" } }, 502);
      }
      return this.json({ ok: true });
    }
    const replyM = /^\/api\/threads\/(\d+)\/reply$/.exec(path);
    if (replyM && method === "GET") {
      const r = this.replies.get(Number(replyM[1]));
      return r
        ? this.json(r)
        : this.json({ error: { code: "not-found", message: "no reply" } }, 404);
    }
    const deskM = /^\/api\/topics\/([^/]+)\/(favorite|desk-hidden|steward-enabled)$/.exec(path);
    if (deskM && method === "POST") {
      const t = this.desk.find((x) => x.slug === decodeURIComponent(deskM[1] ?? ""));
      if (!t) return this.json({ error: { code: "not-found", message: "nope" } }, 404);
      if (deskM[2] === "favorite") t.favorite = body.on;
      else if (deskM[2] === "steward-enabled") t.stewardEnabled = body.enabled;
      else t.deskHidden = body.hidden;
      return this.json({ slug: t.slug });
    }
    if (method === "PUT" && path === "/api/desk/order") {
      const slugs: string[] = body.slugs;
      const rest = this.desk
        .filter((t) => !slugs.includes(t.slug) && t.deskOrder !== null)
        .sort((a, b) => (a.deskOrder ?? 0) - (b.deskOrder ?? 0))
        .map((t) => t.slug);
      [...slugs, ...rest].forEach((slug, i) => {
        const t = this.desk.find((x) => x.slug === slug);
        if (t) t.deskOrder = i;
      });
      return this.json({ slugs });
    }
    if (method === "GET" && path === "/api/notifications") {
      return this.json({ notifications: this.notifications, hiddenCount: 0 });
    }
    if (method === "GET" && path === "/api/steward") {
      return this.json({ ...this.steward, enabled: this.settings.steward.enabled });
    }
    if (path.startsWith("/api/steward/memory")) return this.memoryApi(method, path, body);
    if (method === "GET" && path === "/api/steward/count") {
      const v = this.steward;
      return this.json({ count: v.needs.length + v.questions.length + v.ready.length });
    }
    const stFixM = /^\/api\/steward\/items\/(\d+)\/(diff|adopt|discard)$/.exec(path);
    if (stFixM) {
      const id = Number(stFixM[1]);
      if (stFixM[2] === "diff") return this.json(this.fixDiff);
      if (stFixM[2] === "adopt" && this.adoptRefusal) {
        return this.json({ error: { code: "conflict", message: this.adoptRefusal } }, 409);
      }
      for (const t of this.desk) if (t.steward?.fix?.itemId === id) t.steward = null;
      this.steward.ready = this.steward.ready.filter((i) => i.id !== id);
      for (const i of [...this.steward.needs, ...this.steward.info]) {
        if (i.prepared?.itemId === id) i.prepared = null;
      }
      return this.json({ id });
    }
    const stItemM = /^\/api\/steward\/items\/(\d+)\/(answer|dismiss)$/.exec(path);
    if (stItemM && method === "POST") {
      const id = Number(stItemM[1]);
      for (const t of this.desk) if (t.steward?.itemId === id) t.steward = null;
      for (const k of ["needs", "questions", "ready", "info"] as const) {
        this.steward[k] = this.steward[k].filter((i) => i.id !== id);
      }
      return this.json({ id });
    }
    const stUndoM = /^\/api\/steward\/actions\/(\d+)\/undo$/.exec(path);
    if (stUndoM && method === "POST") {
      this.steward.info = this.steward.info.filter((i) => i.action?.id !== Number(stUndoM[1]));
      return this.json({ id: Number(stUndoM[1]) });
    }
    if (method === "GET" && path === "/api/settings") return this.json(this.settings);
    if (method === "PUT" && path === "/api/settings") {
      this.settings = { ...this.settings, ...body };
      return this.json(this.settings);
    }
    if (method === "GET" && path === "/api/health") {
      return this.json({
        server: { startedAt: T0, version: "0.0.0", dbPath: "/x", lastBackupAt: null },
        claudeCode: { lastEventAt: null },
        t3: {
          state: "ok",
          lastReadAt: T0,
          serverVersion: "0.1.11-nightly.20261118.4890",
          migration: 98,
          pinned: { serverVersion: "0.1.11-nightly.20261118.4890", migration: 98 },
          detail: null,
        },
      });
    }
    if (method === "GET" && path === "/api/tickets") return this.json(this.tickets);
    if (method === "GET" && path === "/api/epics") return this.json(this.epics);
    if (tasksM && method === "GET") {
      return this.json(this.tasks.get(decodeURIComponent(tasksM[1] ?? "")) ?? []);
    }
    if (taskStatusM && method === "POST") {
      const list = this.tasks.get(decodeURIComponent(taskStatusM[1] ?? "")) ?? [];
      const found = list.find((t) => t.key === decodeURIComponent(taskStatusM[2] ?? ""));
      if (!found) return this.json({ error: { code: "not-found", message: "nope" } }, 404);
      found.status = body.status;
      linkTasks(list);
      return this.json(found);
    }
    if (entriesM && method === "GET") {
      return this.json(this.entries.get(decodeURIComponent(entriesM[1] ?? "")) ?? []);
    }
    if (topicM && method === "GET") {
      const d = this.detail(decodeURIComponent(topicM[1] ?? ""));
      return d ? this.json(d) : this.json({ error: { code: "not-found", message: "nope" } }, 404);
    }
    if (actionM) {
      const slug = decodeURIComponent(actionM[1] ?? "");
      const t = this.find(slug);
      if (!t) return this.json({ error: { code: "not-found", message: "nope" } }, 404);
      if (actionM[2] === "open") {
        t.highlighted = false;
        this.notifications = this.notifications.filter((n) => n.topicSlug !== slug);
      }
      if (actionM[2] === "mute") t.muted = body.muted;
      if (actionM[2] === "stale") {
        t.status = "stale";
        t.stalePrompt = false;
      }
      if (actionM[2] === "stale-prompt/dismiss") t.stalePrompt = false;
      return this.json(this.detail(slug) ?? {});
    }
    if (confirmM) {
      for (const d of this.details.values()) {
        for (const mt of d.monitorTargets ?? [])
          if (mt.id === Number(confirmM[1])) mt.state = "confirmed";
      }
      return this.json({ ok: true });
    }
    if (entryM && method === "DELETE") {
      for (const [k, list] of this.entries) {
        this.entries.set(
          k,
          list.filter((e) => e.id !== Number(entryM[1])),
        );
      }
      return this.json({ ok: true });
    }
    return this.json({ error: { code: "not-found", message: `unmocked ${method} ${path}` } }, 404);
  }
}
