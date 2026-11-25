import type { EntryAuthor, EntryKind, NotificationKind, Provider, TopicStatus } from "./lib/domain";

// ---- shapes returned by the server (packages/server/src/app.ts) ----------------------------

export interface Parent {
  kind: "ticket" | "epic";
  slug: string;
  title: string;
  status: string;
  jiraKey: string | null;
  jiraStatus: string | null;
  locked: boolean;
}

export interface Attention {
  reason: "agent asked" | "error";
  text: string;
  at: string;
}

export interface ListThread {
  id: number;
  provider: Provider;
  title: string | null;
  status: TopicStatus;
  open: boolean;
}

export interface TopicListItem {
  id: number;
  slug: string;
  title: string;
  status: TopicStatus | null;
  statusNote: string | null;
  goal: string | null;
  muted: boolean;
  views: string[];
  highlighted: boolean;
  stalePrompt: boolean;
  attention: Attention | null;
  parents: Parent[];
  threads: ListThread[];
  createdAt: string;
  lastWorkedAt: string;
}

export interface Thread {
  id: number;
  topicId: number;
  provider: Provider;
  providerThreadId: string;
  environmentId: string | null;
  title: string | null;
  status: TopicStatus;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export interface LinkItem {
  id: number;
  kind: string;
  target: string;
  label: string | null;
}

export interface MonitorTarget {
  id: number;
  linkId: number | null;
  kind: string;
  state: "suggested" | "confirmed";
}

export interface TopicDetailData {
  id: number;
  slug: string;
  title: string;
  status: TopicStatus | null;
  statusNote: string | null;
  goal: string | null;
  muted: boolean;
  views: string[];
  highlighted: boolean;
  stalePrompt: boolean;
  attention: Attention | null;
  createdAt: string;
  lastWorkedAt: string;
  openThreadStatuses: TopicStatus[];
  parents: Parent[];
  threads: Thread[];
  links: LinkItem[];
  monitorTargets: MonitorTarget[];
}

export interface Entry {
  id: number;
  topicId: number;
  at: string;
  author: EntryAuthor;
  threadId: number | null;
  kind: EntryKind;
  body: string | null;
  data: unknown;
  refs: { type: string; value: string }[];
}

export interface AxiomNotification {
  id: number;
  topicId: number;
  topicSlug: string;
  kind: NotificationKind;
  body: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  notifications: AxiomNotification[];
  hiddenCount: number;
}

export interface Settings {
  mutedKinds: NotificationKind[];
  staleAfterDays: number;
  layout: "inbox" | "board" | "console";
  theme: "dark" | "light" | "system";
}

export interface Health {
  server: { startedAt: string; version: string; dbPath: string; lastBackupAt: string | null };
  claudeCode: { lastEventAt: string | null };
  t3: { state: string };
}

export interface TicketItem {
  slug: string;
  title: string;
  epics: { slug: string; title: string }[];
}

// ---- fetch layer ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${method} ${path} failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j.error?.message) message = j.error.message;
    } catch {}
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  topics: () => request<TopicListItem[]>("GET", "/api/topics?all=1"),
  topic: (slug: string) => request<TopicDetailData>("GET", `/api/topics/${enc(slug)}`),
  entries: (slug: string) => request<Entry[]>("GET", `/api/topics/${enc(slug)}/entries?limit=500`),
  open: (slug: string) => request<{ ok: true }>("POST", `/api/topics/${enc(slug)}/open`),
  mute: (slug: string, muted: boolean) =>
    request<TopicDetailData>("POST", `/api/topics/${enc(slug)}/mute`, { muted }),
  markStale: (slug: string) => request<TopicDetailData>("POST", `/api/topics/${enc(slug)}/stale`),
  dismissStalePrompt: (slug: string) =>
    request<TopicDetailData>("POST", `/api/topics/${enc(slug)}/stale-prompt/dismiss`),
  confirmMonitor: (id: number) => request<MonitorTarget>("POST", `/api/monitors/${id}/confirm`),
  deleteEntry: (id: number) => request<{ ok: true }>("DELETE", `/api/entries/${id}`),
  tickets: () => request<TicketItem[]>("GET", "/api/tickets"),
  notifications: () => request<NotificationsResponse>("GET", "/api/notifications"),
  settings: () => request<Settings>("GET", "/api/settings"),
  putSettings: (patch: Partial<Settings>) => request<Settings>("PUT", "/api/settings", patch),
  health: () => request<Health>("GET", "/api/health"),
};
