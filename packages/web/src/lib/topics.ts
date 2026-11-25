import type { AxiomNotification, Entry, TopicListItem } from "../api";
import { PILES, type TopicStatus, VIEW_IDS, VIEW_STATUSES, type ViewId } from "./domain";

/** The statuses that place a topic in views: its own, or (when null) its open threads'. */
export function statusesOf(t: Pick<TopicListItem, "status" | "threads">): TopicStatus[] {
  if (t.status) return [t.status];
  return t.threads.filter((th) => th.open).map((th) => th.status);
}

export function inView(t: Pick<TopicListItem, "status" | "threads">, view: ViewId): boolean {
  const want = VIEW_STATUSES[view];
  return statusesOf(t).some((s) => want.includes(s));
}

/** The one section a topic is listed under in "Everything". */
export function sectionOf(t: Pick<TopicListItem, "status" | "threads">): ViewId {
  for (const v of VIEW_IDS) if (inView(t, v)) return v;
  return "idle";
}

/** Status that colours the row spine; a null-status topic takes its first matching thread's. */
export function spineStatus(t: Pick<TopicListItem, "status" | "threads">): TopicStatus {
  if (t.status) return t.status;
  const ss = statusesOf(t);
  for (const v of VIEW_IDS) {
    for (const s of ss) if (VIEW_STATUSES[v].includes(s)) return s;
  }
  return "idle";
}

export const isPile = (v: ViewId): boolean => PILES.includes(v);

export function matchesQuery(t: TopicListItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const parts = [t.title, t.slug, t.statusNote ?? "", t.goal ?? "", t.status ?? ""];
  for (const p of t.parents) parts.push(p.title, p.jiraKey ?? "");
  return parts.join(" ").toLowerCase().includes(q);
}

export interface Attention {
  reason: string;
  text: string;
}

const ATTENTION_KINDS = ["agent asked", "error"];

/**
 * Why a topic is in "requires attention". Prefers the latest waiting-on-owner or error thread
 * event in the history (it survives the notification being dismissed), then an open notification.
 */
export function attentionOf(
  topic: Pick<TopicListItem, "slug" | "status" | "threads">,
  notifications: readonly AxiomNotification[],
  entries?: readonly Entry[],
): Attention | null {
  if (!inView(topic, "attention")) return null;
  if (entries) {
    let best: Entry | undefined;
    for (const e of entries) {
      const ev = (e.data as { event?: string } | null)?.event;
      if (e.kind === "thread event" && (ev === "waiting on owner" || ev === "error")) {
        if (!best || e.id > best.id) best = e;
      }
    }
    if (best) {
      const ev = (best.data as { event: string }).event;
      const text = (best.body ?? "")
        .replace(/^Waiting on the owner:\s*/, "")
        .replace(/^Thread error:\s*/, "");
      return { reason: ev === "error" ? "error" : "agent asked", text };
    }
  }
  const n = notifications.find(
    (x) => x.topicSlug === topic.slug && ATTENTION_KINDS.includes(x.kind),
  );
  return n ? { reason: n.kind, text: n.body ?? "" } : null;
}
