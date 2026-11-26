import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "../index.js";
import { nextWorkingTime, Steward } from "./scheduler.js";
import { buildStewardView, deskStewardStrips, stewardCount } from "./view.js";

const owner = { kind: "owner" } as const;
const steward = { kind: "steward" } as const;
/** Local time: Wed 2026-11-25 10:00 plus offsets. */
const at = (h: number, m = 0, day = 25) => new Date(2026, 10, day, h, m);
let t: Date;
let ax: Axiom;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-view-"));
  t = at(10);
  ax = openDatabase(":memory:", { now: () => t });
  ax.createTopic({ slug: "alpha", title: "Alpha", goal: "Ship alpha" }, owner);
});
afterEach(() => {
  ax.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("nextWorkingTime", () => {
  const hours = { start: "09:00", end: "19:00", days: [1, 2, 3, 4, 5] };
  it("keeps a time inside the hours and moves others to the next start", () => {
    expect(nextWorkingTime(hours, at(10))).toEqual(at(10));
    expect(nextWorkingTime(hours, at(20))).toEqual(at(9, 0, 26));
    expect(nextWorkingTime(hours, at(7))).toEqual(at(9));
    // Friday evening goes to Monday.
    expect(nextWorkingTime(hours, at(20, 0, 27))).toEqual(at(9, 0, 30));
    expect(nextWorkingTime({ ...hours, days: [7] }, at(10))).toEqual(at(9, 0, 29));
  });
});

describe("Steward.nextWakeAt", () => {
  const make = () => new Steward({ ax, claudeCli: "x", ghCli: "x", now: () => t, tickMs: 0 });
  it("is null while off, else the last wake plus the interval inside the hours", () => {
    const s = make();
    expect(s.nextWakeAt()).toBeNull();
    ax.setStewardSettings({ enabled: true }, owner);
    expect(s.nextWakeAt()).toBe(at(10).toISOString()); // never woke: now
    const w = ax.startStewardWake({ trigger: "timer" }, steward);
    ax.finishStewardWake(w.id, { status: "done" }, steward);
    expect(s.nextWakeAt()).toBe(at(10, 30).toISOString());
    t = at(19, 40);
    expect(s.nextWakeAt()).toBe(at(9, 0, 26).toISOString()); // after hours: tomorrow
  });
});

function seed() {
  const w = ax.startStewardWake({ trigger: "timer" }, steward);
  ax.setStewardWakeBlindSpots(
    w.id,
    [{ kind: "source unreachable", text: "Slack is unreachable", ref: "slack" }],
    steward,
  );
  ax.recordStewardRun(
    {
      wakeId: w.id,
      stage: "gather",
      model: "claude-haiku-5-5",
      effort: "low",
      status: "done",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 0 },
    },
    steward,
  );
  ax.finishStewardWake(w.id, { status: "done", brief: "CI broke on alpha." }, steward);
  const urgent = ax.recordStewardFinding(
    { wakeId: w.id, topic: "alpha", level: "urgent", title: "CI failed", body: "Snapshot" },
    steward,
  );
  ax.recordStewardFinding(
    { wakeId: w.id, topic: "alpha", level: "attention", title: "No reviewer" },
    steward,
  );
  ax.recordStewardFinding({ wakeId: w.id, topic: "alpha", level: "info", title: "FYI" }, steward);
  ax.addStewardItem(
    { kind: "question", wakeId: w.id, topic: "alpha", title: "Skip Slack?" },
    steward,
  );
  return { w, urgent };
}

describe("the Steward view", () => {
  it("groups open items, counts what needs the owner and totals tokens", () => {
    seed();
    const v = buildStewardView(ax, "2026-11-25T10:30:00.000Z");
    expect(v.nextWakeAt).toBe("2026-11-25T10:30:00.000Z");
    expect(v.needs.map((i) => i.title)).toEqual(["CI failed", "No reviewer"]);
    expect(v.needs[0]).toMatchObject({ notified: true, topicSlug: "alpha" });
    expect(v.needs[1]?.notified).toBe(false);
    expect(v.questions.map((i) => i.title)).toEqual(["Skip Slack?"]);
    expect(v.info.map((i) => i.title)).toEqual(["FYI"]);
    expect(v.ready).toEqual([]);
    expect(v.count).toBe(3);
    expect(stewardCount(ax)).toBe(3);
    expect(v.brief).toMatchObject({ text: "CI broke on alpha." });
    expect(v.brief?.wake.tokens).toBe(150);
    expect(v.brief?.wake.stages[0]).toMatchObject({ stage: "gather", tokens: 150 });
    expect(v.wakes[0]?.summary).toBe("3 findings · 1 question");
    expect(v.sources.slack).toMatchObject({ on: true, ok: false });
    expect(v.sources.googleDrive).toMatchObject({ on: true, ok: true });
    const haiku = v.usage.find((u) => u.family === "haiku");
    expect(haiku).toMatchObject({ used: 150, cap: 5_000_000, runs: 1 });
    expect(v.usage.map((u) => u.family)).toEqual(["haiku", "sonnet", "opus"]);
  });

  it("is empty and quiet with no wakes", () => {
    const v = buildStewardView(ax, null);
    expect(v).toMatchObject({
      enabled: false,
      brief: null,
      needs: [],
      questions: [],
      wakes: [],
      memory: [],
      count: 0,
    });
    expect(v.sources.github.ok).toBeNull();
  });

  it("joins a status change with its undo action and drops it once undone", () => {
    ax.setTopicStatus("alpha", "review", owner);
    const { item, action } = ax.stewardTidyStatus(
      { topic: "alpha", to: "done", reason: "PR merged", title: "Moved Alpha to done" },
      steward,
    );
    const v = buildStewardView(ax, null);
    expect(v.info[0]).toMatchObject({ id: item.id, action: { id: action.id, undoneAt: null } });
    ax.undoStewardAction(action.id, owner);
    expect(buildStewardView(ax, null).info).toEqual([]);
  });
});

describe("the routes", () => {
  it("serves /api/steward, /count and the settings, and takes Steward's settings whole", async () => {
    const server = await startServer({
      dbPath: join(dir, "axiom.db"),
      port: 0,
      webDist: join(dir, "no-web"),
      t3Dir: join(dir, "no-t3"),
      claudeCli: "/nonexistent/claude",
      ghCli: "/nonexistent/gh",
      stewardTickMs: 0,
    });
    try {
      const get = async (p: string) => (await fetch(`${server.url}${p}`)).json();
      expect(await get("/api/steward/count")).toEqual({ count: 0 });
      expect(await get("/api/steward")).toMatchObject({ enabled: false, nextWakeAt: null });
      const settings = (await get("/api/settings")) as { steward: Record<string, unknown> };
      expect(settings.steward.enabled).toBe(false);
      const put = (body: unknown) =>
        fetch(`${server.url}/api/settings`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const res = await put({ steward: { ...settings.steward, enabled: true } });
      expect(res.status).toBe(200);
      const view = (await get("/api/steward")) as { enabled: boolean; nextWakeAt: string | null };
      expect(view.enabled).toBe(true);
      expect(typeof view.nextWakeAt).toBe("string");
      expect((await put({ steward: { ...settings.steward, wakeIntervalMin: 0 } })).status).toBe(
        400,
      );
      expect((await put({ steward: { enabled: true } })).status).toBe(400);
    } finally {
      await server.close();
    }
  });
});

describe("the Desk strips", () => {
  const alpha = () => ax.getTopic("alpha").id;
  it("picks urgent first, with its prepared fix, and counts the rest", () => {
    const { w, urgent } = seed();
    ax.addStewardFix(
      urgent.id,
      {
        title: "Fix for CI",
        repository: "/r",
        branch: "axiom/fix/ci",
        base: "main",
        worktree: "/w",
        complexity: "simple",
        diffstat: "1 file",
        tests: "pass",
        wakeId: w.id,
      },
      steward,
    );
    const s = deskStewardStrips(ax).get(alpha());
    expect(s).toMatchObject({
      itemId: urgent.id,
      kind: "finding",
      level: "urgent",
      title: "CI failed",
      fix: { branch: "axiom/fix/ci", kind: "fix" },
      more: 2, // the attention finding and the question; the fix belongs to its finding
    });
    expect(s?.fix?.itemId).not.toBe(urgent.id);
  });

  it("falls to attention, then a question; info alone gets no strip", () => {
    const { urgent } = seed();
    ax.dismissStewardItem(urgent.id, owner);
    expect(deskStewardStrips(ax).get(alpha())).toMatchObject({
      title: "No reviewer",
      fix: null,
      more: 1,
    });
    const attention = ax.listStewardItems({ state: "open" }).find((i) => i.title === "No reviewer");
    ax.dismissStewardItem(attention?.id as number, owner);
    expect(deskStewardStrips(ax).get(alpha())).toMatchObject({
      kind: "question",
      title: "Skip Slack?",
      more: 0,
    });
    const q = ax.listStewardItems({ state: "open" }).find((i) => i.kind === "question");
    ax.dismissStewardItem(q?.id as number, owner);
    expect(deskStewardStrips(ax).has(alpha())).toBe(false);
  });
});
