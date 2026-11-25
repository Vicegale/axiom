import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../../App";
import { FakeServer, linkTasks, task, topic } from "../../test/fakeApi";
import { lt, seedTracker } from "../../test/seed";

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  server.settings.layout = "board";
  seedTracker(server);
  server.install();
});
afterEach(() => vi.unstubAllGlobals());

function open(path = "/") {
  const loc = memoryLocation({ path, record: true });
  render(<App router={{ hook: loc.hook }} />);
  return loc;
}

const lane = (view: string) => {
  const el = document.querySelector<HTMLElement>(`.bd-lane[data-view="${view}"]`);
  if (!el) throw new Error(`no lane ${view}`);
  return el;
};
const countOf = (view: string) => lane(view).querySelector(".bd-count")?.textContent;
const titlesIn = (view: string) =>
  [...lane(view).querySelectorAll(".bd-card-title")].map((e) => e.textContent);

describe("Board shell", () => {
  it("has a lane per view with counts; a null-status topic sits in each lane its open threads qualify for", async () => {
    open("/");
    await screen.findByText("Needs me");
    expect(
      [...document.querySelectorAll(".bd-lane")].map((l) => l.getAttribute("data-view")),
    ).toEqual(["attention", "ongoing", "monitoring", "idle", "blocked", "stale", "done"]);

    // multi has open threads wip + hitl (and one ended idle): Ongoing and Requires attention.
    expect(titlesIn("attention")).toEqual(["Needs me", "Two threads"]);
    expect(titlesIn("ongoing")).toEqual(["Running", "Two threads"]);
    expect(titlesIn("monitoring")).toEqual(["Watched"]);
    expect(titlesIn("idle")).toEqual(["Sleepy"]);
    expect(countOf("attention")).toBe("2");
    expect(countOf("ongoing")).toBe("2");
    expect(countOf("idle")).toBe("1");
    expect(countOf("blocked")).toBe("0");
    expect(within(lane("blocked")).getByText("Nothing here.")).toBeTruthy();
    expect(lane("idle").className).toContain("bd-lane--pile");
  });

  it("shows the attention reason on attention cards and dims threads that belong to other lanes", async () => {
    open("/");
    await screen.findByText("Needs me");
    expect(within(lane("attention")).getByText("Which way?")).toBeTruthy();
    const dimmed = (view: string) =>
      [...lane(view).querySelectorAll(".bd-thr.is-dim")].map((e) => e.textContent);
    // In Ongoing the hitl thread and the ended idle one are dimmed; in Requires attention the
    // wip one and the ended idle one are.
    expect(dimmed("ongoing")).toEqual(["T3T2hitl", "T3T3idle"]);
    expect(dimmed("attention")).toEqual(["T3T1wip", "T3T3idle"]);
    expect(
      within(lane("attention")).getByText("3 threads, no status", { exact: false }),
    ).toBeTruthy();
  });

  it("opens a card in the sheet and tells the server (POST /open)", async () => {
    const loc = open("/");
    await screen.findByText("Needs me");
    fireEvent.click(within(lane("attention")).getByText("Needs me"));
    await waitFor(() => expect(server.called("POST", "/api/topics/ask/open")).toHaveLength(1));
    expect(loc.history?.at(-1)).toBe("/topic/ask");
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { level: 2, name: "Needs me" })).toBeTruthy();
    // The highlight clears once the server has seen the open.
    await waitFor(() =>
      expect(lane("attention").querySelector('[data-slug="ask"]')?.className).not.toContain(
        "is-unread",
      ),
    );
  });

  it("opens straight onto /topic/:slug with the sheet, and closing goes back to the board", async () => {
    const loc = open("/topic/run");
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { level: 2, name: "Running" })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close topic" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(loc.history?.at(-1)).toBe("/");
  });

  it("closes the sheet with Escape", async () => {
    open("/topic/run");
    await screen.findByRole("dialog");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("has Overview / History / Threads / Tasks / Graph / Links tabs showing the shared detail parts", async () => {
    server.details.set("ask", {
      links: [{ id: 1, kind: "repository", target: "/home/x/axiom", label: null }],
    });
    open("/topic/ask");
    const sheet = await screen.findByRole("dialog");
    const tabs = within(sheet).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual([
      "Overview",
      "History",
      "Threads",
      "Tasks",
      "Graph",
      "Links",
    ]);
    const shown = () => sheet.querySelector(".tt")?.getAttribute("data-show");
    await waitFor(() => expect(shown()).toBe("top monitors"));
    expect(within(sheet).getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe(
      "true",
    );

    fireEvent.click(within(sheet).getByRole("tab", { name: "History" }));
    expect(shown()).toBe("history");
    expect(within(sheet).getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(within(sheet).getByText("A plain note")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("tab", { name: /Threads/ }));
    expect(shown()).toBe("threads");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Tasks" }));
    expect(shown()).toBe("tasks");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Graph" }));
    expect(shown()).toBe("graph");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Links" }));
    expect(shown()).toBe("links");
    expect(within(sheet).getByText("/home/x/axiom")).toBeTruthy();
  });

  it("keeps Done as a thin strip that expands", async () => {
    open("/");
    await screen.findByText("Needs me");
    const done = lane("done");
    const toggle = within(done).getByRole("button", { name: /Done/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(done.className).not.toContain("is-open");
    expect(within(done).getByText("1")).toBeTruthy();
    expect(done.querySelector(".bd-lane-body")?.hasAttribute("hidden")).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(done.className).toContain("is-open");
    expect(done.querySelector(".bd-lane-body")?.hasAttribute("hidden")).toBe(false);
    expect(within(done).getByText("Finished")).toBeTruthy();
  });

  it("answers the stale prompt on a card", async () => {
    open("/");
    await screen.findByText("Sleepy");
    const group = within(lane("idle")).getByRole("group", { name: "Mark as stale?" });
    fireEvent.click(within(group).getByRole("button", { name: "Mark stale" }));
    await waitFor(() => expect(server.called("POST", "/api/topics/sleepy/stale")).toHaveLength(1));
    // It sits in Stale after the refetch, with no prompt.
    await waitFor(() => expect(titlesIn("stale")).toEqual(["Sleepy"]));
    expect(within(lane("stale")).queryByRole("group", { name: "Mark as stale?" })).toBeNull();
  });

  it("filters the lanes", async () => {
    open("/");
    await screen.findByText("Needs me");
    fireEvent.change(screen.getByPlaceholderText("Filter topics"), { target: { value: "watch" } });
    expect(titlesIn("monitoring")).toEqual(["Watched"]);
    expect(titlesIn("attention")).toEqual([]);
    expect(countOf("attention")).toBe("0");
  });

  it("opens the notifications as a tray from the status bar and opens a topic from it", async () => {
    open("/");
    await screen.findByText("Needs me");
    const btn = screen.getByRole("button", { name: /Notifications/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.textContent).toContain("1");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const tray = document.querySelector<HTMLElement>(".bd-tray") as HTMLElement;
    expect(document.querySelector(".bd-app")?.getAttribute("data-tray")).toBe("open");
    expect(within(tray).getByRole("link", { name: "Needs me" }).getAttribute("href")).toBe(
      "/topic/ask",
    );
    fireEvent.click(within(tray).getByRole("link", { name: "Needs me" }));
    await waitFor(() => expect(server.called("POST", "/api/topics/ask/open")).toHaveLength(1));
    await screen.findByRole("dialog");
    expect(document.querySelector(".bd-app")?.getAttribute("data-tray")).toBe("closed");
  });

  it("opens the tray on /notifications", async () => {
    open("/notifications");
    await screen.findAllByRole("link", { name: "Needs me" });
    expect(document.querySelector(".bd-app")?.getAttribute("data-tray")).toBe("open");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the settings page in place of the board", async () => {
    open("/settings");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    expect((screen.getByLabelText("Board") as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector(".bd-board")).toBeNull();
  });

  it("keeps topics with no open thread in a lane", async () => {
    server.topics.push(
      topic({ slug: "odd", title: "Odd", status: null, threads: [lt(9, "wip", false)] }),
    );
    open("/");
    await screen.findByText("Odd");
    expect(titlesIn("idle")).toContain("Odd");
  });
});

describe("Board shell tasks", () => {
  function withTasks() {
    server.tasks.set(
      "ask",
      linkTasks([
        task({ key: "S0", title: "Setup", status: "done" }),
        task({ key: "S1", title: "Core", status: "wip", dependsOn: ["S0"] }),
        task({ key: "S2", title: "Web", dependsOn: ["S1"] }),
      ]),
    );
  }

  it("shows a progress badge on cards of topics with tasks", async () => {
    withTasks();
    open("/");
    await screen.findByText("Needs me");
    await waitFor(() => {
      const card = document.querySelector<HTMLElement>('.bd-card[data-slug="ask"]');
      expect(card?.querySelector('[data-testid="task-badge"]')?.textContent).toContain("1/3");
    });
    expect(
      document.querySelector('.bd-card[data-slug="watch"] [data-testid="task-badge"]'),
    ).toBeNull();
  });

  it("shows the Tasks tab, and picking a graph node jumps to it with the row highlighted", async () => {
    withTasks();
    open("/topic/ask");
    const sheet = within(await screen.findByRole("dialog"));
    fireEvent.click(sheet.getByRole("tab", { name: "Graph" }));
    await waitFor(() => expect(document.querySelectorAll(".g-node")).toHaveLength(3));
    fireEvent.click(document.querySelector('.g-node[data-task-key="S2"]') as Element);
    expect(sheet.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("#task-S2")?.classList.contains("is-picked")).toBe(true);
  });
});
