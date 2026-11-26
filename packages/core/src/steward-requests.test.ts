import { describe, expect, it } from "vitest";
import { STEWARD_CHECK_INTERVAL_MS } from "./axiom.js";
import { memoryForTopic } from "./steward.js";
import { makeAxiom, owner } from "./test-helpers.js";

const agent = { kind: "agent" } as const;
const steward = { kind: "steward" } as const;

function setup(on = true) {
  const { ax, clock } = makeAxiom();
  ax.createTopic({ slug: "alpha", title: "Alpha" }, owner);
  if (on) ax.setStewardSettings({ enabled: true }, owner);
  return { ax, clock };
}

describe("requests for a wake (ST10)", () => {
  it("lets an agent and the owner ask for a check, and records who", () => {
    const { ax } = setup();
    const r = ax.requestStewardWake({ kind: "check", topic: "alpha" }, agent);
    expect(r).toMatchObject({
      kind: "check",
      topic: "alpha",
      requestedBy: "agent",
      handledAt: null,
    });
    expect(ax.listStewardRequests({ pending: true })).toHaveLength(1);
  });

  it("refuses a check while Steward is off, for an unknown topic and for a steward-disabled one", () => {
    const off = setup(false);
    expect(() => off.ax.requestStewardWake({ kind: "check", topic: "alpha" }, agent)).toThrow(
      /Steward is off/,
    );
    const { ax } = setup();
    expect(() => ax.requestStewardWake({ kind: "check", topic: "nope" }, agent)).toThrow(
      /not found/i,
    );
    ax.setTopicStewardEnabled("alpha", false, owner);
    expect(() => ax.requestStewardWake({ kind: "check", topic: "alpha" }, agent)).toThrow(
      /switched off for alpha/,
    );
    expect(ax.listStewardRequests()).toEqual([]);
  });

  it("allows one check per topic every ten minutes, even once handled", () => {
    const { ax, clock } = setup();
    ax.createTopic({ slug: "beta", title: "Beta" }, owner);
    const r = ax.requestStewardWake({ kind: "check", topic: "alpha" }, agent);
    ax.handleStewardRequest(r.id, "picked up", steward);
    clock.advanceMs(STEWARD_CHECK_INTERVAL_MS - 1000);
    expect(() => ax.requestStewardWake({ kind: "check", topic: "alpha" }, owner)).toThrow(
      /next one is allowed after/,
    );
    ax.requestStewardWake({ kind: "check", topic: "beta" }, agent); // another topic is fine
    clock.advanceMs(1000);
    ax.requestStewardWake({ kind: "check", topic: "alpha" }, agent);
  });

  it("lets only the owner ask for a run, and only Steward handle requests", () => {
    const { ax } = setup(false);
    expect(() => ax.requestStewardWake({ kind: "run" }, agent)).toThrow(/only the owner/);
    const r = ax.requestStewardWake({ kind: "run" }, owner); // works while off
    expect(r.kind).toBe("run");
    expect(() => ax.handleStewardRequest(r.id, "x", agent)).toThrow(/agent cannot/);
    const h = ax.handleStewardRequest(r.id, "picked up", steward);
    expect(h.handledAt).not.toBeNull();
    expect(ax.listStewardRequests({ pending: true })).toEqual([]);
  });

  it("knows the server by its beat while it is fresh", () => {
    const { ax, clock } = setup();
    expect(ax.getStewardServerBeat()).toBeNull();
    ax.setStewardServerBeat({ pid: 7, freshMs: 90_000, nextWakeAt: null }, steward);
    expect(ax.getStewardServerBeat()).toMatchObject({ pid: 7 });
    clock.advanceMs(91_000);
    expect(ax.getStewardServerBeat()).toBeNull();
    ax.setStewardServerBeat({ pid: 7, freshMs: 90_000, nextWakeAt: null }, steward);
    ax.clearStewardServerBeat();
    expect(ax.getStewardServerBeat()).toBeNull();
  });
});

describe("items with their fix and memory for a topic (ST10)", () => {
  it("shows a finding's ready fix on the finding, not as its own row", () => {
    const { ax } = setup();
    const f = ax.recordStewardFinding(
      { topic: "alpha", level: "attention", title: "CI red" },
      steward,
    );
    ax.addStewardFix(
      f.id,
      {
        title: "Fix CI",
        repository: "/r",
        branch: "steward/fix-ci",
        base: "main",
        worktree: "/w",
        complexity: "simple",
        diffstat: "1 file",
        tests: "pass",
      },
      steward,
    );
    ax.addStewardItem({ kind: "question", topic: "alpha", title: "Which?" }, steward);
    const items = ax.listStewardItemsWithFix({ topic: "alpha" });
    expect(items.map((i) => [i.kind, i.fixBranch])).toEqual([
      ["finding", "steward/fix-ci"],
      ["question", null],
    ]);
    expect(ax.listStewardItemsWithFix({ kind: "question" })).toHaveLength(1);
  });

  it("lists the core, the topic's own and attached memory, not other topics'", () => {
    const { ax } = setup();
    ax.createTopic({ slug: "beta", title: "Beta" }, owner);
    ax.addStewardMemory({ scope: "core", text: "core" }, owner);
    ax.addStewardMemory(
      { scope: "attached", attachedKind: "topic", attachedKey: "alpha", text: "a" },
      owner,
    );
    ax.addStewardMemory(
      { scope: "attached", attachedKind: "topic", attachedKey: "beta", text: "b" },
      owner,
    );
    ax.addStewardMemory({ scope: "general", text: "g" }, owner);
    const retired = ax.addStewardMemory({ scope: "core", text: "old" }, owner);
    ax.retireStewardMemory(retired.id, owner);
    expect(memoryForTopic(ax, "alpha").map((m) => m.text)).toEqual(["core", "a"]);
    expect(memoryForTopic(ax, "alpha", { includeRetired: true }).map((m) => m.text)).toEqual([
      "core",
      "a",
      "old",
    ]);
  });

  it("caps an owner's memory text", () => {
    const { ax } = setup();
    expect(() => ax.addStewardMemory({ scope: "core", text: "x".repeat(2001) }, owner)).toThrow(
      /at most 2000/,
    );
  });
});
