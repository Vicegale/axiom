import { vi } from "vitest";
import type {
  AxiomNotification,
  Entry,
  Settings,
  Thread,
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
    views: ["piles"],
    highlighted: false,
    stalePrompt: false,
    parents: [],
    threads: [],
    createdAt: T0,
    lastWorkedAt: T0,
    ...over,
  };
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
  notifications: AxiomNotification[] = [];
  settings: Settings = { mutedKinds: [], staleAfterDays: 14, layout: "inbox", theme: "dark" };
  calls: Call[] = [];

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
    const entryM = /^\/api\/entries\/(\d+)$/.exec(path);

    if (method === "GET" && path === "/api/topics") return this.json(this.topics);
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
        t3: { state: "not-configured" },
      });
    }
    if (method === "GET" && path === "/api/tickets") return this.json([]);
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
