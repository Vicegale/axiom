import type {
  EntryAuthor,
  EntryKind,
  LinkKind,
  MonitorState,
  NotificationKind,
  Provider,
  RefType,
  TaskStatus,
  TopicStatus,
  View,
  WorkItemStatus,
} from "./constants.js";

export type TopicRef = number | string;

export interface Ref {
  type: RefType;
  value: string;
}

export interface Topic {
  id: number;
  slug: string;
  title: string;
  status: TopicStatus | null;
  statusNote: string | null;
  goal: string | null;
  muted: boolean;
  stalePromptDismissed: boolean;
  createdAt: string;
  lastWorkedAt: string;
  /** Desk arrangement (02): favourite, hidden from the Desk, the owner's drag position. */
  favorite: boolean;
  deskHidden: boolean;
  deskOrder: number | null;
}

export interface WorkItem {
  id: number;
  slug: string;
  title: string;
  status: WorkItemStatus;
  jiraKey: string | null;
  jiraUrl: string | null;
  jiraStatus: string | null;
  jiraSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export type Ticket = WorkItem;
export type Epic = WorkItem;

export interface Thread {
  id: number;
  topicId: number;
  provider: Provider;
  providerThreadId: string;
  environmentId: string | null;
  title: string | null;
  status: TopicStatus;
  declaredStatus: TopicStatus | null;
  waitingOnOwner: boolean;
  /** The task this thread works on, if it named one. */
  taskId: number | null;
  statusChangedAt: string;
  statusChangedSeq: number;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  /** The latest reply of the agent (Desk). Can be large; API listings leave it out. */
  lastReply: string | null;
  lastReplyAt: string | null;
  /** The ephemeral summary of that reply, and the reply time it was made from. */
  summaryNow: string | null;
  summaryNext: string | null;
  summaryAt: string | null;
  summaryReplyAt: string | null;
  summaryError: string | null;
  /** The newest step the agent took (ephemeral, one line), and when. */
  activityText: string | null;
  activityAt: string | null;
  /** What the thread runs on (ephemeral, latest only): model id, effort, and context window use. */
  model: string | null;
  effort: string | null;
  contextUsed: number | null;
  /** The context window size; null when unknown. */
  contextMax: number | null;
  /** When any of these last changed. */
  runtimeAt: string | null;
}

/** A change to a thread's model, effort or context: absent keys stay as they are. */
export interface RuntimePatch {
  model?: string | null;
  effort?: string | null;
  contextUsed?: number | null;
  contextMax?: number | null;
}

/** Where a subagent stands: running, or finished (done, failed, or cancelled before it finished). */
export type SubagentStatus = "running" | "done" | "failed" | "cancelled";

/**
 * A subagent of the thread's current turn (ephemeral: the rows go when the next turn starts).
 * `key` is the provider's own id; `parentKey` is the subagent that started it, null when the
 * thread did.
 */
export interface Subagent {
  id: number;
  threadId: number;
  key: string;
  title: string | null;
  agentType: string | null;
  model: string | null;
  /** The latest step it reported (T3 only). */
  progress: string | null;
  status: SubagentStatus;
  startedAt: string;
  /** When it finished; null while it runs. */
  endedAt: string | null;
  parentKey: string | null;
}

/** What a provider says of a subagent (T3 sync). */
export interface SubagentSnapshot {
  key: string;
  title: string | null;
  agentType: string | null;
  model: string | null;
  progress: string | null;
  status: SubagentStatus;
  startedAt: string;
  endedAt: string | null;
  parentKey: string | null;
}

export interface Link {
  id: number;
  topicId: number;
  kind: LinkKind;
  target: string;
  label: string | null;
  description: string | null;
  createdAt: string;
  createdByThreadId: number | null;
}

export interface MonitorTarget {
  id: number;
  topicId: number;
  linkId: number | null;
  kind: string;
  state: MonitorState;
  createdAt: string;
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
  refs: Ref[];
  correctsEntryId: number | null;
}

export interface Notification {
  id: number;
  topicId: number;
  topicSlug: string;
  threadId: number | null;
  kind: NotificationKind;
  body: string | null;
  createdAt: string;
  dismissedAt: string | null;
}

export interface Task {
  id: number;
  topicId: number;
  key: string;
  title: string;
  doneWhen: string | null;
  status: TaskStatus;
  position: number;
  specLinkId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A task with its dependency picture. `waiting` = some dependency is not done. */
export interface TaskDetail extends Task {
  dependsOn: string[];
  dependents: string[];
  waiting: boolean;
}

export interface TaskCounts {
  total: number;
  done: number;
}

export interface TopicSummary extends Topic {
  taskCounts: TaskCounts;
  views: View[];
  highlighted: boolean;
  openThreadStatuses: TopicStatus[];
}

export interface TopicDetail extends TopicSummary {
  tickets: Ticket[];
  epics: Epic[];
  threads: Thread[];
  links: Link[];
  monitorTargets: MonitorTarget[];
}

/** A permission the agent asked for (Claude Code `PermissionRequest` hook); pending until decided. */
export interface Approval {
  id: number;
  threadId: number;
  toolName: string;
  /** One line describing the tool call; never the full input. */
  inputSummary: string;
  createdAt: string;
  decidedAt: string | null;
  /** `expired`: the hook gave up and the terminal prompt took over. */
  decision: "allow" | "deny" | "expired" | null;
  message: string | null;
  hookPid: number | null;
}
