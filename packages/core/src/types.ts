import type {
  EntryAuthor,
  EntryKind,
  LinkKind,
  MonitorState,
  NotificationKind,
  Provider,
  RefType,
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
  statusChangedAt: string;
  statusChangedSeq: number;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export interface Link {
  id: number;
  topicId: number;
  kind: LinkKind;
  target: string;
  label: string | null;
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

export interface TopicSummary extends Topic {
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
