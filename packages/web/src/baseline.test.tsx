import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "./App";
import { expectAccessible } from "./test/axe";
import { FakeServer, notification } from "./test/fakeApi";
import { seedTracker } from "./test/seed";

/** Spec 09, "Web standards baseline": what each layout does beyond its own features. */

class FakeEventSource {
  static last: FakeEventSource | undefined;
  listeners = new Map<string, (() => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  close() {}
}

let server: FakeServer;
type Layout = "inbox" | "board" | "console";

function start(layout: Layout, path = "/") {
  server.settings.layout = layout;
  const loc = memoryLocation({ path, record: true });
  render(<App router={{ hook: loc.hook }} />);
  return loc;
}

beforeEach(() => {
  window.localStorage.clear();
  document.title = "";
  server = new FakeServer();
  seedTracker(server);
  server.install();
});
afterEach(() => vi.unstubAllGlobals());

const press = (key: string, target: Element = document.body) => fireEvent.keyDown(target, { key });
const opens = () => server.calls.filter((c) => c.method === "POST" && c.path.endsWith("/open"));

describe("document title", () => {
  it("is `(count needing you) topic or view · Axiom` in every layout", async () => {
    for (const layout of ["inbox", "board", "console"] as const) {
      document.title = "";
      server.settings.layout = layout;
      const loc = memoryLocation({ path: "/topic/ask", record: true });
      const r = render(<App router={{ hook: loc.hook }} />);
      await waitFor(() => expect(document.title).toBe("(2) Needs me · Axiom"));
      act(() => loc.navigate("/view/ongoing"));
      await waitFor(() => expect(document.title).toBe("(2) Ongoing · Axiom"));
      act(() => loc.navigate("/notifications"));
      await waitFor(() => expect(document.title).toBe("(2) Notifications · Axiom"));
      act(() => loc.navigate("/settings"));
      await waitFor(() => expect(document.title).toBe("(2) Settings · Axiom"));
      r.unmount();
    }
  });

  it("drops the count when nothing needs the owner", async () => {
    server.topics = server.topics.filter((t) => t.slug !== "ask" && t.slug !== "multi");
    start("inbox", "/");
    await waitFor(() => expect(document.title).toBe("Everything · Axiom"));
  });
});

describe("live region", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("announces a new notification politely, and stays quiet about what was already there", async () => {
    start("inbox");
    await screen.findByText("Needs me");
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");

    server.notifications = [
      notification({ id: 2, topicSlug: "run", kind: "agent stopped", body: "All green" }),
      ...server.notifications,
    ];
    act(() => FakeEventSource.last?.emit("change"));
    await waitFor(() => expect(region.textContent).toContain("agent stopped: Running"));
    expect(region.textContent).toContain("All green");
    expect(document.activeElement).toBe(document.body); // nothing stole focus
  });

  it("announces a topic that newly needs the owner", async () => {
    start("console");
    await screen.findByText("Running");
    const region = screen.getByRole("status");
    const run = server.topics.find((t) => t.slug === "run");
    if (!run) throw new Error("seed");
    run.status = "hitl";
    run.attention = { reason: "agent asked", text: "Ready?", at: "2026-11-25T10:00:00.000Z" };
    act(() => FakeEventSource.last?.emit("change"));
    await waitFor(() => expect(region.textContent).toContain("Running needs you"));
  });
});

describe("skip link and landmarks", () => {
  it.each(["inbox", "board", "console"] as const)(
    "%s: skip link focuses the main content",
    async (layout) => {
      start(layout);
      await screen.findByText("Needs me");
      const skip = screen.getByRole("link", { name: "Skip to content" });
      expect(skip.getAttribute("href")).toBe("#main");
      expect(document.querySelectorAll("#main")).toHaveLength(1);
      fireEvent.click(skip);
      expect(document.activeElement?.id).toBe("main");
      expect(document.querySelectorAll("h1")).toHaveLength(1);
      expect(screen.getAllByRole("main")).toHaveLength(1);
    },
  );
});

describe("Inbox", () => {
  it("collapses the rail with its button and with [, and remembers it", async () => {
    start("inbox");
    await screen.findByText("Needs me");
    const rail = () => document.getElementById("rail") as HTMLElement;
    const btn = screen.getByRole("button", { name: "Hide sidebar" });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.getAttribute("aria-controls")).toBe("rail");
    expect(rail().hidden).toBe(false);

    fireEvent.click(btn);
    expect(rail().hidden).toBe(true);
    expect(screen.getByRole("button", { name: "Show sidebar" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(document.querySelector(".app")?.getAttribute("data-rail")).toBe("closed");
    expect(window.localStorage.getItem("axiom.pane.inbox-rail.collapsed")).toBe("1");
    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeNull();

    press("[");
    expect(rail().hidden).toBe(false);
    press("[");
    expect(rail().hidden).toBe(true);
    // Typing "[" in the filter does not toggle.
    press("[", screen.getByLabelText("Filter topics in this list"));
    expect(rail().hidden).toBe(true);
    expect(window.localStorage.getItem("axiom.pane.inbox-rail.collapsed")).toBe("1");
  });

  it("starts collapsed when that is what was remembered", async () => {
    window.localStorage.setItem("axiom.pane.inbox-rail.collapsed", "1");
    start("inbox");
    await screen.findByText("Needs me");
    expect((document.getElementById("rail") as HTMLElement).hidden).toBe(true);
  });

  it("documents the shortcut in the status bar and has separators for the rail and the list", async () => {
    start("inbox");
    await screen.findByText("Needs me");
    expect(within(screen.getByRole("contentinfo")).getByText("sidebar")).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize sidebar" })).toBeTruthy();
    const list = screen.getByRole("separator", { name: "Resize topic list" });
    // 1024 px wide in jsdom: 400 is clamped so the reader keeps 420.
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(window.localStorage.getItem("axiom.pane.inbox-list")).toBe("356");
    expect(document.documentElement.style.getPropertyValue("--pane-inbox-list")).toBe("356px");
  });

  it("marks the current view with aria-current=page and the open topic with aria-current=true", async () => {
    start("inbox", "/topic/run");
    await screen.findByText("Running", { selector: ".row-title" });
    const rail = within(screen.getByRole("navigation", { name: "Mailboxes" }));
    expect(rail.getByRole("link", { name: /^Everything/ }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(rail.getByRole("link", { name: /^Ongoing/ }).getAttribute("aria-current")).toBeNull();
    const row = document.querySelector('a.row[data-slug="run"]');
    expect(row?.getAttribute("aria-current")).toBe("true");
  });

  it("topic rows are links; a modified click opens a tab and does not call /open", async () => {
    start("inbox");
    await screen.findByText("Needs me");
    const row = document.querySelector('a.row[data-slug="ask"]') as HTMLAnchorElement;
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toBe("/topic/ask");
    fireEvent.click(row, { ctrlKey: true });
    fireEvent.click(row, { metaKey: true });
    fireEvent.click(row, { shiftKey: true });
    fireEvent.click(row, { button: 1 });
    expect(opens()).toHaveLength(0);
    fireEvent.click(row);
    await waitFor(() => expect(opens()).toHaveLength(1));
  });

  it("is accessible, and so is its settings page", async () => {
    const loc = start("inbox", "/topic/ask");
    await screen.findByRole("heading", { level: 1, name: "Needs me" });
    await expectAccessible();
    act(() => loc.navigate("/notifications"));
    await screen.findByRole("heading", { level: 1, name: "Notifications" });
    await expectAccessible();
    act(() => loc.navigate("/settings"));
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    await expectAccessible();
  });
});

describe("Board", () => {
  const cardLink = (slug: string) =>
    document.querySelector(`.bd-card[data-slug="${slug}"] .bd-card-title a`) as HTMLAnchorElement;

  it("card titles are links; a modified click does not call /open, neither does one on the card", async () => {
    start("board");
    await screen.findByText("Needs me");
    expect(cardLink("ask").getAttribute("href")).toBe("/topic/ask");
    fireEvent.click(cardLink("ask"), { ctrlKey: true });
    fireEvent.click(cardLink("ask"), { button: 1 });
    fireEvent.click(document.querySelector('.bd-card[data-slug="ask"]') as Element, {
      shiftKey: true,
    });
    expect(opens()).toHaveLength(0);
    fireEvent.click(cardLink("ask"));
    await waitFor(() => expect(opens()).toHaveLength(1));
  });

  it("the sheet is a modal dialog; Escape closes it and focus returns to its card", async () => {
    const loc = start("board");
    await screen.findByText("Needs me");
    const link = cardLink("run");
    link.focus();
    fireEvent.click(link);
    const sheet = await screen.findByRole("dialog");
    expect(sheet.tagName).toBe("DIALOG");
    expect(sheet.hasAttribute("open")).toBe(true);
    expect(loc.history?.at(-1)).toBe("/topic/run");
    expect(
      within(sheet)
        .getByRole("separator", { name: "Resize topic sheet" })
        .getAttribute("aria-valuemin"),
    ).toBe("420");

    press("Escape", sheet);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loc.history?.at(-1)).toBe("/");
    expect(document.activeElement).toBe(cardLink("run"));
  });

  it("Back and Forward close and reopen the sheet and the tray", async () => {
    // Each is a history entry of its own and the page is a function of the URL, so what Back and
    // Forward restore is just the URL they land on.
    const loc = start("board");
    await screen.findByText("Needs me");
    fireEvent.click(cardLink("run"));
    await screen.findByRole("dialog");
    expect(loc.history).toEqual(["/", "/topic/run"]);
    act(() => loc.navigate("/")); // Back
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => loc.navigate("/topic/run")); // Forward
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close topic" }));
    expect(loc.history?.at(-1)).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(loc.history?.at(-1)).toBe("/notifications");
    expect(document.querySelector(".bd-app")?.getAttribute("data-tray")).toBe("open");
    expect(document.title).toBe("(2) Notifications · Axiom");
    act(() => loc.navigate("/")); // Back
    await waitFor(() =>
      expect(document.querySelector(".bd-app")?.getAttribute("data-tray")).toBe("closed"),
    );
  });

  it("Escape closes the tray and focus returns to the Notifications button", async () => {
    const loc = start("board");
    await screen.findByText("Needs me");
    const btn = screen.getByRole("button", { name: /Notifications/ });
    btn.focus();
    fireEvent.click(btn);
    await waitFor(() => expect(document.activeElement?.id).toBe("bd-tray"));
    expect(loc.history?.at(-1)).toBe("/notifications");
    press("Escape");
    await waitFor(() =>
      expect(document.querySelector(".bd-app")?.getAttribute("data-tray")).toBe("closed"),
    );
    expect(document.activeElement).toBe(btn);
    // The closed tray is inert, so its links are not tab stops.
    expect(document.getElementById("bd-tray")?.hasAttribute("inert")).toBe(true);
  });

  it("resizes the tray with its separator", async () => {
    start("board", "/notifications");
    const sep = await screen.findByRole("separator", { name: "Resize notifications" });
    expect(sep.getAttribute("aria-orientation")).toBe("horizontal");
    fireEvent.keyDown(sep, { key: "ArrowUp" });
    expect(window.localStorage.getItem("axiom.pane.board-tray")).toBe("356");
  });

  it("is accessible, with the sheet open and on the settings page", async () => {
    const loc = start("board", "/topic/ask");
    await screen.findByRole("dialog");
    await expectAccessible();
    act(() => loc.navigate("/"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await expectAccessible();
    act(() => loc.navigate("/notifications"));
    await waitFor(() => expect(document.querySelector(".bd-tray-body a")).toBeTruthy());
    await expectAccessible();
    act(() => loc.navigate("/settings"));
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    await expectAccessible();
  });
});

describe("Console", () => {
  it("collapses the sidebar with its button and with [, and remembers it", async () => {
    start("console");
    await screen.findByText("Needs me");
    const side = document.getElementById("cs-side") as HTMLElement;
    const btn = screen.getByRole("button", { name: "Sidebar" });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(side.hidden).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem("axiom.pane.console-side.collapsed")).toBe("1");
    press("[");
    expect(side.hidden).toBe(false);
    press("[", screen.getByLabelText("Filter visible rows"));
    expect(side.hidden).toBe(false);
    expect(
      within(document.querySelector(".cs-keys") as HTMLElement).getByText("sidebar"),
    ).toBeTruthy();
  });

  it("sorts with aria-sort on the sorted column header only", async () => {
    start("console");
    await screen.findByText("Needs me");
    const headers = () =>
      [...document.querySelectorAll("thead th")].map((h) => h.getAttribute("aria-sort"));
    expect(headers().filter(Boolean)).toEqual(["descending"]);
    fireEvent.click(screen.getByRole("button", { name: "Title" }));
    const col = screen.getByRole("columnheader", { name: "Title" });
    expect(col.getAttribute("aria-sort")).toBe("ascending");
    expect(headers().filter(Boolean)).toEqual(["ascending"]);
  });

  it("slugs are links; a modified click does not call /open", async () => {
    start("console");
    await screen.findByText("Needs me");
    const link = within(document.querySelector('tr[data-slug="ask"]') as HTMLElement).getByRole(
      "link",
      { name: "ask" },
    );
    expect(link.getAttribute("href")).toBe("/topic/ask");
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(document.querySelector('tr[data-slug="ask"]') as Element, { metaKey: true });
    expect(opens()).toHaveLength(0);
    fireEvent.click(link);
    await waitFor(() => expect(opens()).toHaveLength(1));
  });

  it("marks the current view with aria-current=page", async () => {
    start("console", "/view/ongoing");
    await screen.findByText("Running");
    const views = within(screen.getByRole("navigation", { name: "Views and piles" }));
    expect(views.getByRole("link", { name: /Ongoing/ }).getAttribute("aria-current")).toBe("page");
    expect(views.getByRole("link", { name: /Everything/ }).getAttribute("aria-current")).toBeNull();
  });

  it("the drawer is the /notifications route: Escape closes it, focus returns, the panel keeps its topic", async () => {
    const loc = start("console", "/topic/ask");
    await screen.findByRole("region", { name: "Selected topic" });
    const btn = screen.getByRole("button", { name: /Notifications/ });
    btn.focus();
    fireEvent.click(btn);
    const drawer = await screen.findByRole("complementary", { name: "Notifications" });
    expect(loc.history?.at(-1)).toBe("/notifications");
    expect(
      within(screen.getByRole("region", { name: "Selected topic" })).getAllByText("Needs me")
        .length,
    ).toBeGreaterThan(0);
    expect(within(drawer).getByRole("separator", { name: "Resize notifications" })).toBeTruthy();
    press("Escape");
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Notifications" })).toBeNull(),
    );
    expect(loc.history?.at(-1)).toBe("/topic/ask");
    expect(document.activeElement).toBe(btn);
  });

  it("resizes the panel height with its separator", async () => {
    start("console", "/topic/ask");
    const sep = await screen.findByRole("separator", { name: "Resize topic panel" });
    fireEvent.keyDown(sep, { key: "ArrowUp", shiftKey: true });
    expect(window.localStorage.getItem("axiom.pane.console-panel")).toBe("444");
    fireEvent.doubleClick(sep);
    expect(window.localStorage.getItem("axiom.pane.console-panel")).toBeNull();
  });

  it("panel tabs use roving focus and arrow keys", async () => {
    start("console", "/topic/ask");
    const tab = await screen.findByRole("tab", { name: "History" });
    expect(tab.tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "Threads" }).tabIndex).toBe(-1);
    tab.focus();
    fireEvent.keyDown(tab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Threads" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Threads" }));
  });

  it("is accessible, with a topic open, the drawer open and on the settings page", async () => {
    const loc = start("console", "/topic/ask");
    await screen.findByRole("region", { name: "Selected topic" });
    await screen.findByText("A plain note");
    await expectAccessible();
    act(() => loc.navigate("/notifications"));
    await screen.findByRole("complementary", { name: "Notifications" });
    await expectAccessible();
    act(() => loc.navigate("/settings"));
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    await expectAccessible();
  });
});

describe("modal surfaces", () => {
  it("the T3 picker is a modal dialog: Escape closes it and focus returns to its button", async () => {
    server.settings.layout = "inbox";
    start("inbox", "/topic/ask");
    const btn = await screen.findByRole("button", { name: "Attach T3 thread" });
    btn.focus();
    fireEvent.click(btn);
    const dlg = await screen.findByRole("dialog", { name: "Attach a T3 thread" });
    expect(dlg.tagName).toBe("DIALOG");
    press("Escape", dlg);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(btn);
  });

  it("the delete confirmation is an alert dialog: Escape cancels it and focus returns", async () => {
    start("inbox", "/topic/ask");
    const del = await screen.findByRole("button", { name: "Delete entry 1" });
    del.focus();
    fireEvent.click(del);
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText("Delete this entry for good?")).toBeTruthy();
    press("Escape", dlg);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(del);
    expect(server.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });
});
