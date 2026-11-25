import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../../App";
import { FakeServer, linkTasks, task } from "../../test/fakeApi";
import { seedTracker } from "../../test/seed";

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  server.settings.layout = "console";
  seedTracker(server);
  server.install();
});
afterEach(() => vi.unstubAllGlobals());

function open(path = "/") {
  const loc = memoryLocation({ path, record: true });
  render(<App router={{ hook: loc.hook }} />);
  return loc;
}

const group = (view: string) => {
  const el = document.querySelector<HTMLElement>(`tbody[data-group="${view}"]`);
  if (!el) throw new Error(`no group ${view}`);
  return el;
};
const slugsIn = (view: string) =>
  [...group(view).querySelectorAll("tr.cs-row")].map((r) => r.getAttribute("data-slug"));
const allSlugs = () =>
  [...document.querySelectorAll("tr.cs-row")].map((r) => r.getAttribute("data-slug"));
const pressKey = (key: string) => fireEvent.keyDown(document.body, { key });

describe("Console shell", () => {
  it("groups the table by view with counts; a null-status topic repeats per open-thread view", async () => {
    open("/");
    await screen.findByText("Needs me");
    expect([...document.querySelectorAll("tr.cs-grp th")].map((e) => e.textContent)).toEqual([
      "Requires attention2",
      "Ongoing2",
      "Under monitoring1",
      "Idle1",
      "Blocked0",
      "Stale0",
      "Done1",
    ]);
    expect(slugsIn("attention")).toEqual(["ask", "multi"]);
    expect(slugsIn("ongoing")).toEqual(["run", "multi"]);
    expect(slugsIn("done")).toEqual(["gone"]);
    expect(within(group("blocked")).getByText("Nothing here.")).toBeTruthy();
  });

  it("lists saved views with the same counts", async () => {
    open("/");
    await screen.findByText("Needs me");
    const views = within(screen.getByRole("navigation", { name: "Views and piles" }));
    const n = (label: string) =>
      views.getByText(label).closest("a")?.querySelector(".n")?.textContent;
    expect(n("Everything")).toBe("6");
    expect(n("Requires attention")).toBe("2");
    expect(n("Ongoing")).toBe("2");
    expect(n("Under monitoring")).toBe("1");
    expect(n("Done")).toBe("1");
  });

  it("shows one group on /view/:view", async () => {
    open("/view/ongoing");
    await screen.findByText("Running");
    expect([...document.querySelectorAll("tr.cs-grp th")].map((e) => e.textContent)).toEqual([
      "Ongoing2",
    ]);
    expect(screen.getByText(/view: Ongoing/)).toBeTruthy();
  });

  it("draws the tree: epics, tickets, topics, the Jira lock, and Unfiled", async () => {
    open("/");
    await screen.findByText("Needs me");
    await screen.findByText("MTG next phase");
    const tree = within(screen.getByRole("navigation", { name: "Hierarchy" }));
    const rows = [...document.querySelectorAll(".cs-tree-list > li")].map((li) => ({
      depth: (li as HTMLElement).style.getPropertyValue("--d"),
      label: li.querySelector(".cs-lbl")?.textContent ?? li.textContent,
      tail: li
        .querySelector(".cs-tail")
        ?.textContent?.replace(/Status owned by Jira/, "")
        .trim(),
    }));
    // Axiom epic (Axiom's own status): its topic under it; MTG epic (Jira) with ticket and topic.
    expect(rows.slice(0, 5)).toEqual([
      { depth: "0", label: "Axiom", tail: "wip" },
      { depth: "1", label: "ask", tail: undefined },
      { depth: "0", label: "MTG next phase", tail: "MTG-12 In Progress" },
      { depth: "1", label: "Reforged gaps", tail: "MTG-214 In Progress" },
      { depth: "2", label: "multi", tail: undefined },
    ]);
    // The Jira epic and ticket carry the lock; the plain epic does not.
    const locks = tree.getAllByTitle("Status owned by Jira");
    expect(locks).toHaveLength(2);
    expect(tree.getByText("Axiom").closest(".cs-node")?.querySelector(".lock")).toBeNull();
    // Unfiled holds the parentless topics.
    const labels = rows.map((r) => r.label);
    const at = labels.indexOf("Unfiled");
    expect(at).toBeGreaterThan(0);
    expect(labels.slice(at + 1)).toEqual(["run", "watch", "sleepy", "gone"]);
  });

  it("opens a row in the bottom panel and tells the server (POST /open)", async () => {
    const loc = open("/");
    await screen.findByText("Needs me");
    fireEvent.click(group("attention").querySelector('tr[data-slug="ask"]') as HTMLElement);
    await waitFor(() => expect(server.called("POST", "/api/topics/ask/open")).toHaveLength(1));
    expect(loc.history?.at(-1)).toBe("/topic/ask");
    const panel = within(screen.getByRole("region", { name: "Selected topic" }));
    await panel.findByText("A plain note");
    expect(panel.getByText("ask", { selector: ".cs-pslug" })).toBeTruthy();
    expect(
      group("attention").querySelector('tr[data-slug="ask"]')?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("opens a tree topic", async () => {
    open("/");
    await screen.findByText("MTG next phase");
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Hierarchy" })).getByText("multi"),
    );
    await waitFor(() => expect(server.called("POST", "/api/topics/multi/open")).toHaveLength(1));
  });

  it("sorts by a column, flipping on a second click", async () => {
    open("/view/ongoing");
    await screen.findByText("Running");
    // Default: last worked, newest first.
    expect(allSlugs()).toEqual(["run", "multi"]);
    const th = screen.getByRole("columnheader", { name: "Title" });
    expect(th.getAttribute("aria-sort")).toBeNull();
    fireEvent.click(within(th).getByRole("button", { name: "Title" }));
    expect(allSlugs()).toEqual(["run", "multi"]); // "running" < "two threads"
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(within(th).getByRole("button", { name: "Title" }));
    expect(allSlugs()).toEqual(["multi", "run"]);
    expect(th.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(screen.getByRole("button", { name: "Slug" }));
    expect(allSlugs()).toEqual(["multi", "run"]);
    expect(screen.getByRole("columnheader", { name: "Slug" }).getAttribute("aria-sort")).toBe(
      "ascending",
    );
  });

  it("walks the rows with j and k, opening each", async () => {
    const loc = open("/");
    await screen.findByText("Needs me");
    pressKey("j");
    await waitFor(() => expect(loc.history?.at(-1)).toBe("/topic/ask"));
    pressKey("j");
    await waitFor(() => expect(loc.history?.at(-1)).toBe("/topic/multi"));
    pressKey("j");
    await waitFor(() => expect(loc.history?.at(-1)).toBe("/topic/run"));
    pressKey("k");
    await waitFor(() => expect(loc.history?.at(-1)).toBe("/topic/multi"));
    expect(server.called("POST", "/api/topics/multi/open").length).toBeGreaterThan(0);
    // Not while typing in the filter.
    const filter = screen.getByPlaceholderText(/filter rows/);
    filter.focus();
    fireEvent.keyDown(filter, { key: "j" });
    expect(loc.history?.at(-1)).toBe("/topic/multi");
  });

  it("opens the focused row with Enter", async () => {
    const loc = open("/");
    await screen.findByText("Needs me");
    const row = group("monitoring").querySelector('tr[data-slug="watch"]') as HTMLElement;
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(loc.history?.at(-1)).toBe("/topic/watch"));
  });

  it("filters history by kind with chips, and has the five panel tabs", async () => {
    open("/topic/ask");
    const panel = within(await screen.findByRole("region", { name: "Selected topic" }));
    expect(panel.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "History",
      "Threads",
      "Tasks",
      "Graph",
      "Overview",
    ]);
    await panel.findByText("A plain note");
    const chips = within(panel.getByRole("group", { name: "Filter history by kind" }));
    expect(chips.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "note1",
      "decision1",
      "thread event1",
    ]);
    fireEvent.click(chips.getByRole("button", { name: /^note/ }));
    expect(chips.getByRole("button", { name: /^note/ }).getAttribute("aria-pressed")).toBe("false");
    expect(panel.queryByText("A plain note")).toBeNull();
    expect(panel.getByText("Go with slices")).toBeTruthy();
    expect(document.querySelector(".hist.dense")).toBeTruthy();
    fireEvent.click(chips.getByRole("button", { name: /^decision/ }));
    fireEvent.click(chips.getByRole("button", { name: /^thread event/ }));
    expect(panel.getByText("All kinds hidden.")).toBeTruthy();
    fireEvent.click(chips.getByRole("button", { name: /^note/ }));
    expect(panel.getByText("A plain note")).toBeTruthy();
  });

  it("switches panel tabs onto the shared detail parts", async () => {
    server.details.set("ask", {
      links: [{ id: 1, kind: "repository", target: "/home/x/axiom", label: null }],
    });
    open("/topic/ask");
    const panel = within(await screen.findByRole("region", { name: "Selected topic" }));
    await panel.findByText("A plain note");
    const shown = () => document.querySelector(".cs-pbody .tt")?.getAttribute("data-show");
    for (const [tab, parts] of [
      ["Threads", "threads"],
      ["Tasks", "tasks"],
      ["Graph", "graph"],
      ["Overview", "top"],
      ["History", ""],
    ] as const) {
      fireEvent.click(panel.getByRole("tab", { name: tab }));
      expect(panel.getByRole("tab", { name: tab }).getAttribute("aria-selected")).toBe("true");
      expect(shown()).toBe(parts);
    }
    expect(panel.queryByRole("tab", { name: "Links" })).toBeNull();
    expect(panel.queryByRole("tab", { name: "Monitors" })).toBeNull();
    expect(panel.getByText("/home/x/axiom")).toBeTruthy();
  });

  it("shows notifications in a right drawer, toggled with n", async () => {
    open("/");
    await screen.findByText("Needs me");
    expect(document.querySelector(".cs-drawer")).toBeNull();
    pressKey("n");
    const drawer = within(document.querySelector(".cs-drawer") as HTMLElement);
    expect(drawer.getByRole("link", { name: "Needs me" }).getAttribute("href")).toBe("/topic/ask");
    fireEvent.click(drawer.getByRole("link", { name: "Needs me" }));
    await waitFor(() => expect(server.called("POST", "/api/topics/ask/open")).toHaveLength(1));
    // Following the link leaves the drawer: it is the /notifications route.
    await waitFor(() => expect(document.querySelector(".cs-drawer")).toBeNull());
    pressKey("n");
    expect(document.querySelector(".cs-drawer")).toBeTruthy();
    pressKey("n");
    expect(document.querySelector(".cs-drawer")).toBeNull();
  });

  it("answers the stale prompt in the panel", async () => {
    open("/topic/sleepy");
    const panel = within(await screen.findByRole("region", { name: "Selected topic" }));
    fireEvent.click(await panel.findByRole("button", { name: "Mark stale" }));
    await waitFor(() => expect(server.called("POST", "/api/topics/sleepy/stale")).toHaveLength(1));
  });
});

describe("Console shell tasks", () => {
  it("has Tasks and Graph panel tabs, a badge in the table, and a node click opens the Tasks tab", async () => {
    server.tasks.set(
      "ask",
      linkTasks([
        task({ key: "A", title: "First", status: "done" }),
        task({ key: "B", title: "Second", dependsOn: ["A"] }),
      ]),
    );
    open("/topic/ask");
    const panel = within(await screen.findByRole("region", { name: "Selected topic" }));
    await waitFor(() =>
      expect(
        document.querySelector('tr.cs-row[data-slug="ask"] [data-testid="task-badge"]')
          ?.textContent,
      ).toContain("1/2"),
    );
    fireEvent.click(panel.getByRole("tab", { name: "Graph" }));
    await waitFor(() => expect(document.querySelectorAll(".g-node")).toHaveLength(2));
    expect(document.querySelectorAll(".g-edge")).toHaveLength(1);
    fireEvent.click(document.querySelector('.g-node[data-task-key="B"]') as Element);
    expect(panel.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("#task-B")?.classList.contains("is-picked")).toBe(true);
    expect(panel.getByRole("combobox", { name: "Status of B" })).toBeTruthy();
  });
});
