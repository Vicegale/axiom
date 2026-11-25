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
  sortDesk,
  subagentCount,
  subagentNames,
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
    title: null,
    agentType: null,
    model: null,
    progress: null,
    startedAt: "2026-11-25T10:00:00Z",
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
