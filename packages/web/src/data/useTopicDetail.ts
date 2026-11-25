import { api, type Entry, type TicketItem, type TopicDetailData } from "../api";
import { useAxiom } from "./DataProvider";
import { useResource } from "./useResource";

export interface TopicBundle {
  topic: TopicDetailData;
  entries: Entry[];
  /** Ticket slug to the title of the first epic it sits under. */
  ticketEpics: Record<string, string>;
}

/** The selected topic's detail and history; refetched on every server change. */
export function useTopicDetail(slug: string | undefined) {
  const { tick } = useAxiom();
  return useResource<TopicBundle | null>(
    `topic:${slug ?? ""}`,
    async () => {
      if (!slug) return null;
      const [topic, entries, tickets] = await Promise.all([
        api.topic(slug),
        api.entries(slug),
        api.tickets().catch(() => [] as TicketItem[]),
      ]);
      const ticketEpics: Record<string, string> = {};
      for (const t of tickets) {
        const first = t.epics[0];
        if (first) ticketEpics[t.slug] = first.title;
      }
      return { topic, entries, ticketEpics };
    },
    tick,
  );
}
