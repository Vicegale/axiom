export const TOPIC_STATUSES = [
  "idle",
  "wip",
  "hitl",
  "monitoring",
  "blocked",
  "review",
  "done",
  "stale",
  "error",
] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export const WORK_ITEM_STATUSES = ["to do", "wip", "done"] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const TASK_STATUSES = ["to do", "wip", "blocked", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const VIEWS = ["attention", "ongoing", "monitoring", "piles", "closed"] as const;
export type View = (typeof VIEWS)[number];

export const PROVIDERS = ["claude-code", "t3"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const LINK_KINDS = [
  "project",
  "repository",
  "branch",
  "worktree",
  "pr",
  "spec",
  "artifact",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const MONITOR_STATES = ["suggested", "confirmed"] as const;
export type MonitorState = (typeof MONITOR_STATES)[number];

export const NOTIFICATION_KINDS = [
  "agent stopped",
  "agent asked",
  "monitor problem",
  "jira changed",
  "pr review",
  "stale prompt",
  "error",
  "steward urgent",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Entry kinds that agents or the owner may write (08). */
export const SHARED_ENTRY_KINDS = [
  "note",
  "decision",
  "finding",
  "verification",
  "next steps",
] as const;
/** Entry kinds only the owner may write. */
export const OWNER_ENTRY_KINDS = ["owner input", "authorization"] as const;
/** Entry kinds only Axiom writes. */
export const AXIOM_ENTRY_KINDS = [
  "status change",
  "topic created",
  "thread event",
  "git event",
  "deploy event",
] as const;
export const ENTRY_KINDS = [
  ...SHARED_ENTRY_KINDS,
  ...OWNER_ENTRY_KINDS,
  ...AXIOM_ENTRY_KINDS,
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const REF_TYPES = [
  "pr",
  "commit",
  "branch",
  "worktree",
  "thread",
  "artifact",
  "spec",
  "deploy",
  "external-ticket",
  "topic",
] as const;
export type RefType = (typeof REF_TYPES)[number];

export const ENTRY_AUTHORS = ["owner", "agent", "axiom", "steward"] as const;
export type EntryAuthor = (typeof ENTRY_AUTHORS)[number];

export const DEFAULT_STALE_AFTER_DAYS = 14;

/** How long a `PermissionRequest` hook waits for the owner before the terminal prompt takes over. */
/** How long a finished subagent stays in its thread's tree on the Desk (D12, owner 2026-11-25). */
export const SUBAGENT_KEEP_MS = 30 * 60_000;

export const DEFAULT_APPROVAL_TIMEOUT_SEC = 600;
/** The hook timeout written into Claude Code's settings: the longest wait plus a margin. */
export const APPROVAL_HOOK_TIMEOUT_SEC = 620;

/** The T3 build Axiom is tested against (ADR 0005): server version and latest migration id. */
export const DEFAULT_T3_PIN = {
  serverVersion: "0.1.11-nightly.20261118.4890",
  migration: 98,
} as const;

export type Actor =
  | { kind: "owner" }
  | { kind: "agent"; threadId?: number }
  | { kind: "axiom" }
  | { kind: "steward" };

// ---------------------------------------------------------------------------
// Steward (spec 03, 05)
// ---------------------------------------------------------------------------

export const STEWARD_STAGES = ["gather", "decide", "promoted", "tidy-up", "chat"] as const;
export type StewardStage = (typeof STEWARD_STAGES)[number];

export const STEWARD_WAKE_TRIGGERS = ["timer", "event", "tidy-up", "owner"] as const;
export type StewardWakeTrigger = (typeof STEWARD_WAKE_TRIGGERS)[number];

/** Status of a wake or of one run. `cut short`: a cap or a time limit. */
export const STEWARD_STATUSES = ["running", "done", "failed", "cut short"] as const;
export type StewardStatus = (typeof STEWARD_STATUSES)[number];

export const STEWARD_ITEM_KINDS = ["finding", "question", "suggestion"] as const;
export type StewardItemKind = (typeof STEWARD_ITEM_KINDS)[number];

export const STEWARD_LEVELS = ["urgent", "attention", "info"] as const;
export type StewardLevel = (typeof STEWARD_LEVELS)[number];

export const STEWARD_ITEM_STATES = [
  "open",
  "answered",
  "dismissed",
  "adopted",
  "discarded",
  "undone",
] as const;
export type StewardItemState = (typeof STEWARD_ITEM_STATES)[number];

export const STEWARD_SUGGESTION_KINDS = ["fix", "rebase copy"] as const;
export type StewardSuggestionKind = (typeof STEWARD_SUGGESTION_KINDS)[number];

export const STEWARD_COMPLEXITIES = ["simple", "medium", "hard"] as const;
export type StewardComplexity = (typeof STEWARD_COMPLEXITIES)[number];

export const STEWARD_ACTION_KINDS = ["rebase in place", "status change"] as const;
export type StewardActionKind = (typeof STEWARD_ACTION_KINDS)[number];

export const STEWARD_MEMORY_SCOPES = ["core", "attached", "general"] as const;
export type StewardMemoryScope = (typeof STEWARD_MEMORY_SCOPES)[number];

export const STEWARD_ATTACHED_KINDS = ["topic", "repo", "person"] as const;
export type StewardAttachedKind = (typeof STEWARD_ATTACHED_KINDS)[number];

export const STEWARD_MEMORY_SOURCES = ["wake", "chat", "tidy-up", "owner"] as const;
export type StewardMemorySource = (typeof STEWARD_MEMORY_SOURCES)[number];

export const STEWARD_MESSAGE_ROLES = ["owner", "steward"] as const;
export type StewardMessageRole = (typeof STEWARD_MESSAGE_ROLES)[number];

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const PR_SIGNALS = [
  "ci failed",
  "changes requested",
  "new review comments",
  "conflict coming",
  "no reviewer",
  "ready to merge",
] as const;
export type PrSignal = (typeof PR_SIGNALS)[number];

/** The `setting` key holding Steward's settings (a StewardSettings object). */
export const STEWARD_SETTING_KEY = "steward";
