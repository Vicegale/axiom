import type { DeskThread, DeskTopic } from "../api";
import { ago } from "./time";

export type DeskSort = "ready" | "fixed";
/** Cards per row: 1 to 4, or "n" (as many as fit, with a minimum card width). */
export type PerRow = 1 | 2 | 3 | 4 | "n";
export const PER_ROWS: readonly PerRow[] = [1, 2, 3, 4, "n"];

/** When the thread last did something: its reply, its end, or its start. */
export function activityAt(t: DeskThread): string {
  return (
    [t.lastReplyAt, t.endedAt, t.startedAt]
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? ""
  );
}

/** The topic's threads, most recently active first. */
export function threadsByActivity(threads: readonly DeskThread[]): DeskThread[] {
  return [...threads].sort((a, b) => {
    const x = activityAt(a);
    const y = activityAt(b);
    return x < y ? 1 : x > y ? -1 : b.id - a.id;
  });
}

/** Is the owner next on this topic? Waiting for them, stopped on an error, in review, or an
 *  agent's reply that leaves something for them. */
export function ownerIsNext(t: DeskTopic): boolean {
  if (t.status === "hitl" || t.status === "error" || t.status === "review") return true;
  if (t.attention) return true;
  return t.threads.some(
    (th) =>
      th.status === "hitl" ||
      th.status === "error" ||
      (th.summary !== null && th.summary.next.trim().toLowerCase() !== "nothing"),
  );
}

const newest = (a: DeskTopic, b: DeskTopic): number =>
  a.lastWorkedAt < b.lastWorkedAt ? 1 : a.lastWorkedAt > b.lastWorkedAt ? -1 : 0;

/** Favourites first in both modes. Ready first: topics where the owner is next, then the rest,
 *  each by last worked. Fixed: the owner's drag order, then last worked. */
export function sortDesk(topics: readonly DeskTopic[], sort: DeskSort): DeskTopic[] {
  const rank = (t: DeskTopic): number => (sort === "ready" && ownerIsNext(t) ? 0 : 1);
  return [...topics].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    if (sort === "ready") {
      const r = rank(a) - rank(b);
      if (r) return r;
      return newest(a, b);
    }
    const x = a.deskOrder ?? Number.POSITIVE_INFINITY;
    const y = b.deskOrder ?? Number.POSITIVE_INFINITY;
    if (x !== y) return x < y ? -1 : 1;
    return newest(a, b);
  });
}

/** "finished 6 d ago", "running", "waiting for you". */
export function runLine(t: DeskThread, now: Date): string {
  if (t.status === "wip") return "running";
  if (t.status === "hitl") return "waiting for you";
  if (t.status === "error") return "stopped on an error";
  const at = t.endedAt ?? t.lastReplyAt ?? t.startedAt;
  return `${t.open ? "finished" : "ended"} ${ago(at, now)}`;
}

/** An activity line older than this shows how old it is. */
export const ACTIVITY_FRESH_MS = 10_000;

/** "12s ago", "3 min ago": how old the activity line is, or null while it is fresh (or unknown). */
export function activityAge(at: string, now: Date): string | null {
  const ms = now.getTime() - new Date(at).getTime();
  if (!Number.isFinite(ms) || ms < ACTIVITY_FRESH_MS) return null;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  return ago(at, now);
}

/** What a running thread's line says after "running": its newest step, when it has one. */
export function runningActivity(t: DeskThread): string | null {
  return t.status === "wip" && t.activity ? t.activity.text : null;
}

/** A thread's label in the selector. */
export function threadLabel(t: DeskThread): string {
  return t.title?.trim() || `Thread ${t.id}`;
}

/** Moves `slug` to `index` (clamped) in a copy of `order`. */
export function moveTo(order: readonly string[], slug: string, index: number): string[] {
  const rest = order.filter((s) => s !== slug);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, slug);
  return rest;
}

/**
 * A model id as the owner says it: `claude-opus-5-5` is "Opus 5.5", `claude-3-5-sonnet-20241022`
 * is "Sonnet 3.5". Anything else (another vendor's id, an alias) stays as it is.
 */
export function modelName(id: string): string {
  const base = id.replace(/\[1m\]$/i, "");
  const cap = (f: string) => f.charAt(0).toUpperCase() + f.slice(1);
  const modern = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(base);
  if (modern) return `${cap(modern[1] as string)} ${modern[2]}${modern[3] ? `.${modern[3]}` : ""}`;
  const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?$/.exec(base);
  if (legacy) return `${cap(legacy[3] as string)} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ""}`;
  return id;
}

/** A token count in the card's short form: 950, 1.2k, 190k, 1M, 1.5M. */
export function tokenCount(n: number): string {
  const trim = (x: number) => String(Math.round(x * 10) / 10);
  if (n >= 999_500) return `${trim(n / 1_000_000)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${trim(n / 1000)}k`;
  return String(Math.round(n));
}

/** How full the context is, as a fraction (0 to 1), or null when the window or the use is unknown. */
export function contextRatio(used: number | null, max: number | null): number | null {
  if (used === null || max === null || max <= 0) return null;
  return Math.min(1, Math.max(0, used / max));
}

/** The meter's colour step: neutral, `warn` above 80 %, `full` above 95 %. */
export function contextLevel(ratio: number): "ok" | "warn" | "full" {
  return ratio > 0.95 ? "full" : ratio > 0.8 ? "warn" : "ok";
}
