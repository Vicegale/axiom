import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../App";
import type { StewardSettings, StewardView } from "../api";
import { expectAccessible } from "../test/axe";
import { FakeServer, stewardItem } from "../test/fakeApi";
import { seedTracker } from "../test/seed";

let server: FakeServer;

function start(path = "/steward") {
  render(<App router={{ hook: memoryLocation({ path }).hook }} />);
}

const wake = {
  id: 1,
  trigger: "timer" as const,
  triggerDetail: null,
  startedAt: "2026-11-25T14:00:00.000Z",
  endedAt: "2026-11-25T14:01:00.000Z",
  status: "done" as const,
  error: null,
  tokens: 133_000,
  summary: "2 findings · 1 question",
  stages: [
    {
      runId: 1,
      stage: "gather",
      model: "claude-haiku-5-5",
      effort: "low" as const,
      status: "done" as const,
      error: null,
      tokens: 90_000,
      did: "4 items read",
    },
    {
      runId: 2,
      stage: "decide",
      model: "claude-sonnet-5-5",
      effort: "low" as const,
      status: "done" as const,
      error: null,
      tokens: 43_000,
      did: "2 findings, 1 question",
    },
  ],
};

function fill(): StewardView {
  const v = server.steward;
  v.enabled = true;
  server.settings.steward.enabled = true;
  v.nextWakeAt = "2026-11-25T14:30:00.000Z";
  v.brief = { text: "CI broke on alpha.", at: wake.endedAt, wake };
  v.blindSpots = [{ kind: "source unreachable", text: "Slack is unreachable", ref: "slack" }];
  v.sources.slack = { on: true, ok: false, reason: "Slack is unreachable" };
  v.needs = [
    stewardItem({
      id: 10,
      kind: "finding",
      level: "urgent",
      title: "CI failed on alpha#214",
      body: "The snapshot has no row.",
      topicSlug: "alpha",
      notified: true,
    }),
    stewardItem({ id: 11, kind: "finding", level: "attention", title: "No reviewer" }),
  ];
  v.questions = [stewardItem({ id: 20, kind: "question", title: "Skip Slack on this machine?" })];
  v.info = [
    stewardItem({
      id: 30,
      kind: "finding",
      level: "info",
      title: "Moved Alpha to done",
      topicSlug: "alpha",
      action: {
        id: 7,
        itemId: 30,
        kind: "status change",
        data: { topic: "alpha", from: "review", to: "done" },
        doneAt: wake.endedAt,
        undoneAt: null,
      },
    }),
  ];
  v.usage = [
    { family: "haiku", models: ["claude-haiku-5-5"], runs: 1, used: 1_210_000, cap: 5_000_000 },
    { family: "sonnet", models: [], runs: 0, used: 0, cap: 1_500_000 },
  ];
  v.wakes = [wake];
  return v;
}

beforeEach(() => {
  window.localStorage.clear();
  document.title = "";
  server = new FakeServer();
  seedTracker(server);
  server.install();
});
afterEach(() => vi.unstubAllGlobals());

describe("the Steward page", () => {
  it("shows the brief, what needs the owner, good to know, usage and wakes", async () => {
    fill();
    start();
    expect(await screen.findByText("CI broke on alpha.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Steward" })).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByText("Blind spot")).toBeTruthy();
    const needs = screen.getByRole("region", { name: "Needs you" });
    expect(within(needs).getByText("Urgent")).toBeTruthy();
    expect(within(needs).getByText("desktop notified")).toBeTruthy();
    const link = within(needs).getByRole("link", { name: "alpha" });
    expect(link.getAttribute("href")).toBe("/topic/alpha");
    expect(within(needs).getByText("Skip Slack on this machine?")).toBeTruthy();
    // 2 findings + 1 question, in the heading's count and the switch.
    expect(within(needs).getByText("3")).toBeTruthy();
    const know = screen.getByRole("region", { name: "Good to know" });
    expect(within(know).getByText("by Steward")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Ready for you" })).toBeTruthy();
    const use = screen.getByRole("region", { name: "Token use today" });
    expect(within(use).getByText("1.21M / 5M")).toBeTruthy();
    expect(within(use).getByRole("progressbar", { name: "Haiku tokens today" })).toBeTruthy();
    const wakes = screen.getByRole("region", { name: "Wakes" });
    expect(within(wakes).getByText(/2 findings · 1 question/)).toBeTruthy();
    expect(within(wakes).getByText("133k")).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Steward on/ }).textContent).toMatch(
      /next \d\d:\d\d/,
    );
  });

  it("is accessible", async () => {
    fill();
    start();
    await screen.findByText("CI broke on alpha.");
    await expectAccessible();
  });

  it("folds the wake's stages behind a disclosure", async () => {
    fill();
    start();
    const button = await screen.findByRole("button", { name: /wake \d\d:\d\d · 133k tokens/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const table = screen.getByRole("table");
    expect(within(table).getByText("1 Gather and summarise")).toBeTruthy();
    expect(within(table).getByText("claude-sonnet-5-5 low")).toBeTruthy();
    expect(button.getAttribute("aria-controls")).toBe(
      table.closest("[id]")?.getAttribute("id") ?? "",
    );
  });

  it("answers a question in place: the field is focused, Escape cancels, Send posts", async () => {
    fill();
    start();
    const answer = await screen.findByRole("button", {
      name: "Answer: Skip Slack on this machine?",
    });
    fireEvent.click(answer);
    const field = screen.getByRole("textbox", { name: /Your answer to: Skip Slack/ });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Answer: Skip Slack on this machine?" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Answer: Skip Slack on this machine?" }));
    const again = screen.getByRole("textbox", { name: /Your answer/ });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(again, { target: { value: "Yes, skip it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(server.called("POST", "/api/steward/items/20/answer")[0]?.body).toEqual({
        text: "Yes, skip it",
      }),
    );
    await waitFor(() => expect(screen.queryByText("Skip Slack on this machine?")).toBeNull());
  });

  it("dismisses a finding and undoes Steward's status change", async () => {
    fill();
    start();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss: No reviewer" }));
    await waitFor(() =>
      expect(server.called("POST", "/api/steward/items/11/dismiss")).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByText("No reviewer")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
    await waitFor(() =>
      expect(server.called("POST", "/api/steward/actions/7/undo")).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByText("Moved Alpha to done")).toBeNull());
  });

  it("has quiet empty states when Steward is off and nothing has happened", async () => {
    start();
    expect(await screen.findByText(/Steward is off\. Turn it on/)).toBeTruthy();
    expect(screen.getByText(/Nothing needs you/)).toBeTruthy();
    expect(screen.getByText(/Nothing is ready/)).toBeTruthy();
    expect(screen.getByText("Nothing to note.")).toBeTruthy();
    expect(screen.getByText(/Steward has noted nothing yet/)).toBeTruthy();
    expect(screen.getByText("No wakes yet.")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: /Steward off/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await expectAccessible();
  });

  it("turns Steward on through the settings", async () => {
    start();
    fireEvent.click(await screen.findByRole("switch", { name: /Steward off/ }));
    await waitFor(() => {
      const put = server.called("PUT", "/api/settings")[0]?.body as {
        steward: { enabled: boolean; stages: unknown };
      };
      expect(put.steward.enabled).toBe(true);
      expect(put.steward.stages).toBeTruthy();
    });
  });

  it("announces items that arrive while it is open, politely", async () => {
    fill();
    start();
    await screen.findByText("CI broke on alpha.");
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("");
    server.steward.needs = [
      ...server.steward.needs,
      stewardItem({ id: 12, kind: "finding", level: "attention", title: "Conflict coming" }),
    ];
    // A change over the event stream refetches.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss: No reviewer" }));
    });
    await waitFor(() => expect(live?.textContent).toMatch(/1 new item\. Conflict coming/));
  });
});

describe("Steward in the page switch", () => {
  it("shows the count of what needs the owner on every page", async () => {
    fill();
    for (const layout of ["inbox", "board", "console"] as const) {
      server.settings.layout = layout;
      const { unmount } = render(<App router={{ hook: memoryLocation({ path: "/" }).hook }} />);
      const link = await screen.findByRole("link", { name: "Steward, 3 need you" });
      expect(link.getAttribute("href")).toBe("/steward");
      unmount();
    }
  });

  it("marks Steward as the current page, and has no count when nothing needs the owner", async () => {
    start();
    const link = await screen.findByRole("link", { name: "Steward" });
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Tracker" }).getAttribute("aria-current")).toBeNull();
  });
});

describe("Steward settings", () => {
  const saved = (): StewardSettings => {
    const call = server.called("PUT", "/api/settings")[0] as { body: { steward: StewardSettings } };
    return call.body.steward;
  };
  const open = async () => {
    start();
    const button = await screen.findByRole("button", { name: "Steward settings" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    button.focus(); // a click focuses it in a browser
    fireEvent.click(button);
    return button;
  };

  it("opens a dialog with every group, and Escape closes it and returns focus", async () => {
    fill();
    const button = await open();
    const dlg = await screen.findByRole("dialog", { name: "Steward settings" });
    for (const name of [
      "Stage models",
      "Promotion by complexity",
      "Daily token caps",
      "Working hours",
      "Pull request signals",
      "Sources",
    ]) {
      expect(within(dlg).getByText(name)).toBeTruthy();
    }
    expect(within(dlg).getAllByText("Not checked yet")).toHaveLength(2);
    expect(within(dlg).getByText(/Slack is unreachable/)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it("saves the whole Steward settings object", async () => {
    fill();
    await open();
    const dlg = await screen.findByRole("dialog", { name: "Steward settings" });
    fireEvent.change(within(dlg).getByRole("combobox", { name: "Decide: model" }), {
      target: { value: "opus" },
    });
    fireEvent.change(within(dlg).getByRole("combobox", { name: "Hard: model" }), {
      target: { value: "opus" },
    });
    fireEvent.change(within(dlg).getByLabelText("Opus"), { target: { value: "250000" } });
    fireEvent.change(within(dlg).getByLabelText("Haiku"), { target: { value: "" } });
    fireEvent.click(within(dlg).getByRole("checkbox", { name: "Sat" }));
    fireEvent.click(within(dlg).getByRole("checkbox", { name: "CI failed" }));
    fireEvent.click(within(dlg).getByRole("checkbox", { name: /^Slack/ }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.called("PUT", "/api/settings")).toHaveLength(1));
    const s = saved();
    expect(s.stages.decide.model).toBe("opus");
    expect(s.complexity.hard).toEqual({ model: "opus", effort: "medium" });
    expect(s.dailyCaps).toEqual({ sonnet: 1_500_000, opus: 250_000 });
    expect(s.workingHours.days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.prSignals).not.toContain("ci failed");
    expect(s.sources).toEqual({ github: true, slack: false, googleDrive: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("maps a complexity to report only", async () => {
    fill();
    await open();
    const dlg = await screen.findByRole("dialog", { name: "Steward settings" });
    fireEvent.change(within(dlg).getByRole("combobox", { name: "Simple: model" }), {
      target: { value: "\u0000none" },
    });
    expect(
      (within(dlg).getByRole("combobox", { name: "Simple: effort" }) as HTMLSelectElement).disabled,
    ).toBe(true);
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.called("PUT", "/api/settings")).toHaveLength(1));
    const s = saved();
    expect(s.complexity.simple).toBeNull();
  });

  it("refuses a cap that is not a whole number without calling the server", async () => {
    fill();
    await open();
    const dlg = await screen.findByRole("dialog", { name: "Steward settings" });
    fireEvent.change(within(dlg).getByLabelText("Sonnet"), { target: { value: "-5" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    expect((await within(dlg).findByRole("alert")).textContent).toMatch(/sonnet cap/);
    expect(server.called("PUT", "/api/settings")).toHaveLength(0);
    await expectAccessible();
  });
});
