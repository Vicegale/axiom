import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../../App";
import {
  entry,
  FakeServer,
  linkTasks,
  notification,
  task,
  thread,
  topic,
} from "../../test/fakeApi";

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  server.install();
});
afterEach(() => vi.unstubAllGlobals());

function open(path = "/") {
  const loc = memoryLocation({ path, record: true });
  render(<App router={{ hook: loc.hook }} />);
  return loc;
}

const lt = (id: number, status: "wip" | "idle" | "hitl", open = true) => ({
  id,
  provider: "t3" as const,
  title: `T${id}`,
  status,
  open,
});

function seed() {
  server.topics = [
    topic({
      slug: "ask",
      title: "Needs me",
      status: "hitl",
      highlighted: true,
      attention: { reason: "agent asked", text: "Which way?", at: "2026-11-25T09:30:00.000Z" },
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
      threads: [lt(1, "wip"), lt(2, "wip"), lt(3, "idle", false)],
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
      kind: "thread event",
      author: "axiom",
      body: "Waiting on the owner: Which way?",
      data: { event: "waiting on owner" },
    }),
  ]);
}

const rail = () => within(screen.getByRole("navigation", { name: "Mailboxes" }));

describe("Inbox shell", () => {
  it("groups Everything by view and counts them, null-status topic by its open threads", async () => {
    seed();
    open("/");
    await screen.findByText("Needs me");

    // Rail counts: Everything 6; attention 1; ongoing 2 (run + multi); monitoring 1; idle 1; done 1.
    const count = (name: string) =>
      rail().getByText(name).closest("a")?.querySelector(".n")?.textContent;
    expect(count("Everything")).toBe("6");
    expect(count("Requires attention")).toBe("1");
    expect(count("Ongoing")).toBe("2");
    expect(count("Under monitoring")).toBe("1");
    expect(count("Idle")).toBe("1");
    expect(count("Done")).toBe("1");

    // The null-status topic is listed under Ongoing, shown by its open threads (wip, wip).
    const heads = [...document.querySelectorAll(".sect-h, .pile > summary")].map(
      (e) => e.textContent,
    );
    expect(heads).toEqual([
      "Requires attention1",
      "Ongoing2",
      "Under monitoring1",
      "Idle1",
      "Done1",
    ]);
    const multi = screen.getByText("Two threads").closest("a") as HTMLElement;
    expect(multi.className).toContain("s-wip");
    expect(multi.textContent).toContain("3 threads, T3");
    expect(
      within(multi).getByTitle("More than one thread: each thread has its own status"),
    ).toBeTruthy();
    expect(multi.closest(".sect-h + ol, div")?.textContent).toContain("Running");
  });

  it("puts idle, blocked, stale and done in collapsed piles", async () => {
    seed();
    open("/");
    await screen.findByText("Needs me");
    const idle = document.querySelector<HTMLDetailsElement>('details[data-pile="idle"]');
    expect(idle?.open).toBe(false);
    fireEvent.click(idle?.querySelector("summary") as HTMLElement);
    await waitFor(() => expect(idle?.open).toBe(true));
  });

  it("shows one view on /view/:view and filters", async () => {
    seed();
    open("/view/ongoing");
    await screen.findByText("Running");
    expect(screen.getByRole("heading", { level: 1, name: "Ongoing" })).toBeTruthy();
    expect(screen.queryByText("Needs me")).toBeNull();
    expect(screen.getByText("Two threads")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter topics in this list"), {
      target: { value: "two" },
    });
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.getByText("Two threads")).toBeTruthy();
  });

  it("selects a topic on /topic/:slug while keeping the list, without refetching the list", async () => {
    seed();
    open("/topic/run");
    await screen.findByRole("heading", { level: 1, name: "Running" });
    expect(screen.getByText("Needs me")).toBeTruthy();
    const listCalls = server.called("GET", "/api/topics?all=1").length;
    expect(
      screen
        .getByText("Running", { selector: ".row-title" })
        .closest("a")
        ?.getAttribute("aria-current"),
    ).toBe("true");

    // Moving to another route does not refetch what is already loaded.
    fireEvent.click(rail().getByText("Settings"));
    await screen.findByRole("heading", { name: "Settings" });
    expect(server.called("GET", "/api/topics?all=1")).toHaveLength(listCalls);
  });

  it("clicking a topic calls POST /open and clears its highlight", async () => {
    seed();
    open("/");
    const row = (await screen.findByText("Needs me")).closest("a") as HTMLElement;
    expect(row.className).toContain("is-unread");
    fireEvent.click(row);
    await waitFor(() => expect(server.called("POST", "/api/topics/ask/open")).toHaveLength(1));
    await screen.findByRole("heading", { level: 1, name: "Needs me" });
    await waitFor(() =>
      expect(
        (screen.getByText("Needs me", { selector: ".row-title" }).closest("a") as HTMLElement)
          .className,
      ).not.toContain("is-unread"),
    );
  });

  it("shows why a topic needs attention in the row and the callout, after opening too", async () => {
    seed();
    open("/");
    const row = (await screen.findByText("Needs me")).closest("a") as HTMLElement;
    expect(row.querySelector(".row-reason")?.textContent).toBe("agent asked: Which way?");
    fireEvent.click(row);
    const callout = await screen.findByRole("note");
    expect(callout.textContent).toContain("agent asked: Which way?");
    await waitFor(() => expect(row.className).not.toContain("is-unread"));
    expect(row.querySelector(".row-reason")?.textContent).toBe("agent asked: Which way?");
  });

  it("mutes the open topic", async () => {
    seed();
    open("/topic/run");
    fireEvent.click(await screen.findByRole("button", { name: "Mute topic" }));
    await waitFor(() =>
      expect(server.called("POST", "/api/topics/run/mute")[0]?.body).toEqual({ muted: true }),
    );
    await screen.findByRole("button", { name: "Muted" });
  });

  it("marks stale and dismisses the stale prompt", async () => {
    seed();
    open("/topic/sleepy");
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(server.called("POST", "/api/topics/sleepy/stale-prompt/dismiss")).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByRole("group", { name: "Mark as stale?" })).toBeNull());

    const sleepy = server.topics.find((t) => t.slug === "sleepy");
    if (sleepy) sleepy.stalePrompt = true;
    open("/topic/sleepy");
    const marks = await screen.findAllByRole("button", { name: "Mark stale" });
    fireEvent.click(marks[0] as HTMLElement);
    await waitFor(() => expect(server.called("POST", "/api/topics/sleepy/stale")).toHaveLength(1));
  });

  it("confirms a suggested monitor target", async () => {
    seed();
    server.details.set("watch", {
      links: [{ id: 1, kind: "pr", target: "o/r#1", label: null }],
      monitorTargets: [{ id: 42, linkId: 1, kind: "pr-checks", state: "suggested" }],
    });
    open("/topic/watch");
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(server.called("POST", "/api/monitors/42/confirm")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull());
  });

  it("deletes a history entry only after confirming", async () => {
    seed();
    server.entries.set("run", [entry({ id: 77, body: "oops, a secret" })]);
    open("/topic/run");
    fireEvent.click(await screen.findByRole("button", { name: "Delete entry 77" }));
    expect(server.called("DELETE", "/api/entries/77")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.called("DELETE", "/api/entries/77")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("oops, a secret")).toBeNull());
  });

  it("shows notifications in the list column, and opening one selects the topic", async () => {
    seed();
    const loc = open("/notifications");
    expect(await screen.findByText("Which way?")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Needs me" }));
    await waitFor(() => expect(loc.history?.at(-1)).toBe("/topic/ask"));
    expect(server.called("POST", "/api/topics/ask/open")).toHaveLength(1);
  });

  it("reports a failed action in a banner", async () => {
    seed();
    open("/topic/run");
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) =>
      (init as RequestInit | undefined)?.method === "POST"
        ? new Response(JSON.stringify({ error: { code: "validation", message: "nope, sorry" } }), {
            status: 400,
          })
        : (original as (i: unknown, n?: unknown) => Promise<Response>)(input, init),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Mute topic" }));
    expect((await screen.findByText("nope, sorry")).closest("[role=alert]")).toBeTruthy();
  });

  it("redirects unknown routes to Everything", async () => {
    seed();
    const loc = open("/nonsense");
    await screen.findByText("Needs me");
    expect(loc.history?.at(-1)).toBe("/");
  });

  it("sets data-theme from the theme setting", async () => {
    seed();
    server.settings.theme = "light";
    open("/");
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
  });

  it("has threads on the detail from the API", async () => {
    seed();
    server.details.set("run", { threads: [thread({ id: 5, title: "Worker", status: "wip" })] });
    open("/topic/run");
    expect(await screen.findByText("Worker")).toBeTruthy();
  });
});

describe("Inbox tasks", () => {
  it("shows a 5/8-style badge on rows, and Tasks plus Graph sections in the reader", async () => {
    seed();
    server.tasks.set(
      "ask",
      linkTasks([
        task({ key: "A", title: "First", status: "done" }),
        task({ key: "B", title: "Second", dependsOn: ["A"] }),
      ]),
    );
    open("/topic/ask");
    await screen.findByRole("heading", { level: 2, name: "Tasks" });
    expect(screen.getByRole("heading", { level: 2, name: "Dependency graph" })).toBeTruthy();
    await waitFor(() => {
      const row = document.querySelector('a.row[data-slug="ask"]');
      expect(row?.querySelector('[data-testid="task-badge"]')?.textContent).toContain("1/2");
    });
    // A topic without tasks shows neither section nor badge.
    fireEvent.click(document.querySelector('a.row[data-slug="watch"]') as Element);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Tasks" })).toBeNull());
  });

  it("changes a task's status from its row", async () => {
    seed();
    server.tasks.set("ask", linkTasks([task({ key: "A", title: "First" })]));
    open("/topic/ask");
    const select = (await screen.findByRole("combobox", {
      name: "Status of A",
    })) as HTMLSelectElement;
    expect(select.value).toBe("to do");
    fireEvent.change(select, { target: { value: "done" } });
    await waitFor(() =>
      expect(server.called("POST", "/api/topics/ask/tasks/A/status")[0]?.body).toEqual({
        status: "done",
      }),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: "Status of A" }) as HTMLSelectElement).value,
      ).toBe("done"),
    );
  });
});
