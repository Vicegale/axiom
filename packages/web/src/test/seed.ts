import type { EpicItem, ListThread, Parent, TicketItem } from "../api";
import { entry, type FakeServer, notification, topic } from "./fakeApi";

export const lt = (
  id: number,
  status: ListThread["status"],
  open = true,
  provider: ListThread["provider"] = "t3",
): ListThread => ({ id, provider, title: `T${id}`, status, open });

const parent = (over: Partial<Parent> & Pick<Parent, "kind" | "slug" | "title">): Parent => ({
  status: "wip",
  jiraKey: null,
  jiraStatus: null,
  locked: false,
  ...over,
});

const item = <T extends object>(over: T & { slug: string; title: string }) => ({
  status: "wip",
  jiraKey: null,
  jiraStatus: null,
  locked: false,
  topicCount: 1,
  ...over,
});

/** A small tracker: one topic per view, a null-status topic, a Jira ticket, an unfiled topic. */
export function seedTracker(server: FakeServer): void {
  const axiomEpic = parent({ kind: "epic", slug: "axiom", title: "Axiom" });
  const jiraTicket = parent({
    kind: "ticket",
    slug: "mtg-214",
    title: "Reforged gaps",
    jiraKey: "MTG-214",
    jiraStatus: "In Progress",
    locked: true,
  });
  server.topics = [
    topic({
      slug: "ask",
      title: "Needs me",
      status: "hitl",
      highlighted: true,
      attention: { reason: "agent asked", text: "Which way?", at: "2026-11-25T09:30:00.000Z" },
      parents: [axiomEpic],
      lastWorkedAt: "2026-11-25T09:30:00.000Z",
    }),
    topic({
      slug: "run",
      title: "Running",
      status: "wip",
      lastWorkedAt: "2026-11-25T09:20:00.000Z",
    }),
    topic({
      slug: "multi",
      title: "Two threads",
      status: null,
      statusNote: "rows 61 and 63",
      parents: [jiraTicket],
      threads: [lt(1, "wip"), lt(2, "hitl"), lt(3, "idle", false)],
      lastWorkedAt: "2026-11-25T09:10:00.000Z",
    }),
    topic({
      slug: "watch",
      title: "Watched",
      status: "review",
      lastWorkedAt: "2026-11-25T09:00:00.000Z",
    }),
    topic({
      slug: "sleepy",
      title: "Sleepy",
      status: "idle",
      stalePrompt: true,
      lastWorkedAt: "2026-11-04T09:00:00.000Z",
    }),
    topic({
      slug: "gone",
      title: "Finished",
      status: "done",
      lastWorkedAt: "2026-11-01T09:00:00.000Z",
    }),
  ];
  server.notifications = [
    notification({ id: 1, topicSlug: "ask", kind: "agent asked", body: "Which way?" }),
  ];
  server.entries.set("ask", [
    entry({
      id: 1,
      kind: "note",
      author: "agent",
      body: "A plain note",
      at: "2026-11-25T09:00:00.000Z",
    }),
    entry({
      id: 2,
      kind: "decision",
      author: "owner",
      body: "Go with slices",
      at: "2026-11-25T09:10:00.000Z",
    }),
    entry({
      id: 3,
      kind: "thread event",
      author: "axiom",
      body: "Waiting on the owner",
      at: "2026-11-25T09:20:00.000Z",
    }),
  ]);
  server.epics = [
    item({ slug: "axiom", title: "Axiom", ticketCount: 0 }),
    item({
      slug: "mtg",
      title: "MTG next phase",
      jiraKey: "MTG-12",
      jiraStatus: "In Progress",
      locked: true,
      ticketCount: 1,
    }),
  ] as EpicItem[];
  server.tickets = [
    item({
      slug: "mtg-214",
      title: "Reforged gaps",
      jiraKey: "MTG-214",
      jiraStatus: "In Progress",
      locked: true,
      epics: [{ slug: "mtg", title: "MTG next phase" }],
    }),
  ] as TicketItem[];
}
