import { describe, expect, it } from "vitest";
import { deskThread, deskTopic } from "../test/fakeApi";
import {
  activityAge,
  moveTo,
  ownerIsNext,
  runLine,
  runningActivity,
  sortDesk,
  threadsByActivity,
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
