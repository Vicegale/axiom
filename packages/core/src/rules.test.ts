import { describe, expect, it } from "vitest";
import { TOPIC_STATUSES, type TopicStatus } from "./constants.js";
import {
  entryWriteError,
  manualStatusError,
  needsStalePrompt,
  stopStatus,
  type ThreadState,
  topicStatusFromThreads,
  viewOfStatus,
  viewsOfTopic,
} from "./rules.js";

describe("stop table", () => {
  const base = {
    declaredStatus: null,
    waitingOnOwner: false,
    hasPrLink: false,
    confirmedMonitorTargets: 0,
  } as const;

  it.each<[string, Parameters<typeof stopStatus>[0], TopicStatus]>([
    ["nothing declared", { ...base }, "idle"],
    ["wip declared", { ...base, declaredStatus: "wip" }, "idle"],
    ["hitl declared", { ...base, declaredStatus: "hitl" }, "hitl"],
    ["waiting on the owner", { ...base, waitingOnOwner: true }, "hitl"],
    [
      "waiting on the owner beats a declared done",
      { ...base, waitingOnOwner: true, declaredStatus: "done" },
      "hitl",
    ],
    ["done", { ...base, declaredStatus: "done" }, "done"],
    ["blocked", { ...base, declaredStatus: "blocked" }, "blocked"],
    ["review with a PR", { ...base, declaredStatus: "review", hasPrLink: true }, "review"],
    ["review without a PR", { ...base, declaredStatus: "review", hasPrLink: false }, "idle"],
    [
      "monitoring with a confirmed target",
      { ...base, declaredStatus: "monitoring", confirmedMonitorTargets: 1 },
      "monitoring",
    ],
    [
      "monitoring with several confirmed targets",
      { ...base, declaredStatus: "monitoring", confirmedMonitorTargets: 3 },
      "monitoring",
    ],
    [
      "monitoring without a confirmed target",
      { ...base, declaredStatus: "monitoring", confirmedMonitorTargets: 0 },
      "blocked",
    ],
  ])("%s", (_name, input, expected) => {
    expect(stopStatus(input)).toBe(expected);
  });
});

describe("views", () => {
  it.each<[TopicStatus, string]>([
    ["hitl", "attention"],
    ["error", "attention"],
    ["wip", "ongoing"],
    ["monitoring", "monitoring"],
    ["review", "monitoring"],
    ["idle", "piles"],
    ["blocked", "piles"],
    ["stale", "piles"],
    ["done", "closed"],
  ])("%s -> %s", (status, view) => {
    expect(viewOfStatus(status)).toBe(view);
    expect(viewsOfTopic(status, [])).toEqual([view]);
  });

  it("maps all nine statuses", () => {
    expect(TOPIC_STATUSES.map(viewOfStatus)).toHaveLength(9);
  });

  it("a null-status topic takes the views of its open threads", () => {
    expect(viewsOfTopic(null, ["wip", "hitl", "wip"]).sort()).toEqual(["attention", "ongoing"]);
    expect(viewsOfTopic(null, [])).toEqual([]);
  });
});

describe("topicStatusFromThreads (provisional)", () => {
  const th = (status: TopicStatus, seq: number, open = true): ThreadState => ({
    status,
    open,
    statusChangedAt: "2026-01-01T00:00:00.000Z",
    statusChangedSeq: seq,
  });

  it("two open wip threads -> null", () => {
    expect(topicStatusFromThreads([th("wip", 1), th("wip", 2)])).toBeNull();
  });
  it("exactly one open wip thread -> wip", () => {
    expect(topicStatusFromThreads([th("wip", 1), th("hitl", 2)])).toBe("wip");
  });
  it("an ended wip thread does not count", () => {
    expect(topicStatusFromThreads([th("wip", 1, false), th("wip", 2, false), th("idle", 3)])).toBe(
      "idle",
    );
  });
  it("otherwise follows the most recently changed thread", () => {
    expect(topicStatusFromThreads([th("hitl", 5), th("idle", 3), th("done", 4)])).toBe("hitl");
  });
  it("later time beats a higher sequence", () => {
    const later: ThreadState = { ...th("done", 1), statusChangedAt: "2026-01-02T00:00:00.000Z" };
    expect(topicStatusFromThreads([later, th("idle", 9)])).toBe("done");
  });
  it("no threads -> null", () => {
    expect(topicStatusFromThreads([])).toBeNull();
  });
});

describe("permissions", () => {
  it("only the owner sets stale; agents cannot set wip", () => {
    expect(manualStatusError({ kind: "owner" }, "stale")).toBeNull();
    expect(manualStatusError({ kind: "owner" }, "wip")).toBeNull();
    expect(manualStatusError({ kind: "agent" }, "stale")).toMatch(/owner/);
    expect(manualStatusError({ kind: "agent" }, "wip")).toMatch(/automatic/);
    expect(manualStatusError({ kind: "agent" }, "done")).toBeNull();
  });

  it("entry kinds by actor", () => {
    const agent = { kind: "agent" } as const;
    const owner = { kind: "owner" } as const;
    const axiom = { kind: "axiom" } as const;
    expect(entryWriteError(agent, "note")).toBeNull();
    expect(entryWriteError(owner, "note")).toBeNull();
    expect(entryWriteError(agent, "authorization")).not.toBeNull();
    expect(entryWriteError(agent, "owner input")).not.toBeNull();
    expect(entryWriteError(owner, "authorization")).toBeNull();
    expect(entryWriteError(owner, "status change")).not.toBeNull();
    expect(entryWriteError(agent, "thread event")).not.toBeNull();
    expect(entryWriteError(axiom, "git event")).toBeNull();
    expect(entryWriteError(axiom, "note")).not.toBeNull();
  });
});

describe("stale prompt rule", () => {
  const input = {
    status: "idle" as const,
    lastWorkedAt: "2026-01-01T00:00:00.000Z",
    stalePromptDismissed: false,
    hasOpenStalePrompt: false,
    now: new Date("2026-01-16T00:00:00.000Z"),
    staleAfterDays: 14,
  };
  it("needs a prompt after N days idle", () => {
    expect(needsStalePrompt(input)).toBe(true);
    expect(needsStalePrompt({ ...input, now: new Date("2026-01-14T00:00:00.000Z") })).toBe(false);
    expect(needsStalePrompt({ ...input, status: "blocked" })).toBe(false);
    expect(needsStalePrompt({ ...input, stalePromptDismissed: true })).toBe(false);
    expect(needsStalePrompt({ ...input, hasOpenStalePrompt: true })).toBe(false);
  });
});
