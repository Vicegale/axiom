import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../App";
import type { DeskTopic } from "../api";
import { expectAccessible } from "../test/axe";
import { deskThread, deskTopic, FakeServer, notification } from "../test/fakeApi";
import { seedTracker } from "../test/seed";

let server: FakeServer;

beforeEach(() => {
  window.localStorage.clear();
  document.title = "";
  server = new FakeServer();
  seedTracker(server);
  server.desk = [
    deskTopic({
      slug: "alpha",
      title: "Alpha",
      status: "wip",
      lastWorkedAt: "2026-11-25T09:00:00Z",
      taskCounts: { total: 8, done: 5 },
      linkCount: 3,
      threads: [
        deskThread({
          id: 1,
          title: "Older thread",
          status: "idle",
          lastReplyAt: "2026-11-20T09:00:00Z",
          hasReply: true,
          summary: { now: "Older now", next: "Nothing", at: null },
        }),
        deskThread({
          id: 2,
          title: "Newer thread",
          status: "wip",
          lastReplyAt: "2026-11-24T09:00:00Z",
          hasReply: true,
          summary: { now: "Newer now", next: "Choose a colour", at: null },
        }),
      ],
    }),
    deskTopic({
      slug: "bravo",
      title: "Bravo",
      status: "idle",
      lastWorkedAt: "2026-11-24T09:00:00Z",
    }),
    deskTopic({
      slug: "charlie",
      title: "Charlie",
      status: "hitl",
      highlighted: true,
      lastWorkedAt: "2026-11-23T09:00:00Z",
      threads: [deskThread({ id: 3, status: "hitl", summaryError: "Summary timed out" })],
    }),
    deskTopic({
      slug: "delta",
      title: "Delta",
      deskHidden: true,
      lastWorkedAt: "2026-11-22T09:00:00Z",
    }),
  ];
  server.replies.set(1, { text: "Older reply", at: null });
  server.replies.set(2, {
    text: "# Plan\n\nIt is **done** now.\n\n- one\n- two",
    at: "2026-11-24T09:00:00Z",
  });
  server.install();
});
afterEach(() => vi.unstubAllGlobals());

const patch = (i: number, p: Partial<DeskTopic>) => Object.assign(server.desk[i] ?? {}, p);

function start(path = "/desk") {
  const loc = memoryLocation({ path, record: true });
  render(<App router={{ hook: loc.hook }} />);
  return loc;
}

const titles = () =>
  [...document.querySelectorAll<HTMLElement>("article h2")].map((h) => h.textContent);
const card = (title: string) => screen.getByRole("article", { name: title });

describe("the Desk", () => {
  it("shows the Desk with its title, landmarks and one card per visible topic", async () => {
    start();
    await screen.findByRole("article", { name: "Alpha" });
    expect(screen.getByRole("heading", { level: 1, name: "Desk" })).toBeTruthy();
    await waitFor(() => expect(document.title).toMatch(/Desk · Axiom$/));
    expect(screen.getByRole("main")).toBeTruthy();
    expect(document.querySelector(".dk-app > header")).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(3);
    // Alpha (wip) and Bravo (idle) and Charlie (hitl) are active; Delta is hidden.
    expect(screen.getByText("3 active")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Tracker" }).getAttribute("href")).toBe("/");
  });

  it("is reachable from each tracker layout", async () => {
    for (const layout of ["inbox", "board", "console"] as const) {
      server.settings.layout = layout;
      const { unmount } = render(<App router={{ hook: memoryLocation({ path: "/" }).hook }} />);
      const link = await screen.findByRole("link", { name: /^Desk$/ });
      expect(link.getAttribute("href")).toBe("/desk");
      unmount();
    }
  });

  it("is accessible", async () => {
    start();
    await screen.findByRole("article", { name: "Alpha" });
    await expectAccessible();
  });

  it("sorts Ready first by default: owner-next topics, then the rest by last worked", async () => {
    start();
    await screen.findByRole("article", { name: "Alpha" });
    // Charlie waits for the owner and Alpha's newest thread has a next step.
    expect(titles()).toEqual(["Alpha", "Charlie", "Bravo"]);
  });

  it("puts favourites first, and the favourite button calls the API", async () => {
    start();
    await screen.findByRole("article", { name: "Alpha" });
    fireEvent.click(within(card("Bravo")).getByRole("button", { name: "Favourite Bravo" }));
    await waitFor(() =>
      expect(server.called("POST", "/api/topics/bravo/favorite")[0]?.body).toEqual({ on: true }),
    );
    await waitFor(() => expect(titles()[0]).toBe("Bravo"));
    expect(
      within(card("Bravo"))
        .getByRole("button", { name: "Favourite Bravo" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("Fixed follows the saved drag order, and the choice is remembered", async () => {
    patch(1, { deskOrder: 0 }); // bravo
    patch(0, { deskOrder: 1 }); // alpha
    start();
    await screen.findByRole("article", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Fixed" }));
    expect(titles()).toEqual(["Bravo", "Alpha", "Charlie"]);
    expect(window.localStorage.getItem("axiom.desk.sort")).toBe("fixed");
  });

  it("restores the remembered sort", async () => {
    window.localStorage.setItem("axiom.desk.sort", "fixed");
    patch(1, { deskOrder: 0 });
    start();
    await screen.findByRole("article", { name: "Bravo" });
    expect(screen.getByRole("button", { name: "Fixed" }).getAttribute("aria-pressed")).toBe("true");
    expect(titles()[0]).toBe("Bravo");
  });

  it("sets cards per row, remembered", async () => {
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const app = document.querySelector(".dk-app") as HTMLElement;
    expect(app.dataset.perRow).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    expect(app.dataset.perRow).toBe("4");
    fireEvent.click(screen.getByRole("button", { name: "N" }));
    expect(app.dataset.perRow).toBe("n");
    expect(window.localStorage.getItem("axiom.desk.perRow")).toBe("n");
  });

  it("hides a topic from the Desk and brings it back from the hidden list", async () => {
    start();
    await screen.findByRole("article", { name: "Alpha" });
    expect(screen.getByRole("button", { name: "1 hidden" })).toBeTruthy();
    fireEvent.click(within(card("Bravo")).getByRole("button", { name: /^Hide Bravo/ }));
    await waitFor(() => expect(titles()).not.toContain("Bravo"));
    expect(server.called("POST", "/api/topics/bravo/desk-hidden")[0]?.body).toEqual({
      hidden: true,
    });

    fireEvent.click(await screen.findByRole("button", { name: "2 hidden" }));
    fireEvent.click(screen.getByRole("button", { name: "Unhide Delta" }));
    await waitFor(() => expect(titles()).toContain("Delta"));
    expect(server.called("POST", "/api/topics/delta/desk-hidden")[0]?.body).toEqual({
      hidden: false,
    });
  });

  it("moves a card with the keyboard and saves the order", async () => {
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const handle = within(card("Alpha")).getByRole("button", { name: "Move Alpha" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(titles()).toEqual(["Charlie", "Alpha", "Bravo"]);
    // Nothing is saved until Enter drops it.
    expect(server.called("PUT", "/api/desk/order")).toHaveLength(0);
    fireEvent.keyDown(within(card("Alpha")).getByRole("button", { name: "Move Alpha" }), {
      key: "ArrowRight",
    });
    fireEvent.keyDown(within(card("Alpha")).getByRole("button", { name: "Move Alpha" }), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(server.called("PUT", "/api/desk/order")[0]?.body).toEqual({
        slugs: ["Charlie", "Bravo", "Alpha"].map((t) => t.toLowerCase()),
      }),
    );
    // Dragging from Ready first switches to Fixed with that order.
    expect(screen.getByRole("button", { name: "Fixed" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(titles()).toEqual(["Charlie", "Bravo", "Alpha"]));
  });

  it("Escape puts a moved card back and saves nothing", async () => {
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const handle = within(card("Alpha")).getByRole("button", { name: "Move Alpha" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(titles()[1]).toBe("Alpha");
    fireEvent.keyDown(within(card("Alpha")).getByRole("button", { name: "Move Alpha" }), {
      key: "Escape",
    });
    expect(titles()).toEqual(["Alpha", "Charlie", "Bravo"]);
    expect(server.called("PUT", "/api/desk/order")).toHaveLength(0);
  });

  it("moves a card by pointer: the card under the pointer takes its place", async () => {
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const rects: Record<string, DOMRect> = {
      alpha: new DOMRect(0, 0, 100, 100),
      charlie: new DOMRect(110, 0, 100, 100),
      bravo: new DOMRect(220, 0, 100, 100),
    };
    for (const el of document.querySelectorAll<HTMLElement>("[data-slug]")) {
      el.getBoundingClientRect = () => rects[el.dataset.slug ?? ""] ?? new DOMRect();
    }
    const handle = within(card("Alpha")).getByRole("button", { name: "Move Alpha" });
    fireEvent.pointerDown(handle, { button: 0 });
    fireEvent(window, new MouseEvent("pointermove", { clientX: 250, clientY: 50 }));
    await waitFor(() => expect(titles()).toEqual(["Charlie", "Bravo", "Alpha"]));
    fireEvent(window, new MouseEvent("pointerup"));
    await waitFor(() =>
      expect(server.called("PUT", "/api/desk/order")[0]?.body).toEqual({
        slugs: ["charlie", "bravo", "alpha"],
      }),
    );
  });

  it("shows the card: pills, progress, links, thread run line and Now with an emphasised next", async () => {
    start();
    const alpha = await screen.findByRole("article", { name: "Alpha" });
    const a = within(alpha);
    expect(a.getByText("5/8 done")).toBeTruthy();
    expect(a.getByText("3 links")).toBeTruthy();
    expect(alpha.querySelectorAll(".pill").length).toBe(2);
    // The most recently active thread is selected by default.
    expect((a.getByLabelText("Thread") as HTMLSelectElement).value).toBe("2");
    expect(a.getByText("running")).toBeTruthy();
    expect(a.getByText("Newer now")).toBeTruthy();
    expect(a.getByText("Choose a colour")).toBeTruthy();
    // No next step: nothing emphasised; no summary: muted note; error: its text.
    const bravo = within(card("Bravo"));
    expect(bravo.getByText("No tasks yet")).toBeTruthy();
    expect(bravo.getByText("0 links")).toBeTruthy();
    expect(within(card("Charlie")).getByText("Summary timed out")).toBeTruthy();
    expect(within(card("Charlie")).getByText("waiting for you")).toBeTruthy();
  });

  it("the thread selector switches Now, the run line and the reply", async () => {
    start();
    const alpha = within(await screen.findByRole("article", { name: "Alpha" }));
    fireEvent.change(alpha.getByLabelText("Thread"), { target: { value: "1" } });
    expect(alpha.getByText("Older now")).toBeTruthy();
    expect(alpha.queryByText("Choose a colour")).toBeNull(); // next is "Nothing"
    expect(alpha.getByText(/^finished/)).toBeTruthy();
    fireEvent.click(alpha.getByRole("button", { name: /Latest reply/ }));
    expect(await alpha.findByText("Older reply")).toBeTruthy();
  });

  it("fetches the reply on first expand and renders it as Markdown", async () => {
    start();
    const alpha = within(await screen.findByRole("article", { name: "Alpha" }));
    expect(server.called("GET", "/api/threads/2/reply")).toHaveLength(0);
    const toggle = alpha.getByRole("button", { name: /Latest reply/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const strong = await alpha.findByText("done");
    expect(strong.tagName).toBe("STRONG");
    expect(alpha.getByRole("heading", { name: /Plan/ })).toBeTruthy();
    expect(alpha.getAllByRole("listitem").length).toBeGreaterThanOrEqual(2);
    expect(server.called("GET", "/api/threads/2/reply")).toHaveLength(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("the Reply button toggles the reply region (the stub until D3)", async () => {
    start();
    const alpha = within(await screen.findByRole("article", { name: "Alpha" }));
    expect(alpha.queryByText(/Replying arrives with D3/)).toBeNull();
    const reply = alpha.getByRole("button", { name: "Reply" });
    fireEvent.click(reply);
    expect(alpha.getByText(/Replying arrives with D3/)).toBeTruthy();
    expect(reply.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(reply);
    expect(alpha.queryByText(/Replying arrives with D3/)).toBeNull();
  });

  it("highlights a card like the tracker, and opening its topic marks it opened", async () => {
    start();
    const charlie = await screen.findByRole("article", { name: "Charlie" });
    expect(charlie.className).toContain("hl");
    expect(card("Alpha").className).not.toContain("hl");
    const title = within(charlie).getByRole("link", { name: "Charlie" });
    expect(title.getAttribute("href")).toBe("/topic/charlie");
    const open = within(charlie).getByRole("link", { name: "Open Charlie" });
    expect(open.getAttribute("href")).toBe("/topic/charlie");
    fireEvent.click(open, { ctrlKey: true });
    expect(server.called("POST", "/api/topics/charlie/open")).toHaveLength(0);
    fireEvent.click(open);
    await waitFor(() => expect(server.called("POST", "/api/topics/charlie/open")).toHaveLength(1));
  });

  it("shows the bell count and provider health, and has a disabled New topic placeholder", async () => {
    server.notifications = [notification({ id: 1, topicSlug: "charlie" })];
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const bell = await screen.findByRole("link", { name: "Notifications, 1" });
    expect(bell.getAttribute("href")).toBe("/notifications");
    expect(await screen.findByText("T3 ready")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "+ New topic" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("refetches on a server change and keeps the open reply", async () => {
    class ES {
      static last: ES | undefined;
      fns = new Map<string, (() => void)[]>();
      constructor() {
        ES.last = this;
      }
      addEventListener(t: string, f: () => void) {
        this.fns.set(t, [...(this.fns.get(t) ?? []), f]);
      }
      close() {}
    }
    vi.stubGlobal("EventSource", ES);
    start();
    const alpha = within(await screen.findByRole("article", { name: "Alpha" }));
    fireEvent.click(alpha.getByRole("button", { name: /Latest reply/ }));
    await alpha.findByText("done");
    patch(1, { title: "Bravo renamed" });
    await act(async () => {
      for (const f of ES.last?.fns.get("change") ?? []) f();
    });
    await screen.findByRole("article", { name: "Bravo renamed" });
    expect(within(card("Alpha")).getByText("done")).toBeTruthy();
  });
});
