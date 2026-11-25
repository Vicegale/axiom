import { vi } from "vitest";
import type {
  AxiomNotification,
  DocData,
  Entry,
  EpicItem,
  Settings,
  TaskItem,
  Thread,
  TicketItem,
  TopicDetailData,
  TopicListItem,
} from "../api";

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
  settings: Settings = { mutedKinds: [], staleAfterDays: 14, layout: "inbox", theme: "dark" };
  calls: Call[] = [];
  /** Documents by `<slug>:<linkId>` or `<slug>:<linkId>:<?path>`; a missing key is a 404. */
  docs = new Map<string, DocData>();

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
    if (method === "GET" && path === "/api/notifications") {
      return this.json({ notifications: this.notifications, hiddenCount: 0 });
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
