import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "../index.js";
import { ConnectorProbe } from "./connectors.js";
import { applyDecision, buildDecideInput, decidePrompt, decideSchema } from "./decide.js";
import {
  applyMemoryChanges,
  applyTidy,
  buildIndex,
  buildMemoryView,
  buildRecall,
  recallCore,
  TidyError,
  tidyPrompt,
  tidySchema,
} from "./memory.js";
import { Steward } from "./scheduler.js";
import { envelope, fakeClaude, fakeGh, QUIET_DECISION } from "./test-fakes.js";

const owner = { kind: "owner" } as const;
const steward = { kind: "steward" } as const;

let dir: string;
let ax: Axiom;
let t: number;
const at = (h: number, m = 0, day = 25) => new Date(2026, 10, day, h, m).getTime();
const now = () => new Date(t);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-memory-"));
  t = at(10);
  ax = openDatabase(":memory:", { now });
  ax.createTopic({ slug: "alpha", title: "Alpha", goal: "Ship alpha" }, owner);
  ax.createTopic({ slug: "beta", title: "Beta" }, owner);
});
afterEach(() => {
  ax.close();
  rmSync(dir, { recursive: true, force: true });
});

const mem = (scope: "core" | "general", text: string, by: typeof owner | typeof steward = owner) =>
  ax.addStewardMemory({ scope, text, ...(by === steward ? { source: "wake" as const } : {}) }, by);
const attach = (kind: "topic" | "repo" | "person", key: string, text: string) =>
  ax.addStewardMemory({ scope: "attached", attachedKind: kind, attachedKey: key, text }, owner);
const texts = (scope?: "core" | "attached" | "general") =>
  ax.listStewardMemory(scope ? { scope } : {}).map((m) => m.text);

describe("applying memory changes", () => {
  it("adds in each scope as Steward, with the source of the caller", () => {
    mkdirSync(join(dir, "atlas"));
    ax.addLink("alpha", { kind: "repository", target: join(dir, "atlas") }, owner);
    const r = applyMemoryChanges(
      ax,
      [
        { op: "add", scope: "core", text: "Prefers a false alarm to a miss." },
        {
          op: "add",
          scope: "attached",
          attachedKind: "topic",
          attachedKey: "alpha",
          text: "Ships Friday.",
        },
        {
          op: "add",
          scope: "attached",
          attachedKind: "repo",
          attachedKey: "ATLAS",
          text: "Merges main in.",
        },
        {
          op: "add",
          scope: "attached",
          attachedKind: "person",
          attachedKey: " Sam ",
          text: "Reviews atlas.",
        },
        { op: "add", scope: "general", text: "gh is logged in." },
      ],
      { source: "wake" },
    );
    expect(r.problems).toEqual([]);
    expect(r.applied).toHaveLength(5);
    const all = ax.listStewardMemory();
    expect(all.map((m) => [m.scope, m.attachedKind, m.attachedKey, m.source])).toEqual([
      ["core", null, null, "wake"],
      ["attached", "topic", "alpha", "wake"],
      // a repository is stored under the name the tracker knows it by (its linked folder)
      ["attached", "repo", join(dir, "atlas"), "wake"],
      ["attached", "person", "Sam", "wake"],
      ["general", null, null, "wake"],
    ]);
  });

  it("refuses unknown keys, unknown ids, long text and malformed changes, and keeps the rest", () => {
    const keep = mem("general", "Keep me.");
    const r = applyMemoryChanges(
      ax,
      [
        { op: "add", scope: "attached", attachedKind: "topic", attachedKey: "nope", text: "x" },
        {
          op: "add",
          scope: "attached",
          attachedKind: "repo",
          attachedKey: "nowhere/repo",
          text: "x",
        },
        { op: "add", scope: "attached", attachedKind: "person", attachedKey: "", text: "x" },
        { op: "add", scope: "attached", text: "x" },
        { op: "add", scope: "core", attachedKey: "alpha", text: "x" },
        { op: "add", scope: "general", text: "y".repeat(601) },
        { op: "update", id: 999, text: "x" },
        { op: "retire", id: 999 },
        { op: "delete", id: 999 },
        { op: "wipe" },
        "nonsense",
        { op: "add", scope: "general", text: "Good one." },
      ],
      { source: "wake" },
    );
    expect(r.problems).toHaveLength(11);
    expect(r.problems.join("\n")).toMatch(/not a topic slug/);
    expect(r.problems.join("\n")).toMatch(/not a repository any topic links/);
    expect(r.applied).toEqual([expect.stringMatching(/^added #\d+ general/)]);
    expect(texts()).toEqual([keep.text, "Good one."]);
  });

  it("skips an add that repeats an active item of the same place", () => {
    mem("core", "Never touch main.");
    const r = applyMemoryChanges(
      ax,
      [
        { op: "add", scope: "core", text: "  never touch  MAIN. " },
        { op: "add", scope: "general", text: "Never touch main." },
      ],
      { source: "wake" },
    );
    expect(r.problems).toEqual([]);
    expect(texts()).toEqual(["Never touch main.", "Never touch main."]);
    expect(texts("core")).toHaveLength(1);
  });

  it("never updates, retires or deletes an owner's item; Steward's own are fair game", () => {
    const own = mem("general", "Steward's own.", steward);
    const theirs = mem("general", "Owner's note.");
    const r = applyMemoryChanges(
      ax,
      [
        { op: "update", id: theirs.id, text: "Owner's note, reworded." },
        { op: "retire", id: theirs.id },
        { op: "delete", id: theirs.id },
        { op: "update", id: own.id, text: "Steward's own, reworded." },
      ],
      { source: "chat" },
    );
    expect(r.problems).toEqual([]);
    expect(r.refused).toHaveLength(3);
    expect(r.refused.join("\n")).toMatch(/owner's note and read-only for Steward/);
    expect(r.refused[0]).toMatch(/Owner's note, reworded/);
    expect(ax.getStewardMemory(theirs.id)).toMatchObject({
      text: "Owner's note.",
      source: "owner",
      retiredAt: null,
    });
    expect(ax.getStewardMemory(own.id)).toMatchObject({
      text: "Steward's own, reworded.",
      source: "chat",
    });

    const r2 = applyMemoryChanges(
      ax,
      [
        { op: "retire", id: own.id },
        { op: "update", id: own.id, text: "again" },
        { op: "delete", id: own.id },
      ],
      { source: "wake" },
    );
    expect(r2.problems).toEqual([expect.stringMatching(/already retired/)]);
    expect(() => ax.getStewardMemory(own.id)).toThrow(/not found/);
  });

  it("an owner's refused change is a note in the wake error, not a failure", () => {
    const theirs = mem("general", "Owner's note.");
    const w = ax.startStewardWake({ trigger: "owner" }, steward);
    const r = applyDecision(
      ax,
      w,
      decideSchema.parse({ brief: "b", memory: [{ op: "delete", id: theirs.id }] }),
      [],
    );
    expect(r.problems).toEqual([expect.stringMatching(/read-only for Steward/)]);
    expect(texts()).toEqual(["Owner's note."]);
  });

  it("an owner's edit makes the item the owner's", () => {
    const m = mem("general", "From a wake.", steward);
    expect(m.source).toBe("wake");
    expect(ax.updateStewardMemory(m.id, "Edited.", owner).source).toBe("owner");
  });
});

describe("recall", () => {
  it("keeps the core within the budget, newest first, and flags what did not fit", () => {
    ax.setStewardSettings({ memoryCoreTokens: 20 }, owner); // 80 characters
    const old = mem("core", "a".repeat(40)); // 10 tokens
    t = at(11);
    const mid = mem("core", "b".repeat(40));
    t = at(12);
    const fresh = mem("core", "c".repeat(40));
    const core = recallCore(ax);
    expect(core.items.map((m) => m.id)).toEqual([mid.id, fresh.id]);
    expect(core).toMatchObject({ tokens: 20, budget: 20, dropped: 1, overBudget: true });
    expect(old.id).toBeLessThan(mid.id);
    // An edit makes an old item the newest.
    t = at(13);
    ax.updateStewardMemory(old.id, "a".repeat(40), owner);
    expect(recallCore(ax).items.map((m) => m.id)).toEqual([old.id, fresh.id]);
    const prompt = buildRecall(ax, { topics: [] });
    expect(prompt.core.dropped).toBe(1);
  });

  it("indexes attached memory by group with counts and general memory by heading", () => {
    attach("topic", "alpha", "One.");
    attach("topic", "alpha", "Two.");
    attach("person", "Sam", "Reviews.");
    mem("general", "gh is logged in as the owner. It has never hit the rate limit.");
    mem("general", "T3 reports subagents elsewhere");
    const idx = buildIndex(ax);
    expect(idx.attached).toEqual([
      { kind: "person", key: "Sam", count: 1 },
      { kind: "topic", key: "alpha", count: 2 },
    ]);
    expect(idx.general).toEqual([
      "gh is logged in as the owner.",
      "T3 reports subagents elsewhere",
    ]);
    expect(idx.generalCount).toBe(2);
    expect(idx.writtenAt).toBeNull();
    // The tidy-up's own lines replace the computed headings.
    ax.setStewardMemoryIndex(["tooling facts", ""], steward);
    expect(buildIndex(ax)).toMatchObject({
      general: ["tooling facts"],
      writtenAt: expect.any(String),
    });
  });

  it("pulls attached memory for topics, repositories and people that came up in the activity", () => {
    mkdirSync(join(dir, "atlas"));
    ax.addLink("alpha", { kind: "repository", target: join(dir, "atlas") }, owner);
    ax.addLink("beta", { kind: "pr", target: "acme/web#4" }, owner);
    ax.createTopic({ slug: "gamma", title: "Gamma" }, owner);
    ax.addLink("gamma", { kind: "pr", target: "acme/other#9" }, owner);
    attach("topic", "alpha", "alpha fact");
    attach("topic", "gamma", "gamma fact");
    attach("repo", join(dir, "atlas"), "atlas fact");
    attach("repo", "acme/web", "web fact");
    attach("repo", "acme/other", "other fact");
    attach("person", "Sam", "sam fact");
    attach("person", "Sa", "should not match inside Sam");
    attach("person", "Robin", "robin fact");

    const r = buildRecall(ax, {
      topics: ["alpha", "beta", "gone"],
      text: ["Sam asked for a review.", "robinson did a thing"],
    });
    expect(
      r.attached.map((g) => `${g.kind} ${g.key}: ${g.items.map((i) => i.text).join("|")}`),
    ).toEqual([
      "person Sam: sam fact",
      `repo ${join(dir, "atlas")}: atlas fact`,
      "repo acme/web: web fact",
      "topic alpha: alpha fact",
    ]);
  });

  it("feeds decide the core with ids, the index, and the attached memory of what was gathered", () => {
    ax.setStewardSettings({ enabled: true }, owner);
    const core = mem("core", "The owner prefers short messages.");
    attach("topic", "beta", "Beta waits on legal.");
    attach("person", "Sam", "Reviews atlas.");
    mem("general", "gh is logged in.");
    const w = ax.startStewardWake({ trigger: "owner" }, steward);
    ax.setStewardWakeGathered(
      w.id,
      {
        summary: "Sam commented.",
        activity: [{ topic: "beta", source: "slack", what: "Legal replied." }],
        unreadable: [],
        since: "",
        until: "",
        sources: [],
      },
      steward,
    );
    const p = decidePrompt(
      buildDecideInput(ax, { wake: ax.getStewardWake(w.id), now: now(), tidied: [] }),
    );
    expect(p).toContain(`- #${core.id} The owner prefers short messages.`);
    expect(p).toContain("person Sam (1); topic beta (1)");
    expect(p).toContain("General (1): gh is logged in.");
    expect(p).toContain("Beta waits on legal.");
    expect(p).toContain("Reviews atlas.");
    expect(p).toContain("Topics first");
  });
});

describe("memory changes from a wake", () => {
  const GATHER = { summary: "Quiet.", activity: [], unreadable: [] };
  const setup = (decide: unknown, tidy?: unknown) => {
    ax.setStewardSettings({ enabled: true }, owner);
    const claude = fakeClaude(dir, envelope(GATHER), {
      decideOut: envelope(decide),
      ...(tidy ? { tidyOut: envelope(tidy) } : {}),
    });
    const gh = fakeGh(dir, [
      { match: "api user", stdout: "me\n" },
      { match: "search prs", stdout: [] },
    ]);
    const s = new Steward({
      ax,
      claudeCli: claude.path,
      ghCli: gh.path,
      now,
      tickMs: 0,
      heartbeatGapMs: 45 * 60_000,
      connectors: new ConnectorProbe({
        cli: () => "claude",
        probe: async () => ({ ok: true, servers: [], at: Date.now() }),
      }),
    });
    return { claude, s };
  };
  const run = async (s: Steward, trigger: "owner" | "timer" = "owner") => {
    const w = await s.requestWake(trigger, "test");
    await s.settle();
    if (!w) throw new Error("no wake ran");
    return ax.getStewardWake(w.id);
  };

  it("applies the reply's memory changes as Steward and records refused ones", async () => {
    const stale = mem("general", "Stale.", steward);
    const { s } = setup({
      ...QUIET_DECISION,
      memory: [
        {
          op: "add",
          scope: "attached",
          attachedKind: "topic",
          attachedKey: "alpha",
          text: "Ships Friday.",
        },
        { op: "delete", id: stale.id },
        { op: "retire", id: 999 },
      ],
    });
    const w = await run(s);
    expect(w.status).toBe("done");
    expect(w.error).toMatch(/1 result\(s\) could not be applied/);
    expect(texts()).toEqual(["Ships Friday."]);
    expect(ax.listStewardMemory()[0]).toMatchObject({ source: "wake", attachedKey: "alpha" });
  });

  it("a malformed memory entry does not discard the rest of the reply", () => {
    const out = decideSchema.parse({ brief: "b", memory: [{ nonsense: true }] });
    const w = ax.startStewardWake({ trigger: "owner" }, steward);
    const r = applyDecision(ax, w, out, []);
    expect(r.problems).toHaveLength(1);
    expect(r.memory).toEqual([]);
  });

  it("tidies on the first wake of the day, before the wake, and not again that day", async () => {
    mem("general", "Duplicate fact.");
    const dup = mem("general", "Duplicate fact.", steward);
    const { s, claude } = setup(QUIET_DECISION, {
      summary: "Dropped one duplicate.",
      memory: [{ op: "delete", id: dup.id }],
    });
    await run(s, "timer");
    const wakes = ax.listStewardWakes().reverse();
    expect(wakes.map((w) => [w.trigger, w.status])).toEqual([
      ["tidy-up", "done"],
      ["timer", "done"],
    ]);
    expect(claude.runs("tidy")).toBe(1);
    expect(texts()).toEqual(["Duplicate fact."]);
    const tidyRuns = ax.listStewardRuns({ wakeId: wakes[0]?.id });
    expect(tidyRuns.map((r) => [r.stage, r.status])).toEqual([["tidy-up", "done"]]);
    // The stage has no tools and no connectors (the decide policy).
    expect(claude.argv("tidy")).toEqual(
      expect.arrayContaining(["--tools", "", "--strict-mcp-config"]),
    );
    // The tidy-up wake does not move the look-back point of the next wake.
    expect(ax.getStewardWake(wakes[1]?.id as number).lookBackFrom).toBe(
      new Date(t - 24 * 3_600_000).toISOString(),
    );

    t = at(11);
    await run(s, "timer");
    expect(claude.runs("tidy")).toBe(1);

    // Next day with nothing changed: nothing to tidy, nothing spent.
    t = at(10, 0, 26);
    await run(s, "timer");
    expect(claude.runs("tidy")).toBe(1);
    // Next day after a change: tidied again.
    t = at(10, 30, 26);
    mem("general", "Something new.");
    t = at(11, 0, 26);
    await run(s, "timer");
    expect(claude.runs("tidy")).toBe(2);
  });

  it("a failed tidy-up changes nothing, is recorded, and the wake still runs", async () => {
    mem("general", "One.");
    mem("general", "Two.");
    const { s } = setup(QUIET_DECISION, { summary: "x", memory: [{ op: "delete", id: 999 }] });
    const w = await run(s, "timer");
    const wakes = ax.listStewardWakes().reverse();
    expect(wakes[0]).toMatchObject({ trigger: "tidy-up", status: "failed" });
    expect(wakes[0]?.error).toMatch(/999/);
    expect(w).toMatchObject({ trigger: "timer", status: "done" });
    expect(texts()).toEqual(["One.", "Two."]);
  });

  it("tidies on demand, with Steward off, behind a running wake; refuses when memory is empty", async () => {
    const { s } = setup(QUIET_DECISION, {
      summary: "Merged.",
      core: ["The merged core."],
      index: ["facts"],
    });
    await expect(s.tidyUpNow()).rejects.toThrow(/empty/);
    mem("core", "Old core a.", steward);
    mem("core", "Old core b.", steward);
    ax.setStewardSettings({ enabled: false }, owner);
    const w = await s.tidyUpNow();
    expect(w).toMatchObject({
      trigger: "tidy-up",
      status: "done",
      triggerDetail: "asked by the owner",
    });
    expect(texts("core")).toEqual(["The merged core."]);
    expect(ax.getStewardMemoryIndex()?.lines).toEqual(["facts"]);
    expect(buildMemoryView(ax).lastTidy).toMatchObject({ status: "done", summary: "Merged." });
  });

  it("tidies when the core is over budget even later the same day, at most once an hour", async () => {
    mem("general", "x");
    const { s } = setup(QUIET_DECISION);
    await run(s, "timer"); // first wake: tidy-up (nothing to do) then the wake
    ax.setStewardSettings({ memoryCoreTokens: 10 }, owner);
    mem("core", "z".repeat(100));
    expect(s.tidyDue(new Date(t + 10 * 60_000))).toBe(false);
    expect(s.tidyDue(new Date(t + 61 * 60_000))).toBe(true);
  });
});

describe("the tidy-up applied", () => {
  it("merges, retires, deletes and rewrites the core and index as one unit; the owner's items stay", () => {
    const a = mem("general", "Atlas health check is /healthz.", steward);
    const b = mem("general", "The atlas health check path is /healthz since atlas#33.", steward);
    const stale = mem("general", "Standup is at 09:00.", steward);
    const ownerNote = mem("general", "Atlas health at /healthz.");
    const c1 = mem("core", "Prefers a false alarm to a miss.");
    const c2 = mem(
      "core",
      "Also prefers false alarms to misses. Plus the atlas deploy steps.",
      steward,
    );
    const out = tidySchema.parse({
      summary: "Merged two, dropped one.",
      memory: [
        { op: "update", id: b.id, text: "Atlas health check is /healthz (since atlas#33)." },
        { op: "delete", id: a.id },
        { op: "retire", id: stale.id },
        { op: "delete", id: ownerNote.id },
        { op: "update", id: ownerNote.id, text: "reworded" },
        {
          op: "add",
          scope: "attached",
          attachedKind: "topic",
          attachedKey: "alpha",
          text: "Deploy steps: see runbook.",
        },
      ],
      // The model leaves out the owner's core item and repeats it reworded: both are fine.
      core: ["Prefers a false alarm to a miss.", "Short core fact."],
      index: ["atlas facts"],
    });
    const r = applyTidy(ax, out);
    expect(r.refused).toHaveLength(2);
    expect(texts("general")).toEqual([
      "Atlas health check is /healthz (since atlas#33).",
      "Atlas health at /healthz.",
    ]);
    expect(() => ax.getStewardMemory(a.id)).toThrow();
    expect(ax.getStewardMemory(stale.id).retiredAt).not.toBeNull();
    expect(ax.getStewardMemory(ownerNote.id)).toMatchObject({ retiredAt: null, source: "owner" });
    // The owner's core item is kept (same row, same text); Steward's other one is retired.
    expect(texts("core")).toEqual(["Prefers a false alarm to a miss.", "Short core fact."]);
    expect(ax.listStewardMemory({ scope: "core" })[0]?.id).toBe(c1.id);
    expect(ax.getStewardMemory(c2.id).retiredAt).not.toBeNull();
    expect(ax.getStewardMemoryIndex()?.lines).toEqual(["atlas facts"]);
    expect(texts("attached")).toEqual(["Deploy steps: see runbook."]);
    expect(ax.listStewardMemory({ scope: "attached" })[0]?.source).toBe("tidy-up");
  });

  it("keeps every owner core item even when they alone exceed the budget, and adds nothing", () => {
    ax.setStewardSettings({ memoryCoreTokens: 10 }, owner);
    const big = mem("core", "o".repeat(100));
    const small = mem("core", "Steward's.", steward);
    // Dropping everything else is fine; adding anything over the budget is not.
    expect(() => applyTidy(ax, tidySchema.parse({ summary: "s", core: ["new fact"] }))).toThrow(
      TidyError,
    );
    applyTidy(ax, tidySchema.parse({ summary: "s", core: [] }));
    expect(texts("core")).toEqual(["o".repeat(100)]);
    expect(ax.getStewardMemory(big.id).retiredAt).toBeNull();
    expect(ax.getStewardMemory(small.id).retiredAt).not.toBeNull();
    expect(buildMemoryView(ax).overBudget).toBe(true);
  });

  it("rolls everything back when a change is refused, the core is over budget or the index is wrong", () => {
    ax.setStewardSettings({ memoryCoreTokens: 10 }, owner);
    const a = mem("general", "Keep.", steward);
    const c = mem("core", "Short.");
    const before = () => JSON.stringify(ax.listStewardMemory({ includeRetired: true }));
    const snapshot = before();
    const attempts = [
      {
        memory: [
          { op: "delete", id: a.id },
          { op: "retire", id: 999 },
        ],
      },
      { memory: [{ op: "delete", id: a.id }], core: ["w".repeat(41)] },
      {
        memory: [{ op: "delete", id: a.id }],
        core: ["ok"],
        index: Array.from({ length: 21 }, (_, i) => `l${i}`),
      },
      { memory: [{ op: "delete", id: a.id }], core: ["x".repeat(601)] },
    ];
    for (const extra of attempts) {
      expect(() => applyTidy(ax, tidySchema.parse({ summary: "s", ...extra }))).toThrow(TidyError);
      expect(before()).toBe(snapshot);
    }
    expect(ax.getStewardMemoryIndex()).toBeNull();
    expect(ax.getStewardMemory(c.id).retiredAt).toBeNull();
  });

  it("the prompt lists every item with id and source, the budget and the rules", () => {
    ax.setStewardSettings({ memoryCoreTokens: 500 }, owner);
    const core = mem("core", "Core fact.");
    const g = mem("general", "General fact.", steward);
    const att = attach("topic", "alpha", "Attached fact.");
    ax.retireStewardMemory(attach("topic", "beta", "Retired fact.").id, owner);
    const p = tidyPrompt(ax, now());
    expect(p).toContain("Steward memory tidy-up");
    expect(p).toContain(`#${core.id} [owner, updated 2026-11-25] Core fact.`);
    expect(p).toContain(`#${g.id} [wake, updated 2026-11-25] General fact.`);
    expect(p).toContain(`topic alpha:\n#${att.id} [owner`);
    expect(p).not.toContain("Retired fact.");
    expect(p).toContain("500 tokens");
  });
});

describe("owner endpoints", () => {
  it("lists, adds, edits, retires, deletes and tidies, always as the owner", async () => {
    const dbPath = join(dir, "axiom.db");
    const seed = openDatabase(dbPath);
    seed.createTopic({ slug: "alpha", title: "Alpha" }, owner);
    seed.addStewardMemory({ scope: "general", text: "A wake's note.", source: "wake" }, steward);
    seed.close();
    const claude = fakeClaude(dir, envelope({ summary: "", activity: [] }), {
      tidyOut: envelope({ summary: "Core rewritten.", core: ["Fresh core."] }),
    });
    const server = await startServer({
      dbPath,
      port: 0,
      webDist: join(dir, "no-web"),
      t3Dir: join(dir, "no-t3"),
      claudeCli: claude.path,
      ghCli: "/nonexistent/gh",
      stewardTickMs: 0,
    });
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${server.url}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as never };
    };
    try {
      const first = await api("GET", "/api/steward/memory");
      expect(first.json).toMatchObject({
        budget: 2000,
        coreTokens: 0,
        overBudget: false,
        lastTidy: null,
      });
      expect(first.json.keys.topics).toEqual([{ slug: "alpha", title: "Alpha" }]);
      expect(first.json.items).toHaveLength(1);

      const core = await api("POST", "/api/steward/memory", {
        scope: "core",
        text: " Prefers calm. ",
      });
      expect(core).toMatchObject({ status: 201 });
      expect(core.json).toMatchObject({ scope: "core", text: "Prefers calm.", source: "owner" });
      const att = await api("POST", "/api/steward/memory", {
        scope: "attached",
        attachedKind: "topic",
        attachedKey: "alpha",
        text: "Ships Friday.",
      });
      expect(att.json).toMatchObject({ attachedKind: "topic", attachedKey: "alpha" });
      for (const bad of [
        { scope: "attached", attachedKind: "topic", attachedKey: "nope", text: "x" },
        { scope: "attached", text: "x" },
        { scope: "core", attachedKey: "alpha", text: "x" },
        { scope: "general", text: "  " },
        { scope: "weird", text: "x" },
      ]) {
        expect((await api("POST", "/api/steward/memory", bad)).status).toBe(400);
      }

      const edited = await api("PUT", `/api/steward/memory/${first.json.items[0].id}`, {
        text: "Edited by me.",
      });
      expect(edited.json).toMatchObject({ text: "Edited by me.", source: "owner" });
      expect((await api("PUT", "/api/steward/memory/999", { text: "x" })).status).toBe(404);
      expect((await api("PUT", "/api/steward/memory/abc", { text: "x" })).status).toBe(400);

      const retired = await api("POST", `/api/steward/memory/${att.json.id}/retire`);
      expect(retired.json.retiredAt).not.toBeNull();
      const restored = await api("POST", `/api/steward/memory/${att.json.id}/restore`);
      expect(restored.json).toMatchObject({ retiredAt: null, source: "owner", id: att.json.id });
      expect((await api("POST", "/api/steward/memory/999/restore")).status).toBe(404);
      expect((await api("POST", `/api/steward/memory/${att.json.id}/retire`)).status).toBe(200);
      expect((await api("DELETE", `/api/steward/memory/${att.json.id}`)).json).toEqual({
        ok: true,
      });
      expect((await api("DELETE", `/api/steward/memory/${att.json.id}`)).status).toBe(404);

      const tidy = await api("POST", "/api/steward/memory/tidy-up");
      expect(tidy.status).toBe(200);
      expect(tidy.json.wake).toMatchObject({ trigger: "tidy-up", status: "done" });
      expect(
        tidy.json.memory.items
          .filter(
            (m: { scope: string; retiredAt: string | null }) => m.scope === "core" && !m.retiredAt,
          )
          .map((m: { text: string }) => m.text),
      ).toEqual(["Prefers calm.", "Fresh core."]);
      expect(tidy.json.memory.lastTidy).toMatchObject({
        status: "done",
        summary: "Core rewritten.",
      });
    } finally {
      await server.close();
    }
  });
});
