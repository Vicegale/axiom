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
