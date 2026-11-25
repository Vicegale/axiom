import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../App";
import type { MemoryEntry } from "../api";
import { expectAccessible } from "../test/axe";
import { FakeServer } from "../test/fakeApi";
import { seedTracker } from "../test/seed";

let server: FakeServer;

function start(path = "/steward/memory") {
  render(<App router={{ hook: memoryLocation({ path }).hook }} />);
}

const entry = (over: Partial<MemoryEntry> & { id: number; text: string }): MemoryEntry => ({
  scope: "general",
  attachedKind: null,
  attachedKey: null,
  source: "wake",
  createdAt: "2026-11-24T09:00:00.000Z",
  updatedAt: "2026-11-24T09:00:00.000Z",
  retiredAt: null,
  ...over,
});

function fill() {
  server.memory = [
    entry({
      id: 1,
      scope: "core",
      text: "The owner prefers a false alarm to a miss.",
      source: "owner",
    }),
    entry({
      id: 2,
      scope: "core",
      text: "Lint-only CI failures: report quietly.",
      source: "tidy-up",
    }),
    entry({
      id: 3,
      scope: "attached",
      attachedKind: "topic",
      attachedKey: "alpha",
      text: "Alpha ships Friday.",
    }),
    entry({
      id: 4,
      scope: "attached",
      attachedKind: "person",
      attachedKey: "Sam",
      text: "Reviews atlas PRs.",
      source: "chat",
    }),
    entry({ id: 5, scope: "general", text: "gh is logged in as the owner." }),
    entry({ id: 6, scope: "general", text: "An old note.", retiredAt: "2026-11-24T10:00:00.000Z" }),
  ];
  server.memoryKeys = { topics: [{ slug: "alpha", title: "Alpha" }], repos: ["acme/app"] };
}

beforeEach(() => {
  window.localStorage.clear();
  document.title = "";
  server = new FakeServer();
  seedTracker(server);
  server.install();
});
afterEach(() => vi.unstubAllGlobals());

describe("the Steward memory page", () => {
  it("shows the core with its meter, the index, attached groups and general memory", async () => {
    fill();
    start();
    const core = await screen.findByRole("region", { name: "Core" });
    expect(within(core).getByText("The owner prefers a false alarm to a miss.")).toBeTruthy();
    const meter = within(core).getByRole("progressbar", { name: "Memory core size" });
    expect(meter.getAttribute("aria-valuemax")).toBe("2000");
    expect(meter.getAttribute("aria-valuetext")).toMatch(/of 2k tokens/);
    // The index links to each attached group and to the general memory.
    const index = within(core).getByRole("list", { name: "Index of the rest of the memory" });
    expect(
      within(index)
        .getByRole("link", { name: /topic alpha/ })
        .getAttribute("href"),
    ).toBe("#mem-topic-alpha");
    expect(within(index).getByRole("link", { name: /person Sam/ })).toBeTruthy();
    const attached = screen.getByRole("region", { name: "Attached" });
    expect(within(attached).getByRole("heading", { name: "topic alpha" })).toBeTruthy();
    expect(within(attached).getByText("Alpha ships Friday.")).toBeTruthy();
    expect(within(attached).getByRole("heading", { name: "person Sam" })).toBeTruthy();
    // Source and time of each item.
    expect(within(attached).getByText("chat")).toBeTruthy();
    expect(within(core).getByText("tidy-up")).toBeTruthy();
    const general = screen.getByRole("region", { name: "General" });
    expect(within(general).getByText("gh is logged in as the owner.")).toBeTruthy();
    // A retired item is out of the lists and behind a disclosure.
    expect(within(general).queryByText("An old note.")).toBeNull();
    expect(screen.getByText("Retired (1)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Steward" }).getAttribute("href")).toBe(
      "/steward",
    );
  });

  it("is reached from the Steward page's Open memory link", async () => {
    fill();
    render(<App router={{ hook: memoryLocation({ path: "/steward" }).hook }} />);
    const link = await screen.findByRole("link", { name: "Open memory" });
    expect(link.getAttribute("href")).toBe("/steward/memory");
    fireEvent.click(link);
    expect(await screen.findByRole("heading", { name: "Memory" })).toBeTruthy();
  });

  it("is accessible, with an item being edited and the add form open", async () => {
    fill();
    start();
    await screen.findByRole("region", { name: "Core" });
    await expectAccessible();
    fireEvent.click(screen.getByRole("button", { name: /^Edit: Alpha ships/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByRole("form", { name: "Add a memory item" });
    await expectAccessible();
  });

  it("edits an item inline and saves it as the owner's", async () => {
    fill();
    start();
    fireEvent.click(await screen.findByRole("button", { name: /^Edit: Alpha ships/ }));
    const box = screen.getByRole("textbox", { name: /^Edit memory: Alpha ships/ });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "Alpha ships Monday." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Alpha ships Monday.")).toBeTruthy();
    expect(server.called("PUT", "/api/steward/memory/3")[0]?.body).toEqual({
      text: "Alpha ships Monday.",
    });
    expect(server.memory.find((m) => m.id === 3)?.source).toBe("owner");
    // Focus goes back to the item's Edit button.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /^Edit: Alpha ships Monday/ }),
      ),
    );
  });

  it("cancels an edit with Escape and changes nothing", async () => {
    fill();
    start();
    fireEvent.click(await screen.findByRole("button", { name: /^Edit: gh is logged in/ }));
    const box = screen.getByRole("textbox", { name: /^Edit memory/ });
    fireEvent.change(box, { target: { value: "changed" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.getByText("gh is logged in as the owner.")).toBeTruthy();
    expect(server.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("adds a general item, and an attached one with its kind and key", async () => {
    fill();
    start();
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("What Steward should remember"), {
      target: { value: "T3 reports subagents elsewhere." },
    });
    fireEvent.click(
      within(screen.getByRole("form", { name: "Add a memory item" })).getByRole("button", {
        name: "Add",
      }),
    );
    expect(await screen.findByText("T3 reports subagents elsewhere.")).toBeTruthy();
    expect(server.called("POST", "/api/steward/memory")[0]?.body).toEqual({
      scope: "general",
      text: "T3 reports subagents elsewhere.",
    });

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const form = await screen.findByRole("form", { name: "Add a memory item" });
    fireEvent.change(within(form).getByLabelText("Where"), { target: { value: "attached" } });
    fireEvent.change(within(form).getByLabelText("Attached to"), { target: { value: "repo" } });
    const submit = within(form).getByRole("button", { name: "Add" }) as HTMLButtonElement;
    // The key is required for attached memory.
    fireEvent.change(within(form).getByLabelText("What Steward should remember"), {
      target: { value: "Merges main in." },
    });
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Repository"), { target: { value: "acme/app" } });
    fireEvent.click(submit);
    expect(await screen.findByRole("heading", { name: "repo acme/app" })).toBeTruthy();
    expect(server.called("POST", "/api/steward/memory")[1]?.body).toEqual({
      scope: "attached",
      attachedKind: "repo",
      attachedKey: "acme/app",
      text: "Merges main in.",
    });
  });

  it("retires an item, and deletes one only after confirming", async () => {
    fill();
    start();
    fireEvent.click(await screen.findByRole("button", { name: /^Retire: gh is logged in/ }));
    const general = screen.getByRole("region", { name: "General" });
    await waitFor(() =>
      expect(within(general).queryByText("gh is logged in as the owner.")).toBeNull(),
    );
    expect(server.memory.find((m) => m.id === 5)?.retiredAt).not.toBeNull();
    expect(screen.getByText("Retired (2)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Delete: Reviews atlas/ }));
    expect(server.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete: Reviews atlas/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.called("DELETE", "/api/steward/memory/4")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Reviews atlas PRs.")).toBeNull());
    expect(server.called("DELETE", "/api/steward/memory/4")).toHaveLength(1);
  });

  it("restores a retired item", async () => {
    fill();
    start();
    fireEvent.click(await screen.findByText("Retired (1)"));
    fireEvent.click(screen.getByRole("button", { name: /^Restore: An old note/ }));
    const general = screen.getByRole("region", { name: "General" });
    expect(await within(general).findByText("An old note.")).toBeTruthy();
    expect(server.called("POST", "/api/steward/memory/6/restore")).toHaveLength(1);
    expect(server.memory.find((m) => m.id === 6)?.retiredAt).toBeNull();
  });

  it("runs the tidy-up on demand", async () => {
    fill();
    start();
    fireEvent.click(await screen.findByRole("button", { name: "Run tidy-up now" }));
    await waitFor(() =>
      expect(server.called("POST", "/api/steward/memory/tidy-up")).toHaveLength(1),
    );
    expect(await screen.findByRole("button", { name: "Run tidy-up now" })).toBeTruthy();
  });

  it("says so when the core is over its budget", async () => {
    server.memory = [entry({ id: 1, scope: "core", text: "x".repeat(8100) })];
    start();
    expect(await screen.findByText(/over its budget/)).toBeTruthy();
  });

  it("explains an empty memory", async () => {
    start();
    expect(await screen.findByText(/Nothing in the core yet/)).toBeTruthy();
    expect(
      screen.getByText(
        "No attached memory. Facts about one topic, repository or person wait here.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Run tidy-up now" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
