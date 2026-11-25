/**
 * All status logic lives here, as pure functions (no database, no clock).
 * The database operations in axiom.ts call these.
 */
import {
  type Actor,
  AXIOM_ENTRY_KINDS,
  type EntryKind,
  OWNER_ENTRY_KINDS,
  SHARED_ENTRY_KINDS,
  type TopicStatus,
  type View,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Views (01, "The tracker's three views")
// ---------------------------------------------------------------------------

const VIEW_OF_STATUS: Record<TopicStatus, View> = {
  hitl: "attention",
  error: "attention",
  wip: "ongoing",
  monitoring: "monitoring",
  review: "monitoring",
  idle: "piles",
  blocked: "piles",
  stale: "piles",
  done: "closed",
};

export function viewOfStatus(status: TopicStatus): View {
  return VIEW_OF_STATUS[status];
}

/**
 * Views a topic appears in. A topic with a status is in exactly one view. A topic with a null
 * status is in every view that one of its OPEN threads qualifies for; ended threads never count.
 */
export function viewsOfTopic(
  topicStatus: TopicStatus | null,
  openThreadStatuses: readonly TopicStatus[],
): View[] {
  if (topicStatus !== null) return [viewOfStatus(topicStatus)];
  return [...new Set(openThreadStatuses.map(viewOfStatus))];
}

// ---------------------------------------------------------------------------
// Stop table (01, "When an agent stops")
// ---------------------------------------------------------------------------

export interface StopInput {
  /** The last status the agent declared itself in this thread, if any. */
  declaredStatus: TopicStatus | null;
  /** True when the last thing before the stop was `threadWaitingOnOwner`. */
  waitingOnOwner: boolean;
  hasPrLink: boolean;
  confirmedMonitorTargets: number;
}

export function stopStatus(input: StopInput): TopicStatus {
  if (input.waitingOnOwner) return "hitl";
  switch (input.declaredStatus) {
    case "hitl":
      return "hitl";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    case "review":
      return input.hasPrLink ? "review" : "idle";
    case "monitoring":
      return input.confirmedMonitorTargets >= 1 ? "monitoring" : "blocked";
    default:
      // nothing, wip, and anything the table does not list (errors go through threadError).
      return "idle";
  }
}

// ---------------------------------------------------------------------------
// Topic status from threads (05 Q6) -- PROVISIONAL
// ---------------------------------------------------------------------------

export interface ThreadState {
  status: TopicStatus;
  open: boolean;
  /** Orders status changes: ISO time, then a monotonically increasing sequence. */
  statusChangedAt: string;
  statusChangedSeq: number;
}

/**
 * PROVISIONAL (05 Q6, 01 "temporary ruling"): the topic's status is null only while MORE THAN ONE
 * OPEN thread is `wip` at once. Exactly one wip open thread makes the topic `wip`. Otherwise an
 * open thread that needs the owner wins (`error` before `hitl`), so attention is never lost to
 * another thread stopping later. Otherwise the topic takes the status of the thread whose status
 * changed most recently. Keep this the only
 * place that encodes the rule, so it is cheap to change after real use.
 * Returns null when the topic has no threads at all (nothing to derive from).
 */
export function topicStatusFromThreads(threads: readonly ThreadState[]): TopicStatus | null {
  const wipOpen = threads.filter((t) => t.open && t.status === "wip").length;
  if (wipOpen > 1) return null;
  if (wipOpen === 1) return "wip";
  if (threads.some((t) => t.open && t.status === "error")) return "error";
  if (threads.some((t) => t.open && t.status === "hitl")) return "hitl";
  let latest: ThreadState | undefined;
  for (const t of threads) {
    if (
      !latest ||
      t.statusChangedAt > latest.statusChangedAt ||
      (t.statusChangedAt === latest.statusChangedAt && t.statusChangedSeq > latest.statusChangedSeq)
    ) {
      latest = t;
    }
  }
  return latest ? latest.status : null;
}

// ---------------------------------------------------------------------------
// Who may set which status (01)
// ---------------------------------------------------------------------------

/** Returns an error message, or null when `actor` may set `status` by hand. */
export function manualStatusError(actor: Actor, status: TopicStatus): string | null {
  if (actor.kind === "owner") return null;
  if (status === "stale") return "only the owner can set a topic to stale";
  if ((actor.kind === "agent" || actor.kind === "steward") && status === "wip") {
    return "agents cannot set wip by hand; it is set automatically while a thread runs";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry authorship (08)
// ---------------------------------------------------------------------------

/** Returns an error message, or null when `actor` may write an entry of `kind`. */
export function entryWriteError(actor: Actor, kind: EntryKind): string | null {
  if ((AXIOM_ENTRY_KINDS as readonly string[]).includes(kind)) {
    return actor.kind === "axiom" ? null : `"${kind}" entries are written only by Axiom`;
  }
  if ((OWNER_ENTRY_KINDS as readonly string[]).includes(kind)) {
    return actor.kind === "owner" ? null : `"${kind}" entries are written only by the owner`;
  }
  if ((SHARED_ENTRY_KINDS as readonly string[]).includes(kind)) {
    return actor.kind === "axiom"
      ? `"${kind}" entries are written by agents, Steward or the owner`
      : null;
  }
  return `unknown entry kind "${kind}"`;
}

export function isAxiomEntryKind(kind: EntryKind): boolean {
  return (AXIOM_ENTRY_KINDS as readonly string[]).includes(kind);
}

// ---------------------------------------------------------------------------
// Stale prompt (01)
// ---------------------------------------------------------------------------

export interface StalePromptInput {
  status: TopicStatus | null;
  lastWorkedAt: string;
  stalePromptDismissed: boolean;
  hasOpenStalePrompt: boolean;
  now: Date;
  staleAfterDays: number;
}

export function staleCutoff(now: Date, staleAfterDays: number): string {
  return new Date(now.getTime() - staleAfterDays * 86_400_000).toISOString();
}

export function needsStalePrompt(input: StalePromptInput): boolean {
  return (
    input.status === "idle" &&
    !input.stalePromptDismissed &&
    !input.hasOpenStalePrompt &&
    input.lastWorkedAt < staleCutoff(input.now, input.staleAfterDays)
  );
}
