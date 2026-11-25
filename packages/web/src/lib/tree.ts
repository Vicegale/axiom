import type { EpicItem, TicketItem, TopicListItem, WorkItem } from "../api";

export type TreeNode =
  | { type: "epic" | "ticket"; key: string; depth: number; item: WorkItem }
  | { type: "topic"; key: string; depth: number; topic: TopicListItem }
  | { type: "unfiled-head"; key: string; depth: 0 };

/**
 * The Console's left tree, flattened: epics, their tickets, topics under each ticket and directly
 * under each epic; tickets without an epic at the root; then the topics with no parent at all
 * under "Unfiled". A topic under several parents appears under each.
 */
export function buildTree(
  epics: readonly EpicItem[],
  tickets: readonly TicketItem[],
  topics: readonly TopicListItem[],
): TreeNode[] {
  const out: TreeNode[] = [];
  const under = (kind: "ticket" | "epic", slug: string) =>
    topics.filter((t) => t.parents.some((p) => p.kind === kind && p.slug === slug));
  const topicNodes = (list: readonly TopicListItem[], depth: number, from: string) => {
    for (const t of list) out.push({ type: "topic", key: `${from}/${t.slug}`, depth, topic: t });
  };
  for (const e of epics) {
    out.push({ type: "epic", key: `epic:${e.slug}`, depth: 0, item: e });
    for (const k of tickets.filter((k) => k.epics.some((x) => x.slug === e.slug))) {
      out.push({ type: "ticket", key: `epic:${e.slug}/ticket:${k.slug}`, depth: 1, item: k });
      topicNodes(under("ticket", k.slug), 2, `epic:${e.slug}/ticket:${k.slug}`);
    }
    topicNodes(under("epic", e.slug), 1, `epic:${e.slug}`);
  }
  for (const k of tickets.filter((k) => k.epics.length === 0)) {
    out.push({ type: "ticket", key: `ticket:${k.slug}`, depth: 0, item: k });
    topicNodes(under("ticket", k.slug), 1, `ticket:${k.slug}`);
  }
  const unfiled = topics.filter((t) => t.parents.length === 0);
  if (unfiled.length) {
    out.push({ type: "unfiled-head", key: "unfiled", depth: 0 });
    topicNodes(unfiled, 0, "unfiled");
  }
  return out;
}
