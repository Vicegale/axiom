import type {
  EntryAuthor,
  EntryKind,
  NotificationKind,
  Provider,
  TaskStatus,
  TopicStatus,
} from "./lib/domain";

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

export interface TaskCounts {
  total: number;
  done: number;
}

/** A task as GET /api/topics/:slug/tasks returns it. */
export interface TaskItem {
  id: number;
  key: string;
  title: string;
  doneWhen: string | null;
  status: TaskStatus;
  position: number;
  specLinkId: number | null;
  dependsOn: string[];
  dependents: string[];
  /** Some dependency is not done. */
  waiting: boolean;
}

export interface TopicListItem {
  id: number;
  slug: string;
  title: string;
  status: TopicStatus | null;
  statusNote: string | null;
  goal: string | null;
  muted: boolean;
  taskCounts: TaskCounts;
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
  /** How to open the thread: T3's web UI, or the command that resumes a Claude Code session. */
  open?: { kind: "url"; url: string } | { kind: "command"; command: string } | null;
}

export interface ThreadRuntime {
  model: string | null;
  effort: string | null;
  contextUsed: number | null;
  /** The context window size; null when unknown. */
  contextMax: number | null;
  at: string | null;
}

/** A thread as GET /api/desk returns it (the full reply is fetched on its own). */
export interface DeskThread {
  id: number;
  provider: Provider;
  providerThreadId: string;
  title: string | null;
  status: TopicStatus;
  open: boolean;
  startedAt: string;
  endedAt: string | null;
  lastReplyAt: string | null;
  /** The ephemeral Haiku summary of the latest reply; `next` is "Nothing" when the owner has none. */
  summary: { now: string; next: string; at: string | null } | null;
  summaryError: string | null;
  /** The newest step the agent took ("$ npm test", "Reading app.ts"), kept after it stops. */
  activity: { text: string; at: string } | null;
  /** What it runs on: model, effort and context use (the latest only); null until known. */
  runtime: ThreadRuntime | null;
  hasReply: boolean;
  /** Questions and permission requests waiting on the owner; the card fetches them when above 0. */
  pendingRequests: number;
  /** A newer reply is being summarised (the shown summary, if any, is the previous one). */
  summaryPending?: boolean;
}

/** A topic card as GET /api/desk returns it. */
export interface DeskTopic {
  slug: string;
  title: string;
  status: TopicStatus | null;
  statusNote: string | null;
  favorite: boolean;
  deskHidden: boolean;
  deskOrder: number | null;
  taskCounts: TaskCounts;
  linkCount: number;
  /** The topic's artifact links, for the card's Artifacts menu. */
  artifacts: LinkItem[];
  /** The topic's repository link target, if it has one. */
  repository?: string | null;
  lastWorkedAt: string;
  highlighted: boolean;
  attention: Attention | null;
  threads: DeskThread[];
}

/** One question of a T3 `user_input` request. */
export interface RequestQuestion {
  /** The key of its answer. */
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/** Something an agent waits on the owner for: a question, or a permission request. */
export interface PendingRequest {
  id: string;
  provider: Provider;
  kind: "question" | "approval";
  text: string;
  questions: RequestQuestion[];
  /** Claude Code approvals: the tool and one line of its input. */
  tool: string | null;
  summary: string | null;
  requestKind: string | null;
  createdAt: string | null;
  /** The owner can allow or deny it here (Claude Code); T3 approvals are answered in T3. */
  decidable: boolean;
  /** `t3code://` link to the thread, for approvals T3 must answer. */
  openUrl: string | null;
}

export type RequestAnswers = Record<string, string | string[]>;

export interface ThreadReply {
  text: string;
  at: string | null;
}

export interface LinkItem {
  id: number;
  kind: string;
  target: string;
  label: string | null;
  description?: string | null;
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

export interface T3Health {
  state: "ok" | "untested-version" | "unavailable";
  lastReadAt: string | null;
  serverVersion: string | null;
  migration: number | null;
  pinned: { serverVersion: string; migration: number };
  detail: string | null;
}

export interface Health {
  server: {
    startedAt: string;
    version: string;
    dbPath: string;
    lastBackupAt: string | null;
    /** The web build the server saw at start; differs from the page's after an update. */
    webBuildId?: string | null;
  };
  claudeCode: { lastEventAt: string | null };
  t3: T3Health;
}

/** A T3 thread offered by the "Attach T3 thread" picker. */
export interface T3Thread {
  id: string;
  title: string;
  environmentId: string | null;
  status: string;
  updatedAt: string;
}

/** An epic or a ticket as /api/epics and /api/tickets return it. */
export interface WorkItem {
  slug: string;
  title: string;
  status: string;
  jiraKey: string | null;
  jiraStatus: string | null;
  /** True when Jira owns the status. */
  locked: boolean;
  topicCount: number;
}

export interface TicketItem extends WorkItem {
  epics: { slug: string; title: string }[];
}

export type EpicItem = WorkItem & { ticketCount: number };

// ---- fetch layer ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** A 409 on a Claude Code reply: the command that resumes the open session in a terminal. */
    readonly resumeCommand?: string,
  ) {
    super(message);
  }
}

/** A Markdown document as GET /api/topics/:slug/docs/:linkId returns it. */
export interface DocData {
  linkId: number;
  path: string;
  relPath: string;
  root: string;
  baseDir: string;
  title: string;
  markdown: string;
  mtime: number;
  /** Set for a thread's reply: its images resolve through the thread, not the topic's files. */
  replyThreadId?: number;
}

/** Artifact metadata as GET /api/topics/:slug/artifacts/:linkId returns it. */
export interface ArtifactData {
  linkId: number;
  kind: "html" | "image";
  title: string;
  path: string;
  relPath: string;
  mtime: number;
  size: number;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ComposeOptions {
  source: string;
  providers: Record<Provider, { models: string[]; efforts: Effort[] }>;
}

export interface SendBody {
  text: string;
  model?: string;
  effort?: Effort;
}

export interface NewThreadBody extends SendBody {
  provider: Provider;
  providerInstance?: string;
  project?: string;
  cwd?: string;
}

export interface Workspace {
  path: string;
  label: string;
  source: "axiom" | "projects";
}

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  hasDefaultModel: boolean;
  pinned: boolean;
}

export interface NewTopicBody {
  slug?: string;
  title: string;
  goal?: string;
  epic?: string;
  ticket?: string;
  repository?: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${method} ${path} failed (${res.status})`;
    let resumeCommand: string | undefined;
    try {
      const j = (await res.json()) as { error?: { message?: string; resumeCommand?: string } };
      if (j.error?.message) message = j.error.message;
      resumeCommand = j.error?.resumeCommand;
    } catch {}
    throw new ApiError(res.status, message, resumeCommand);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  topics: () => request<TopicListItem[]>("GET", "/api/topics?all=1"),
  topic: (slug: string) => request<TopicDetailData>("GET", `/api/topics/${enc(slug)}`),
  tasks: (slug: string) => request<TaskItem[]>("GET", `/api/topics/${enc(slug)}/tasks`),
  setTaskStatus: (slug: string, key: string, status: TaskStatus) =>
    request<TaskItem>("POST", `/api/topics/${enc(slug)}/tasks/${enc(key)}/status`, { status }),
  entries: (slug: string) => request<Entry[]>("GET", `/api/topics/${enc(slug)}/entries?limit=500`),
  doc: (slug: string, linkId: number, path?: string) =>
    request<DocData>(
      "GET",
      `/api/topics/${enc(slug)}/docs/${linkId}${path ? `?path=${enc(path)}` : ""}`,
    ),
  artifact: (slug: string, linkId: number) =>
    request<ArtifactData>("GET", `/api/topics/${enc(slug)}/artifacts/${linkId}`),
  /** The raw file of an HTML or image artifact; `v` busts the cache when the file changes. */
  artifactRawUrl: (slug: string, linkId: number, v?: number) =>
    `/api/topics/${enc(slug)}/artifacts/${linkId}/raw${v === undefined ? "" : `?v=${v}`}`,
  open: (slug: string) => request<{ ok: true }>("POST", `/api/topics/${enc(slug)}/open`),
  mute: (slug: string, muted: boolean) =>
    request<TopicDetailData>("POST", `/api/topics/${enc(slug)}/mute`, { muted }),
  markStale: (slug: string) => request<TopicDetailData>("POST", `/api/topics/${enc(slug)}/stale`),
  dismissStalePrompt: (slug: string) =>
    request<TopicDetailData>("POST", `/api/topics/${enc(slug)}/stale-prompt/dismiss`),
  confirmMonitor: (id: number) => request<MonitorTarget>("POST", `/api/monitors/${id}/confirm`),
  deleteEntry: (id: number) => request<{ ok: true }>("DELETE", `/api/entries/${id}`),
  tickets: () => request<TicketItem[]>("GET", "/api/tickets"),
  epics: () => request<EpicItem[]>("GET", "/api/epics"),
  notifications: () => request<NotificationsResponse>("GET", "/api/notifications"),
  settings: () => request<Settings>("GET", "/api/settings"),
  putSettings: (patch: Partial<Settings>) => request<Settings>("PUT", "/api/settings", patch),
  t3Threads: () => request<T3Thread[]>("GET", "/api/t3/threads?unattached=1"),
  attachThread: (
    slug: string,
    body: { provider: Provider; providerThreadId: string; environmentId?: string; title?: string },
  ) => request<Thread>("POST", `/api/topics/${enc(slug)}/threads`, body),
  desk: () => request<{ topics: DeskTopic[] }>("GET", "/api/desk"),
  threadReply: (id: number) => request<ThreadReply>("GET", `/api/threads/${id}/reply`),
  setFavorite: (slug: string, on: boolean) =>
    request<{ slug: string; favorite: boolean }>("POST", `/api/topics/${enc(slug)}/favorite`, {
      on,
    }),
  setDeskHidden: (slug: string, hidden: boolean) =>
    request<{ slug: string; deskHidden: boolean }>("POST", `/api/topics/${enc(slug)}/desk-hidden`, {
      hidden,
    }),
  setDeskOrder: (slugs: string[]) =>
    request<{ slugs: string[] }>("PUT", "/api/desk/order", { slugs }),
  threadRequests: (id: number) =>
    request<{ requests: PendingRequest[] }>("GET", `/api/threads/${id}/requests`),
  answerRequest: (threadId: number, requestId: string, answers: RequestAnswers) =>
    request<{ ok: true }>("POST", `/api/threads/${threadId}/requests/${enc(requestId)}/answer`, {
      answers,
    }),
  decideApproval: (id: string, decision: "allow" | "deny", message?: string) =>
    request<unknown>("POST", `/api/approvals/${enc(id)}`, {
      decision,
      ...(message ? { message } : {}),
    }),
  health: () => request<Health>("GET", "/api/health"),
  composeOptions: () => request<ComposeOptions>("GET", "/api/compose/options"),
  sendToThread: (id: number, body: SendBody) =>
    request<{ ok: true }>("POST", `/api/threads/${id}/send`, body),
  createTopic: (body: NewTopicBody) =>
    request<{ slug: string; title: string }>("POST", "/api/topics", body),
  t3Projects: () => request<T3Project[]>("GET", "/api/t3/projects"),
  workspaces: () => request<Workspace[]>("GET", "/api/workspaces"),
  newThread: (slug: string, body: NewThreadBody) =>
    request<Thread>("POST", `/api/topics/${enc(slug)}/threads/new`, body),
};
