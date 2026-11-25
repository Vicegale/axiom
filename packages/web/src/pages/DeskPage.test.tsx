import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../App";
import type { DeskThread, DeskTopic } from "../api";
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
    // Topic and selected thread share a status here, so it shows once.
    expect(alpha.querySelectorAll(".pill").length).toBe(1);
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

  it("the composer is a collapsed bar on every card until asked for", async () => {
    start();
    const alpha = within(await screen.findByRole("article", { name: "Alpha" }));
    expect(alpha.queryByRole("textbox")).toBeNull();
    expect(alpha.queryByRole("button", { name: "Reply" })).toBeNull();
    const bar = alpha.getByRole("button", { name: /^Reply to/ });
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(bar);
    const box = await alpha.findByRole("textbox", { name: /^Message to/ });
    expect(document.activeElement).toBe(box);
    fireEvent.click(alpha.getByRole("button", { name: "Collapse" }));
    expect(alpha.queryByRole("textbox")).toBeNull();
    expect(alpha.getByRole("button", { name: /^Reply to/ })).toBeTruthy();
  });

  it("`r` on a focused card expands its composer, but not while typing in a field", async () => {
    start();
    const alpha = within(await screen.findByRole("article", { name: "Alpha" }));
    const star = alpha.getByRole("button", { name: /^Favourite/ });
    star.focus();
    fireEvent.keyDown(star, { key: "r" });
    const box = await alpha.findByRole("textbox", { name: /^Message to/ });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "r" });
    expect(alpha.getByRole("textbox", { name: /^Message to/ })).toBe(box);
    // another card is untouched
    expect(within(card("Charlie")).queryByRole("textbox")).toBeNull();
  });

  it("shows Generating… with placeholder lines, or the previous summary dimmed with Updating…", async () => {
    server.desk = [
      deskTopic({
        slug: "gen",
        title: "Gen",
        threads: [deskThread({ id: 7, hasReply: true, summaryPending: true })],
      }),
      deskTopic({
        slug: "upd",
        title: "Upd",
        threads: [
          deskThread({
            id: 8,
            hasReply: true,
            summaryPending: true,
            summary: { now: "Old summary", next: "Nothing", at: null },
          }),
        ],
      }),
    ];
    start();
    const gen = await screen.findByRole("article", { name: "Gen" });
    expect(within(gen).getByText("Generating…")).toBeTruthy();
    expect(gen.querySelector(".dk-skel")).not.toBeNull();
    const upd = within(card("Upd"));
    expect(upd.getByText("Updating…")).toBeTruthy();
    expect(upd.getByText("Old summary").closest(".dk-stale")).not.toBeNull();
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

  it("shows the bell count and provider health, and has an enabled New topic button", async () => {
    server.notifications = [notification({ id: 1, topicSlug: "charlie" })];
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const bell = await screen.findByRole("link", { name: "Notifications, 1" });
    expect(bell.getAttribute("href")).toBe("/notifications");
    expect(await screen.findByText("T3 ready")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "+ New topic" }) as HTMLButtonElement).disabled,
    ).toBe(false);
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

describe("the live activity line", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const setActivity = (a: { text: string; at: string } | null, status = "wip") => {
    const threads = server.desk[0]?.threads ?? [];
    Object.assign(threads[1] ?? {}, { activity: a, status });
  };
  const run = (name = "Alpha") =>
    within(card(name))
      .getByText(/^running/, { selector: ".dk-runtext" })
      .closest(".dk-run");

  it("shows 'running · <step>' with a pulsing dot while the thread runs, the full text in the title", async () => {
    setActivity({ text: "$ npm test -- --run", at: ago(2000) });
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const line = run() as HTMLElement;
    expect(line.classList.contains("live")).toBe(true);
    expect(line.textContent).toContain("running · $ npm test -- --run");
    expect(line.querySelector(".dk-runtext")?.getAttribute("title")).toBe(
      "running · $ npm test -- --run",
    );
    expect(line.querySelector("time")).toBeNull(); // a fresh step carries no age
  });

  it("keeps a long step on one line, with the whole text available in the title", async () => {
    const long = `$ ${"very-long-command ".repeat(30)}`.trim();
    setActivity({ text: long, at: ago(1000) });
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const text = (run() as HTMLElement).querySelector(".dk-runtext") as HTMLElement;
    expect(text.getAttribute("title")).toBe(`running · ${long}`);
    expect(text.querySelectorAll("br")).toHaveLength(0);
  });

  it("adds how old the step is once it is more than about ten seconds old", async () => {
    setActivity({ text: "Reading app.ts", at: ago(45_000) });
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const time = (run() as HTMLElement).querySelector("time") as HTMLElement;
    expect(time.textContent).toMatch(/^· 4\ds ago$/);
  });

  it("says plain 'running' when there is no step yet", async () => {
    setActivity(null);
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const line = within(card("Alpha")).getByText("running", { selector: ".dk-runtext" });
    expect(line.closest(".dk-run")?.classList.contains("live")).toBe(false);
  });

  it("shows the finished line, not the step, when the thread is not running", async () => {
    setActivity({ text: "$ npm test", at: ago(5000) }, "idle");
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const line = card("Alpha").querySelector(".dk-run") as HTMLElement;
    expect(line.textContent).toMatch(/^finished /);
    expect(line.textContent).not.toContain("npm test");
    expect(line.classList.contains("live")).toBe(false);
  });

  it("updates live when the server announces a change", async () => {
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
    setActivity({ text: "Reading a.ts", at: ago(1000) });
    start();
    await screen.findByRole("article", { name: "Alpha" });
    expect(run()?.textContent).toContain("Reading a.ts");
    setActivity({ text: "Editing b.ts", at: ago(500) });
    await act(async () => {
      for (const f of ES.last?.fns.get("change") ?? []) f();
    });
    await waitFor(() => expect(run()?.textContent).toContain("Editing b.ts"));
  });

  it("is accessible and the pulse respects reduced motion", async () => {
    setActivity({ text: "Thinking: weighing the options", at: ago(1000) });
    start();
    await screen.findByRole("article", { name: "Alpha" });
    await expectAccessible(document.body);
    const css = readFileSync(join(process.cwd(), "packages/web/src/styles/desk.css"), "utf8");
    expect(css).toMatch(
      /prefers-reduced-motion[^{]*\{[\s\S]*\.dk-run\.live \.dk-rundot \{ animation: none/,
    );
  });
});

describe("model, effort and context", () => {
  const setRuntime = (r: Partial<NonNullable<DeskThread["runtime"]>> | null) => {
    const th = server.desk[0]?.threads[1];
    if (th) {
      th.runtime = r && {
        model: null,
        effort: null,
        contextUsed: null,
        contextMax: null,
        at: "2026-11-25T10:00:00Z",
        ...r,
      };
    }
  };
  const runtime = () => card("Alpha").querySelector(".dk-runtime") as HTMLElement | null;

  it("shows nothing while the thread's runtime is unknown", async () => {
    start();
    await screen.findByRole("article", { name: "Alpha" });
    expect(runtime()).toBeNull();
    expect(within(card("Alpha")).queryByRole("meter")).toBeNull();
  });

  it("shows the model's name, the effort and a context meter", async () => {
    setRuntime({
      model: "claude-opus-5-5",
      effort: "high",
      contextUsed: 190_000,
      contextMax: 1_000_000,
    });
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const r = runtime() as HTMLElement;
    expect(r.textContent).toContain("Opus 5.5 · high");
    expect(r.querySelector(".dk-model")?.getAttribute("title")).toBe(
      "claude-opus-5-5 · effort high",
    );
    expect(r.textContent).toContain("190k / 1M");
    const meter = within(card("Alpha")).getByRole("meter", { name: "Context used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("190000");
    expect(meter.getAttribute("aria-valuemin")).toBe("0");
    expect(meter.getAttribute("aria-valuemax")).toBe("1000000");
    expect(meter.getAttribute("aria-valuetext")).toBe("190k of 1M");
    expect(meter.getAttribute("data-level")).toBe("ok");
    expect((meter.firstElementChild as HTMLElement).style.width).toBe("19%");
    expect(meter.closest(".dk-ctx")?.getAttribute("title")).toBe(
      "Context: 190,000 of 1,000,000 tokens (19%)",
    );
  });

  it("turns amber above 80 % and red above 95 %", async () => {
    const level = async (used: number) => {
      setRuntime({ model: "claude-opus-5-5", contextUsed: used, contextMax: 1_000_000 });
      const { unmount } = render(<App router={{ hook: memoryLocation({ path: "/desk" }).hook }} />);
      await screen.findAllByRole("article", { name: "Alpha" });
      const l = screen.getByRole("meter").getAttribute("data-level");
      unmount();
      return l;
    };
    expect(await level(800_000)).toBe("ok");
    expect(await level(800_001)).toBe("warn");
    expect(await level(950_000)).toBe("warn");
    expect(await level(950_001)).toBe("full");
    expect(await level(2_000_000)).toBe("full"); // never past the end of the bar
  });

  it("shows only the tokens, no bar, when the window size is unknown", async () => {
    setRuntime({ model: "gpt-5.4", contextUsed: 12_345 });
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const r = runtime() as HTMLElement;
    expect(r.textContent).toContain("gpt-5.4");
    expect(r.textContent).toContain("12k ctx");
    expect(within(card("Alpha")).queryByRole("meter")).toBeNull();
    expect(r.querySelector(".dk-ctx")?.getAttribute("title")).toBe(
      "Context: 12,345 tokens (window size unknown)",
    );
  });

  it("shows just the model when nothing is known of the context, and just the effort without one", async () => {
    setRuntime({ model: "claude-sonnet-5-5" });
    start();
    await screen.findByRole("article", { name: "Alpha" });
    expect((runtime() as HTMLElement).textContent).toBe("Sonnet 5.5");
    expect(runtime()?.querySelector(".dk-ctx")).toBeNull();
  });

  it("is accessible", async () => {
    setRuntime({
      model: "claude-opus-5-5",
      effort: "high",
      contextUsed: 900_000,
      contextMax: 1_000_000,
    });
    start();
    await screen.findByRole("article", { name: "Alpha" });
    await expectAccessible();
  });
});

describe("the subagent tree on the card", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const setSubagents = (list: DeskThread["subagents"], index = 1) => {
    const th = server.desk[0]?.threads[index];
    if (th) th.subagents = list;
  };
  const sub = (
    over: Partial<DeskThread["subagents"][number]>,
  ): DeskThread["subagents"][number] => ({
    id: 1,
    parentId: null,
    title: null,
    agentType: null,
    model: null,
    progress: null,
    status: "running",
    startedAt: minutesAgo(3),
    endedAt: null,
    ...over,
  });
  // Two running, the second nested under the first (Claude Code and T3 style).
  const two = (): DeskThread["subagents"] => [
    sub({ id: 1, title: "Check the schema", agentType: "Explore", startedAt: minutesAgo(12) }),
    sub({
      id: 2,
      parentId: 1,
      title: "Review the diff",
      model: "claude-haiku-5",
      progress: "Reading reader.ts",
      startedAt: minutesAgo(3),
    }),
  ];
  const mixed = (): DeskThread["subagents"] => [
    sub({
      id: 1,
      title: "Explore the repo",
      agentType: "Explore",
      status: "done",
      startedAt: minutesAgo(9),
      endedAt: minutesAgo(5),
    }),
    sub({
      id: 2,
      title: "Run the checks",
      status: "failed",
      progress: "stale step",
      startedAt: minutesAgo(8),
      endedAt: minutesAgo(2),
    }),
    sub({
      id: 3,
      parentId: 2,
      title: "Retry",
      status: "cancelled",
      startedAt: minutesAgo(4),
      endedAt: minutesAgo(3),
    }),
  ];
  const button = () =>
    within(card("Alpha")).queryByRole("button", { name: /\d+ subagents?/ }) as HTMLElement | null;
  const tree = () => card("Alpha").querySelector(".dk-agents");

  it("shows nothing when there are none", async () => {
    start();
    await screen.findByRole("article", { name: "Alpha" });
    expect(button()).toBeNull();
    expect(tree()).toBeNull();
    expect(card("Alpha").querySelector(".dk-run")?.textContent).toBe("running");
  });

  it("is open while a subagent runs: the thread on top, nested ones indented, with their dots", async () => {
    setSubagents(two());
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const run = card("Alpha").querySelector(".dk-run") as HTMLElement;
    expect(run.textContent).toBe("running ·2 subagents");
    const btn = button() as HTMLElement;
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const list = within(card("Alpha")).getByRole("list", { name: /^Agents of / });
    expect(btn.getAttribute("aria-controls")).toBe(tree()?.id);
    // The root row is the thread, then each subagent; the nested one sits one list deeper.
    const rows = [...list.querySelectorAll(".dk-tr")];
    expect(rows.map((r) => r.textContent)).toEqual([
      "Newer threadrunning",
      "running: Check the schemaExplore · 12 min",
      "running: Review the diffHaiku 5 · 3 min",
    ]);
    expect(rows[0]?.querySelector(".dk-tdot")?.className).toContain("s-wip");
    expect(rows[1]?.querySelector(".dk-tdot")?.getAttribute("data-s")).toBe("running");
    const nested = rows[2]?.closest("li");
    expect(nested?.parentElement?.closest("li")).toBe(rows[1]?.closest("li"));
    expect(card("Alpha").querySelector(".dk-tstep")?.textContent).toBe("Reading reader.ts");
  });

  it("keeps the newest step and puts the button after it", async () => {
    setSubagents(two());
    const th = server.desk[0]?.threads[1];
    if (th) th.activity = { text: "Reading app.ts", at: minutesAgo(0) };
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const run = card("Alpha").querySelector(".dk-run") as HTMLElement;
    expect(run.textContent).toContain("running · Reading app.ts");
    expect(run.lastElementChild).toBe(button());
  });

  it("can be folded while running, and stays folded", async () => {
    setSubagents(two());
    start();
    await screen.findByRole("article", { name: "Alpha" });
    fireEvent.click(button() as HTMLElement);
    expect(button()?.getAttribute("aria-expanded")).toBe("false");
    expect(tree()).toBeNull();
    fireEvent.click(button() as HTMLElement);
    expect(tree()).not.toBeNull();
  });

  it("folds to a one-line summary when all have finished, and opens on the button", async () => {
    setSubagents(mixed().filter((s) => s.status === "done"));
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const btn = button() as HTMLElement;
    expect(btn.textContent).toBe("1 subagent · done");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(tree()).toBeNull();
    // The thread's own line says what the thread is doing, not what the subagents did.
    expect(card("Alpha").querySelector(".dk-run")?.textContent).toMatch(/^running/);
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(tree()?.querySelectorAll(".dk-tr")).toHaveLength(2);
    fireEvent.click(btn);
    expect(tree()).toBeNull();
  });

  it("marks failed and cancelled ones in words and colour, times finished ones by their run, no step", async () => {
    setSubagents(mixed());
    start();
    await screen.findByRole("article", { name: "Alpha" });
    expect(button()?.textContent).toBe("3 subagents · 1 failed, 1 cancelled");
    fireEvent.click(button() as HTMLElement);
    const rows = [...(tree()?.querySelectorAll(".dk-tr") ?? [])];
    expect(rows.slice(1).map((r) => r.textContent)).toEqual([
      "done: Explore the repoExplore · 4 min",
      "failed: Run the checks6 min",
      "cancelled: Retry1 min",
    ]);
    expect(rows.slice(1).map((r) => r.querySelector(".dk-tdot")?.getAttribute("data-s"))).toEqual([
      "done",
      "failed",
      "cancelled",
    ]);
    // A finished subagent shows no latest step.
    expect(tree()?.querySelector(".dk-tstep")).toBeNull();
  });

  it("names an untitled subagent by its type and says `waiting on` for an idle thread", async () => {
    setSubagents([sub({ id: 5, agentType: "Explore", startedAt: minutesAgo(0) })], 0);
    start();
    await screen.findByRole("article", { name: "Alpha" });
    // The newest thread (the one shown) has none; pick the older one, which has one.
    fireEvent.change(within(card("Alpha")).getByRole("combobox"), { target: { value: "1" } });
    const run = card("Alpha").querySelector(".dk-run") as HTMLElement;
    expect(run.textContent).toBe("waiting on1 subagent");
    expect(card("Alpha").querySelectorAll(".dk-tr")[1]?.textContent).toBe("running: Explore<1 min");
  });

  it("is accessible, open, folded and with every status", async () => {
    setSubagents(two());
    start();
    await screen.findByRole("article", { name: "Alpha" });
    await expectAccessible();
    fireEvent.click(button() as HTMLElement);
    await expectAccessible();
    cleanup();
    setSubagents(mixed());
    start();
    await screen.findByRole("article", { name: "Alpha" });
    await expectAccessible();
    fireEvent.click(button() as HTMLElement);
    await expectAccessible();
  });
});

describe("the Artifacts menu on the card", () => {
  const artifacts = [
    { id: 11, kind: "artifact", target: "docs/plan.md", label: "Plan", description: "The plan" },
    {
      id: 12,
      kind: "artifact",
      target: "https://example.com/r.pdf",
      label: null,
      description: null,
    },
  ];

  it("appears next to the link count when the topic has artifacts", async () => {
    patch(0, { artifacts });
    start();
    await screen.findByRole("article", { name: "Alpha" });
    const button = within(card("Alpha")).getByRole("button", { name: "Artifacts · 2" });
    expect(button.closest(".dk-links")?.textContent).toContain("3 links");
    const menu = within(card("Alpha")).getByRole("menu", { hidden: true });
    const items = within(menu).getAllByRole("menuitem", { hidden: true });
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute("href")).toBe("/topic/alpha/doc/11");
    expect(items[0]?.textContent).toContain("The plan");
  });

  it("is absent when the topic has none", async () => {
    start();
    await screen.findByRole("article", { name: "Alpha" });
    expect(within(card("Alpha")).queryByRole("button", { name: /^Artifacts/ })).toBeNull();
  });

  it("is accessible", async () => {
    patch(0, { artifacts });
    start();
    await screen.findByRole("article", { name: "Alpha" });
    await expectAccessible();
  });
});
