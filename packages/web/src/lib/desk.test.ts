import { describe, expect, it } from "vitest";
import type { DeskSubagent } from "../api";
import { deskThread, deskTopic } from "../test/fakeApi";
import {
  activityAge,
  contextLevel,
  contextRatio,
  modelName,
  moveTo,
  ownerIsNext,
  runLine,
  runningActivity,
  runningFor,
  runningSubagents,
  sortDesk,
  subagentCount,
  subagentNames,
  subagentSummary,
  subagentTime,
  subagentTree,
  threadsByActivity,
  tokenCount,
} from "./desk";

const slugs = (l: { slug: string }[]) => l.map((t) => t.slug);

describe("sortDesk", () => {
  const topics = [
    deskTopic({ slug: "quiet-new", lastWorkedAt: "2026-11-25T10:00:00Z" }),
    deskTopic({ slug: "quiet-old", lastWorkedAt: "2026-11-20T10:00:00Z" }),
    deskTopic({ slug: "asks", status: "hitl", lastWorkedAt: "2026-11-21T10:00:00Z" }),
    deskTopic({
      slug: "owes",
      lastWorkedAt: "2026-11-22T10:00:00Z",
      threads: [deskThread({ id: 1, summary: { now: "Did it", next: "Pick a name", at: null } })],
    }),
    deskTopic({ slug: "fav", favorite: true, lastWorkedAt: "2026-11-01T10:00:00Z" }),
  ];

  it("Ready first: favourites, then topics where the owner is next, then the rest by last worked", () => {
    expect(slugs(sortDesk(topics, "ready"))).toEqual([
      "fav",
      "owes",
      "asks",
      "quiet-new",
      "quiet-old",
    ]);
  });

  it("Fixed: favourites, then the drag order, then last worked", () => {
    const placed = topics.map((t, i) =>
      t.slug === "quiet-old"
        ? { ...t, deskOrder: 0 }
        : t.slug === "asks"
          ? { ...t, deskOrder: 1 }
          : { ...t, deskOrder: i === 0 ? null : null },
    );
    expect(slugs(sortDesk(placed, "fixed"))).toEqual([
      "fav",
      "quiet-old",
      "asks",
      "quiet-new",
      "owes",
    ]);
  });

  it("knows when the owner is next", () => {
    expect(ownerIsNext(deskTopic({ slug: "a", status: "review" }))).toBe(true);
    expect(ownerIsNext(deskTopic({ slug: "a", status: "error" }))).toBe(true);
    expect(
      ownerIsNext(
        deskTopic({
          slug: "a",
          threads: [deskThread({ id: 1, summary: { now: "x", next: "Nothing", at: null } })],
        }),
      ),
    ).toBe(false);
  });
});

it("orders threads by activity and words the run line", () => {
  const now = new Date("2026-11-27T09:00:00Z");
  const old = deskThread({ id: 1, lastReplyAt: "2026-11-20T09:00:00Z" });
  const fresh = deskThread({ id: 2, lastReplyAt: "2026-11-25T09:00:00Z" });
  expect(threadsByActivity([old, fresh]).map((t) => t.id)).toEqual([2, 1]);
  expect(runLine(fresh, now)).toBe("finished 2 d ago");
  expect(runLine(deskThread({ id: 3, status: "wip" }), now)).toBe("running");
  expect(runLine(deskThread({ id: 3, status: "hitl" }), now)).toBe("waiting for you");
});

it("moves a slug to an index, clamped", () => {
  expect(moveTo(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  expect(moveTo(["a", "b", "c"], "c", -3)).toEqual(["c", "a", "b"]);
  expect(moveTo(["a", "b", "c"], "b", 99)).toEqual(["a", "c", "b"]);
});

it("words how old an activity line is, and stays quiet while it is fresh", () => {
  const now = new Date("2026-11-25T10:00:00Z");
  const at = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
  expect(activityAge(at(3), now)).toBeNull();
  expect(activityAge(at(9), now)).toBeNull();
  expect(activityAge(at(12), now)).toBe("12s ago");
  expect(activityAge(at(59), now)).toBe("59s ago");
  expect(activityAge(at(180), now)).toBe("3 min ago");
  expect(activityAge("not a date", now)).toBeNull();
});

it("uses the step only for a running thread", () => {
  const activity = { text: "$ ls", at: "2026-11-25T10:00:00Z" };
  expect(runningActivity(deskThread({ id: 1, status: "wip", activity }))).toBe("$ ls");
  expect(runningActivity(deskThread({ id: 1, status: "idle", activity }))).toBeNull();
  expect(runningActivity(deskThread({ id: 1, status: "wip" }))).toBeNull();
});

describe("modelName", () => {
  it("words Claude ids the way the owner says them", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelName("claude-opus-4-1[1m]")).toBe("Opus 4.1");
    expect(modelName("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
  });

  it("leaves any other id as it is", () => {
    expect(modelName("gpt-5.4")).toBe("gpt-5.4");
    expect(modelName("opus")).toBe("opus");
    expect(modelName("claude-weird")).toBe("claude-weird");
  });
});

describe("token counts and the context meter", () => {
  it("shortens token counts", () => {
    const cases: [number, string][] = [
      [0, "0"],
      [950, "950"],
      [1200, "1.2k"],
      [1000, "1k"],
      [12_345, "12k"],
      [190_000, "190k"],
      [999_600, "1M"],
      [1_000_000, "1M"],
      [1_500_000, "1.5M"],
    ];
    for (const [n, want] of cases) expect(tokenCount(n), String(n)).toBe(want);
  });

  it("knows the ratio only when both numbers are known, and caps it", () => {
    expect(contextRatio(190_000, 1_000_000)).toBeCloseTo(0.19);
    expect(contextRatio(null, 1_000_000)).toBeNull();
    expect(contextRatio(10, null)).toBeNull();
    expect(contextRatio(10, 0)).toBeNull();
    expect(contextRatio(3_000_000, 1_000_000)).toBe(1);
  });

  it("is neutral up to 80 %, amber above, red above 95 %", () => {
    expect(contextLevel(0.8)).toBe("ok");
    expect(contextLevel(0.81)).toBe("warn");
    expect(contextLevel(0.95)).toBe("warn");
    expect(contextLevel(0.96)).toBe("full");
  });
});

describe("subagents", () => {
  const sub = (over: Partial<DeskSubagent> = {}): DeskSubagent => ({
    id: 1,
    parentId: null,
    title: null,
    agentType: null,
    model: null,
    progress: null,
    status: "running",
    startedAt: "2026-11-25T10:00:00Z",
    endedAt: null,
    ...over,
  });
  it("counts them", () => {
    expect(subagentCount(1)).toBe("1 subagent");
    expect(subagentCount(3)).toBe("3 subagents");
  });
  it("says how long one has run", () => {
    const at = "2026-11-25T10:00:00Z";
    expect(runningFor(at, new Date("2026-11-25T10:00:30Z"))).toBe("<1 min");
    expect(runningFor(at, new Date("2026-11-25T10:03:10Z"))).toBe("3 min");
    expect(runningFor(at, new Date("2026-11-25T12:00:00Z"))).toBe("2 h");
    expect(runningFor("nonsense", new Date())).toBe("<1 min");
  });
  it("times a running one by how long it has run and a finished one by how long it ran", () => {
    const now = new Date("2026-11-25T10:30:00Z");
    expect(subagentTime(sub(), now)).toBe("30 min");
    expect(subagentTime(sub({ status: "done", endedAt: "2026-11-25T10:04:00Z" }), now)).toBe(
      "4 min",
    );
    expect(subagentTime(sub({ status: "done", endedAt: "2026-11-25T10:00:20Z" }), now)).toBe(
      "<1 min",
    );
  });
  it("summarises: the running count while any runs, else how they ended", () => {
    const list = (...st: DeskSubagent["status"][]) =>
      st.map((status, i) => sub({ id: i + 1, status }));
    expect(runningSubagents(list("running", "done", "running"))).toBe(2);
    expect(subagentSummary(list("running", "done", "failed"))).toBe("1 subagent");
    expect(subagentSummary(list("done", "done", "done"))).toBe("3 subagents · done");
    expect(subagentSummary(list("done", "failed", "done"))).toBe("3 subagents · 1 failed");
    expect(subagentSummary(list("failed", "cancelled", "failed"))).toBe(
      "3 subagents · 2 failed, 1 cancelled",
    );
    expect(subagentSummary(list("cancelled"))).toBe("1 subagent · 1 cancelled");
  });
  it("builds the tree: children under their parent, strays and loops under the thread", () => {
    const names = (nodes: ReturnType<typeof subagentTree>): unknown[] =>
      nodes.map((n) => (n.children.length ? [n.agent.id, names(n.children)] : n.agent.id));
    expect(subagentTree([])).toEqual([]);
    const list = [
      sub({ id: 1 }),
      sub({ id: 2, parentId: 1 }),
      sub({ id: 3, parentId: 2 }),
      sub({ id: 4, parentId: 1 }),
      sub({ id: 5, parentId: 99 }),
      sub({ id: 6, parentId: 6 }),
    ];
    expect(names(subagentTree(list))).toEqual([[1, [[2, [3]], 4]], 5, 6]);
    // 7 and 8 name each other: neither is lost, neither repeats.
    const loop = [sub({ id: 7, parentId: 8 }), sub({ id: 8, parentId: 7 })];
    const flat = (nodes: ReturnType<typeof subagentTree>): number[] =>
      nodes.flatMap((n) => [n.agent.id, ...flat(n.children)]);
    expect(flat(subagentTree(loop)).sort()).toEqual([7, 8]);
  });
  it("names by title, else type, else model, and adds the type or model when it adds something", () => {
    expect(subagentNames(sub({ title: "Check", agentType: "Explore" }))).toEqual({
      name: "Check",
      kind: "Explore",
    });
    expect(subagentNames(sub({ title: "Check", model: "claude-haiku-5" }))).toEqual({
      name: "Check",
      kind: "Haiku 5",
    });
    expect(subagentNames(sub({ agentType: "Explore" }))).toEqual({ name: "Explore", kind: null });
    expect(subagentNames(sub({ model: "claude-haiku-5" }))).toEqual({
      name: "Haiku 5",
      kind: null,
    });
    expect(subagentNames(sub())).toEqual({ name: "Subagent", kind: null });
  });
});
