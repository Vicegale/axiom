/** Domain vocabulary shared by every layout. Mirrors @axiom/core's constants (kept local so the
 *  browser bundle does not depend on the Node-only core package). */

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

export const NOTIFICATION_KINDS = [
  "agent stopped",
  "agent asked",
  "monitor problem",
  "jira changed",
  "pr review",
  "stale prompt",
  "error",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const ENTRY_KINDS = [
  "note",
  "decision",
  "finding",
  "verification",
  "owner input",
  "authorization",
  "next steps",
  "status change",
  "topic created",
  "thread event",
  "git event",
  "deploy event",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export type EntryAuthor = "owner" | "agent" | "axiom";

export type Provider = "claude-code" | "t3";
export const PROVIDER_LABEL: Record<string, string> = { t3: "T3", "claude-code": "Claude Code" };

/** The tracker views and piles shown in the rail, in the order a topic is listed under them. */
export const VIEW_IDS = [
  "attention",
  "ongoing",
  "monitoring",
  "idle",
  "blocked",
  "stale",
  "done",
] as const;
export type ViewId = (typeof VIEW_IDS)[number];
export const MAIN_VIEWS: readonly ViewId[] = ["attention", "ongoing", "monitoring"];
export const PILES: readonly ViewId[] = ["idle", "blocked", "stale", "done"];

export const VIEW_STATUSES: Record<ViewId, readonly TopicStatus[]> = {
  attention: ["hitl", "error"],
  ongoing: ["wip"],
  monitoring: ["monitoring", "review"],
  idle: ["idle"],
  blocked: ["blocked"],
  stale: ["stale"],
  done: ["done"],
};

export const VIEW_LABEL: Record<ViewId | "all", string> = {
  all: "Everything",
  attention: "Requires attention",
  ongoing: "Ongoing",
  monitoring: "Under monitoring",
  idle: "Idle",
  blocked: "Blocked",
  stale: "Stale",
  done: "Done",
};

export const VIEW_DOT: Record<ViewId, string> = {
  attention: "s-hitl",
  ongoing: "s-wip",
  monitoring: "s-monitoring",
  idle: "s-idle",
  blocked: "s-blocked",
  stale: "s-stale",
  done: "s-done",
};

export function isViewId(v: string): v is ViewId {
  return (VIEW_IDS as readonly string[]).includes(v);
}

/** Notification kind to the status colour it borrows. */
export const NOTIF_STATUS: Record<NotificationKind, TopicStatus> = {
  "agent asked": "hitl",
  "agent stopped": "idle",
  "monitor problem": "hitl",
  "pr review": "review",
  error: "error",
  "stale prompt": "stale",
  "jira changed": "monitoring",
};

export const LINK_ORDER = ["project", "repository", "branch", "worktree", "pr", "spec", "artifact"];
export const LINK_LABEL: Record<string, string> = {
  project: "Project",
  repository: "Repository",
  branch: "Branch",
  worktree: "Worktree",
  pr: "Pull requests",
  spec: "Specs",
  artifact: "Artifacts",
};
