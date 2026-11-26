import { describe, expect, it } from "vitest";
import {
  AxiomError,
  countTokens,
  DEFAULT_STEWARD_SETTINGS,
  localDay,
  localDayRange,
  mergeDefaults,
  modelFamily,
} from "./index.js";
import { makeAxiom, owner } from "./test-helpers.js";

const steward = { kind: "steward" } as const;
const agent = { kind: "agent" } as const;
const usage = (i: number, o: number, cr: number, cc: number) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadTokens: cr,
  cacheCreationTokens: cc,
});

describe("helpers", () => {
  it("counts input + output + cache creation + cache read", () => {
    expect(countTokens(usage(1, 2, 4, 8))).toBe(15);
  });

  it("finds a model's family", () => {
    expect(modelFamily("claude-haiku-5-5")).toBe("haiku");
    expect(modelFamily("sonnet")).toBe("sonnet");
    expect(modelFamily("Claude-Opus-5")).toBe("opus");
    expect(modelFamily("gpt-x")).toBe("gpt-x");
  });

  it("covers a local day from midnight to midnight", () => {
    const { start, end } = localDayRange("2026-03-08");
    expect(new Date(start).getTime()).toBe(new Date(2026, 2, 8).getTime());
    expect(new Date(end).getTime()).toBe(new Date(2026, 2, 9).getTime());
    expect(localDay(new Date(2026, 2, 8, 23, 59))).toBe("2026-03-08");
    expect(() => localDayRange("tomorrow")).toThrow(/YYYY-MM-DD/);
  });

  it("merges stored values over defaults, replacing arrays and scalars", () => {
    expect(
      mergeDefaults({ a: 1, b: { c: 2, d: [1, 2] }, e: null }, { b: { d: [3] }, e: { x: 1 } }),
    ).toEqual({
      a: 1,
      b: { c: 2, d: [3] },
      e: { x: 1 },
    });
  });
});

describe("history and notifications", () => {
  it("lets Steward write a history entry as author steward, but not Axiom's kinds", () => {
    const { ax } = makeAxiom();
    ax.createTopic({ slug: "t", title: "T" }, owner);
    const e = ax.addEntry("t", { kind: "finding", body: "CI failed on #12" }, steward);
    expect(e).toMatchObject({ author: "steward", kind: "finding", threadId: null });
    expect(ax.listEntries("t").at(-1)?.author).toBe("steward");
    expect(() =>
      ax.addEntry("t", { kind: "status change", data: { from: null, to: "wip" } }, steward),
    ).toThrow(/only by Axiom/);
    expect(() => ax.addEntry("t", { kind: "owner input", body: "x" }, steward)).toThrow(
      /only by the owner/,
    );
  });

  it("accepts the steward urgent notification kind", () => {
    const { ax } = makeAxiom();
    ax.createTopic({ slug: "t", title: "T" }, owner);
    ax.raiseNotification("t", "steward urgent", "CI failed", { kind: "axiom" });
    expect(ax.listNotifications()[0]).toMatchObject({ kind: "steward urgent", topicSlug: "t" });
    expect(ax.isHighlighted("t")).toBe(true);
  });
});

describe("topic switch", () => {
  it("is on by default and only the owner turns it off", () => {
    const { ax } = makeAxiom();
    ax.createTopic({ slug: "t", title: "T" }, owner);
    expect(ax.getTopicStewardEnabled("t")).toBe(true);
    expect(() => ax.setTopicStewardEnabled("t", false, steward)).toThrow(AxiomError);
    expect(ax.setTopicStewardEnabled("t", false, owner).stewardEnabled).toBe(false);
    expect(ax.getTopic("t").stewardEnabled).toBe(false);
    expect(ax.setTopicStewardEnabled("t", true, owner).stewardEnabled).toBe(true);
  });
});

describe("settings", () => {
  it("returns the 03 defaults when nothing is stored", () => {
    const { ax } = makeAxiom();
    const s = ax.getStewardSettings();
    expect(s).toEqual(DEFAULT_STEWARD_SETTINGS);
    expect(s.workingHours).toEqual({ start: "09:00", end: "19:00", days: [1, 2, 3, 4, 5] });
    expect(s.wakeIntervalMin).toBe(30);
    expect(s.stages).toEqual({
      gather: { model: "haiku", effort: "low" },
      decide: { model: "sonnet", effort: "low" },
    });
    expect(s.complexity).toEqual({
      simple: { model: "sonnet", effort: "medium" },
      medium: { model: "opus", effort: "high" },
      hard: null,
    });
    expect(s.dailyCaps).toEqual({ haiku: 5_000_000, sonnet: 1_500_000, opus: 400_000 });
    expect(s.stageTimeoutMin).toBe(10);
    expect(s.memoryCoreTokens).toBe(2000);
    expect(s.ghPollIntervalMin).toBe(10);
    expect(s.prSignals).toHaveLength(6);
    expect(ax.getSetting("steward")).toEqual(s);
  });

  it("merges a partial change over what is stored and keeps the rest at the defaults", () => {
    const { ax } = makeAxiom();
    ax.setStewardSettings(
      { stages: { decide: { effort: "medium" } }, dailyCaps: { opus: 1 } },
      owner,
    );
    ax.setStewardSettings({ wakeIntervalMin: 60 }, owner);
    const s = ax.getStewardSettings();
    expect(s.stages.decide).toEqual({ model: "sonnet", effort: "medium" });
    expect(s.stages.gather).toEqual({ model: "haiku", effort: "low" });
    expect(s.dailyCaps).toEqual({ haiku: 5_000_000, sonnet: 1_500_000, opus: 1 });
    expect(s.wakeIntervalMin).toBe(60);
    // Stored values lay over defaults when read: a stored object missing new keys still works.
    ax.db.exec(
      "INSERT INTO setting (key, value) VALUES ('steward', '{\"enabled\":false}')".replace(
        "INSERT",
        "INSERT OR REPLACE",
      ),
    );
    expect(ax.getStewardSettings()).toEqual({ ...DEFAULT_STEWARD_SETTINGS, enabled: false });
  });

  it("allows report only (null) for a complexity level", () => {
    const { ax } = makeAxiom();
    ax.setStewardSettings({ complexity: { simple: null } }, owner);
    expect(ax.getStewardSettings().complexity.simple).toBeNull();
    expect(ax.getStewardSettings().complexity.medium).toEqual({ model: "opus", effort: "high" });
  });

  it("rejects invalid values and changes by anyone but the owner", () => {
    const { ax } = makeAxiom();
    expect(() => ax.setStewardSettings({ workingHours: { start: "9am" } }, owner)).toThrow(/HH:MM/);
    expect(() => ax.setStewardSettings({ wakeIntervalMin: 0 }, owner)).toThrow(AxiomError);
    expect(() =>
      ax.setStewardSettings({ stages: { gather: { effort: "huge" as never } } }, owner),
    ).toThrow(/Invalid setting steward/);
    expect(() => ax.setStewardSettings({ dailyCaps: { haiku: -5 } }, owner)).toThrow(AxiomError);
    expect(() => ax.setSetting("steward", { enabled: true }, owner)).toThrow(AxiomError);
    expect(() => ax.setStewardSettings({ enabled: false }, steward)).toThrow(/only the owner/);
    expect(ax.getStewardSettings()).toEqual(DEFAULT_STEWARD_SETTINGS);
  });
});

describe("wakes and runs", () => {
  it("starts and finishes a wake", () => {
    const { ax, clock } = makeAxiom();
    const w = ax.startStewardWake(
      { trigger: "event", triggerDetail: "review on mtg#219" },
      steward,
    );
    expect(w).toMatchObject({ trigger: "event", status: "running", endedAt: null, blindSpots: [] });
    expect(ax.runningStewardWake()?.id).toBe(w.id);
    clock.advanceMs(60_000);
    const done = ax.finishStewardWake(
      w.id,
      {
        status: "done",
        brief: "All quiet",
        blindSpots: [{ kind: "source unreachable", text: "Slack unreachable" }],
      },
      steward,
    );
    expect(done).toMatchObject({
      status: "done",
      brief: "All quiet",
      blindSpots: [{ kind: "source unreachable", text: "Slack unreachable" }],
      endedAt: "2026-01-01T00:01:00.000Z",
    });
    expect(ax.runningStewardWake()).toBeNull();
    expect(() => ax.finishStewardWake(w.id, { status: "failed" }, steward)).toThrow(/already done/);
    expect(() => ax.startStewardWake({ trigger: "cron" as never }, steward)).toThrow(AxiomError);
    expect(() => ax.startStewardWake({ trigger: "timer" }, agent)).toThrow(/agent/);
    ax.startStewardWake({ trigger: "owner" }, steward);
    expect(ax.listStewardWakes().map((x) => x.trigger)).toEqual(["owner", "event"]);
  });

  it("records a run with its four token counts and finishes it", () => {
    const { ax } = makeAxiom();
    const w = ax.startStewardWake({ trigger: "timer" }, steward);
    const r = ax.startStewardRun(
      { wakeId: w.id, stage: "gather", model: "haiku", effort: "low" },
      steward,
    );
    expect(r).toMatchObject({ status: "running", inputTokens: 0, wakeId: w.id, chatId: null });
    const f = ax.finishStewardRun(
      r.id,
      { status: "done", model: "claude-haiku-5-5", usage: usage(10, 20, 30, 40) },
      steward,
    );
    expect(f).toMatchObject({
      status: "done",
      model: "claude-haiku-5-5",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
    });
    expect(f.endedAt).not.toBeNull();
    expect(() => ax.finishStewardRun(r.id, { status: "failed" }, steward)).toThrow(/already done/);
    expect(ax.listStewardRuns({ wakeId: w.id })).toHaveLength(1);
  });

  it("needs exactly one of a wake and a chat, and a known stage", () => {
    const { ax } = makeAxiom();
    const w = ax.startStewardWake({ trigger: "timer" }, steward);
    const c = ax.startStewardChat({ model: "sonnet", effort: "low" }, steward);
    const base = { stage: "decide", model: "sonnet", effort: "low" } as const;
    expect(() => ax.startStewardRun({ ...base }, steward)).toThrow(/exactly one/);
    expect(() => ax.startStewardRun({ ...base, wakeId: w.id, chatId: c.id }, steward)).toThrow(
      /exactly one/,
    );
    expect(() =>
      ax.startStewardRun({ ...base, stage: "dream" as never, wakeId: w.id }, steward),
    ).toThrow(/unknown stage/);
    expect(ax.startStewardRun({ ...base, stage: "chat", chatId: c.id }, steward).chatId).toBe(c.id);
    expect(() =>
      ax.db.exec(
        "INSERT INTO steward_run (stage, model, effort, started_at) VALUES ('chat', 'm', 'low', 'x')",
      ),
    ).toThrow(/CHECK/);
  });
});

describe("usage and caps", () => {
  const record = (
    ax: ReturnType<typeof makeAxiom>["ax"],
    wakeId: number,
    model: string,
    startedAt: string,
    u: ReturnType<typeof usage>,
  ) =>
    ax.recordStewardRun(
      { wakeId, stage: "decide", model, effort: "low", startedAt, usage: u, status: "done" },
      steward,
    );

  it("sums tokens per model over the runs of a local day", () => {
    const { ax } = makeAxiom();
    const w = ax.startStewardWake({ trigger: "timer" }, steward);
    const noon = (d: number) => new Date(2026, 4, d, 12).toISOString();
    record(ax, w.id, "claude-haiku-5-5", noon(10), usage(1, 2, 3, 4));
    record(ax, w.id, "claude-haiku-5-5", noon(10), usage(10, 20, 30, 40));
    record(ax, w.id, "claude-sonnet-5-5", noon(10), usage(5, 5, 5, 5));
    record(ax, w.id, "claude-haiku-5-5", noon(11), usage(100, 0, 0, 0));
    record(
      ax,
      w.id,
      "claude-haiku-5-5",
      new Date(2026, 4, 10, 0, 0, 0).toISOString(),
      usage(1, 0, 0, 0),
    );
    expect(ax.stewardUsageForDay("2026-05-10")).toEqual([
      {
        model: "claude-haiku-5-5",
        runs: 3,
        inputTokens: 12,
        outputTokens: 22,
        cacheReadTokens: 33,
        cacheCreationTokens: 44,
        total: 111,
      },
      {
        model: "claude-sonnet-5-5",
        runs: 1,
        inputTokens: 5,
        outputTokens: 5,
        cacheReadTokens: 5,
        cacheCreationTokens: 5,
        total: 20,
      },
    ]);
    expect(ax.stewardUsageForDay("2026-05-12")).toEqual([]);
  });

  it("answers whether a call would exceed the cap of its model's family", () => {
    const { ax, clock } = makeAxiom();
    clock.set(new Date(2026, 4, 10, 15).toISOString());
    const w = ax.startStewardWake({ trigger: "timer" }, steward);
    ax.setStewardSettings({ dailyCaps: { opus: 100 } }, owner);
    expect(ax.stewardCapCheck("opus")).toMatchObject({
      allowed: true,
      used: 0,
      cap: 100,
      family: "opus",
    });
    ax.recordStewardRun(
      {
        wakeId: w.id,
        stage: "promoted",
        model: "claude-opus-5",
        effort: "high",
        usage: usage(40, 10, 20, 20),
        status: "done",
      },
      steward,
    );
    expect(ax.stewardCapCheck("opus")).toMatchObject({ allowed: true, used: 90, cap: 100 });
    ax.recordStewardRun(
      {
        wakeId: w.id,
        stage: "promoted",
        model: "claude-opus-5",
        effort: "high",
        usage: usage(10, 0, 0, 0),
        status: "done",
      },
      steward,
    );
    expect(ax.stewardCapCheck("opus")).toMatchObject({ allowed: false, used: 100, cap: 100 });
    expect(ax.stewardCapCheck("claude-opus-5").allowed).toBe(false);
    // Another family and another day are unaffected; a family without a cap is never refused.
    expect(ax.stewardCapCheck("haiku").allowed).toBe(true);
    expect(ax.stewardCapCheck("opus", "2026-05-11")).toMatchObject({ allowed: true, used: 0 });
    expect(ax.stewardCapCheck("some-other-model")).toMatchObject({ allowed: true, cap: null });
  });
});

describe("items", () => {
  it("adds items, answers a question and finds one by fingerprint", () => {
    const { ax } = makeAxiom();
    ax.createTopic({ slug: "t", title: "T" }, owner);
    const w = ax.startStewardWake({ trigger: "timer" }, steward);
    const f = ax.addStewardItem(
      {
        kind: "finding",
        wakeId: w.id,
        topic: "t",
        level: "attention",
        title: "CI failed",
        body: "lint",
        signal: "CI failed",
        fingerprint: "pr:12:ci",
      },
      steward,
    );
    expect(f).toMatchObject({
      state: "open",
      kind: "finding",
      level: "attention",
      resolvedAt: null,
      wakeId: w.id,
    });
    expect(f.topicId).toBe(ax.getTopic("t").id);
    const q = ax.addStewardItem(
      { kind: "question", title: "Is it done?", fingerprint: "t:done?" },
      steward,
    );
    expect(q.topicId).toBeNull();
    const a = ax.updateStewardItem(q.id, { state: "answered", answer: " yes " }, owner);
    expect(a).toMatchObject({ state: "answered", answer: "yes" });
    expect(a.resolvedAt).not.toBeNull();
    expect(ax.findStewardItemByFingerprint("pr:12:ci")?.id).toBe(f.id);
    expect(ax.findStewardItemByFingerprint("nope")).toBeNull();
    expect(ax.listStewardItems({ state: "open" }).map((i) => i.id)).toEqual([f.id]);
    expect(ax.listStewardItems({ topic: "t" }).map((i) => i.id)).toEqual([f.id]);
  });

  it("returns the newest item of a fingerprint, whatever its state", () => {
    const { ax } = makeAxiom();
    const a = ax.addStewardItem({ kind: "finding", title: "x", fingerprint: "fp" }, steward);
    ax.updateStewardItem(a.id, { state: "dismissed" }, owner);
    expect(ax.findStewardItemByFingerprint("fp")).toMatchObject({ id: a.id, state: "dismissed" });
    const b = ax.addStewardItem({ kind: "finding", title: "x again", fingerprint: "fp" }, steward);
    expect(ax.findStewardItemByFingerprint("fp")?.id).toBe(b.id);
  });

  it("enforces the state transitions", () => {
    const { ax } = makeAxiom();
    const i = ax.addStewardItem({ kind: "suggestion", title: "Fix" }, steward);
    expect(() => ax.updateStewardItem(i.id, { state: "answered" }, owner)).toThrow(
      /needs the answer/,
    );
    expect(() => ax.updateStewardItem(i.id, { state: "adopted", answer: "x" }, owner)).toThrow(
      /only an answered/,
    );
    expect(() => ax.updateStewardItem(i.id, { state: "open" as never }, owner)).toThrow(AxiomError);
    expect(ax.updateStewardItem(i.id, { state: "adopted" }, owner).state).toBe("adopted");
    expect(ax.updateStewardItem(i.id, { state: "undone" }, owner).state).toBe("undone");
    expect(() => ax.updateStewardItem(i.id, { state: "dismissed" }, owner)).toThrow(
      /cannot become/,
    );
    const j = ax.addStewardItem({ kind: "finding", title: "x" }, steward);
    ax.updateStewardItem(j.id, { state: "discarded" }, owner);
    expect(() => ax.updateStewardItem(j.id, { state: "undone" }, owner)).toThrow(/cannot become/);
    expect(() => ax.updateStewardItem(i.id, { state: "dismissed" }, agent)).toThrow(/agent/);
  });

  it("validates item input, links an entry and a parent finding", () => {
    const { ax } = makeAxiom();
    ax.createTopic({ slug: "t", title: "T" }, owner);
    expect(() => ax.addStewardItem({ kind: "finding", title: "  " }, steward)).toThrow(/title/);
    expect(() =>
      ax.addStewardItem({ kind: "finding", title: "x", level: "loud" as never }, steward),
    ).toThrow(AxiomError);
    expect(() =>
      ax.addStewardItem({ kind: "finding", title: "x", topic: "nope" }, steward),
    ).toThrow(/not found/);
    const f = ax.addStewardItem({ kind: "finding", title: "x", topic: "t" }, steward);
    const entry = ax.addEntry("t", { kind: "finding", body: "x" }, steward);
    expect(ax.setStewardItemEntry(f.id, entry.id, steward).entryId).toBe(entry.id);
    const s = ax.addStewardItem(
      { kind: "suggestion", title: "Prepared fix", parentItemId: f.id },
      steward,
    );
    expect(s.parentItemId).toBe(f.id);
    // Deleting the entry only clears the link.
    ax.deleteEntry(entry.id, owner);
    expect(ax.getStewardItem(f.id).entryId).toBeNull();
  });

  it("records suggestions and undoable actions", () => {
    const { ax } = makeAxiom();
    const f = ax.addStewardItem({ kind: "finding", title: "x" }, steward);
    const s = ax.addStewardSuggestion(
      f.id,
      {
        repository: "/r",
        branch: "axiom/fix/a",
        base: "main",
        kind: "fix",
        complexity: "simple",
        diffstat: "+3 -1 · 1 file",
        tests: "142/142 pass",
        worktree: "/w",
      },
      steward,
    );
    expect(s).toMatchObject({
      itemId: f.id,
      kind: "fix",
      complexity: "simple",
      tests: "142/142 pass",
    });
    expect(ax.listStewardSuggestions(f.id)).toEqual([s]);
    expect(() =>
      ax.addStewardSuggestion(
        f.id,
        { repository: "/r", branch: "b", base: "main", kind: "patch" as never },
        steward,
      ),
    ).toThrow(AxiomError);
    expect(() =>
      ax.addStewardSuggestion(
        999,
        { repository: "/r", branch: "b", base: "main", kind: "fix" },
        steward,
      ),
    ).toThrow(/not found/);
    const a = ax.recordStewardAction(
      { itemId: f.id, kind: "status change", data: { from: "review", to: "done" } },
      steward,
    );
    expect(a).toMatchObject({
      kind: "status change",
      data: { from: "review", to: "done" },
      undoneAt: null,
    });
    expect(ax.markStewardActionUndone(a.id, owner).undoneAt).not.toBeNull();
    expect(() => ax.markStewardActionUndone(a.id, owner)).toThrow(/already undone/);
    expect(ax.listStewardActions({ itemId: f.id })).toHaveLength(1);
    expect(() => ax.recordStewardAction({ itemId: f.id, kind: "push" as never }, steward)).toThrow(
      AxiomError,
    );
  });
});

describe("memory", () => {
  it("adds, updates, retires and deletes, by the owner or Steward", () => {
    const { ax } = makeAxiom();
    const core = ax.addStewardMemory(
      { scope: "core", text: " Never touch main ", source: "wake" },
      steward,
    );
    expect(core).toMatchObject({
      scope: "core",
      text: "Never touch main",
      source: "wake",
      retiredAt: null,
      attachedKind: null,
    });
    const att = ax.addStewardMemory(
      {
        scope: "attached",
        attachedKind: "repo",
        attachedKey: "/r/mtg",
        text: "merges main",
        source: "chat",
      },
      steward,
    );
    const gen = ax.addStewardMemory(
      { scope: "general", text: "likes terse", source: "owner" },
      owner,
    );
    expect(gen.source).toBe("owner");
    expect(ax.addStewardMemory({ scope: "general", text: "x", source: "wake" }, owner).source).toBe(
      "owner",
    );
    expect(ax.listStewardMemory({ scope: "core" }).map((m) => m.id)).toEqual([core.id]);
    expect(
      ax.listStewardMemory({ attachedKind: "repo", attachedKey: "/r/mtg" }).map((m) => m.id),
    ).toEqual([att.id]);
    const up = ax.updateStewardMemory(core.id, "Never touch main or release", owner);
    expect(up.text).toBe("Never touch main or release");
    ax.retireStewardMemory(att.id, steward);
    expect(ax.listStewardMemory({ scope: "attached" })).toEqual([]);
    expect(
      ax.listStewardMemory({ scope: "attached", includeRetired: true })[0].retiredAt,
    ).not.toBeNull();
    ax.deleteStewardMemory(att.id, steward);
    expect(ax.listStewardMemory({ includeRetired: true }).map((m) => m.id)).not.toContain(att.id);
    expect(() => ax.getStewardMemory(att.id)).toThrow(/not found/);
  });

  it("refuses agents and Axiom's own actor, and bad attachments", () => {
    const { ax } = makeAxiom();
    const m = ax.addStewardMemory({ scope: "general", text: "x", source: "wake" }, steward);
    for (const who of [agent, { kind: "axiom" } as const]) {
      expect(() =>
        ax.addStewardMemory({ scope: "general", text: "y", source: "wake" }, who),
      ).toThrow(/owner or Steward/);
      expect(() => ax.updateStewardMemory(m.id, "z", who)).toThrow(/owner or Steward/);
      expect(() => ax.deleteStewardMemory(m.id, who)).toThrow(/owner or Steward/);
    }
    expect(() =>
      ax.addStewardMemory({ scope: "attached", text: "x", source: "wake" }, steward),
    ).toThrow(AxiomError);
    expect(() =>
      ax.addStewardMemory(
        { scope: "attached", attachedKind: "topic", text: "x", source: "wake" },
        steward,
      ),
    ).toThrow(/key/);
    expect(() =>
      ax.addStewardMemory(
        { scope: "core", attachedKind: "topic", attachedKey: "t", text: "x", source: "wake" },
        steward,
      ),
    ).toThrow(/not attached/);
    expect(() =>
      ax.addStewardMemory({ scope: "core", text: "x", source: "owner" }, steward),
    ).toThrow(/not from the owner/);
    expect(() =>
      ax.addStewardMemory({ scope: "core", text: " ", source: "wake" }, steward),
    ).toThrow(/text/);
  });
});

describe("chat", () => {
  it("keeps a chat and its messages, one linking the memory it noted", () => {
    const { ax } = makeAxiom();
    const c = ax.startStewardChat({ model: "opus", effort: "high" }, steward);
    expect(ax.getStewardChat(c.id)).toMatchObject({ model: "opus", effort: "high" });
    const mem = ax.addStewardMemory({ scope: "general", text: "fact", source: "chat" }, steward);
    ax.addStewardMessage(c.id, { role: "owner", text: "remember this" }, owner);
    const reply = ax.addStewardMessage(
      c.id,
      { role: "steward", text: "noted", memoryItemId: mem.id },
      steward,
    );
    expect(ax.listStewardMessages(c.id).map((m) => [m.role, m.text, m.memoryItemId])).toEqual([
      ["owner", "remember this", null],
      ["steward", "noted", mem.id],
    ]);
    ax.deleteStewardMemory(mem.id, owner);
    expect(ax.listStewardMessages(c.id)[1].memoryItemId).toBeNull();
    expect(reply.chatId).toBe(c.id);
    expect(ax.listStewardChats().map((x) => x.id)).toEqual([c.id]);
    expect(() =>
      ax.addStewardMessage(c.id, { role: "robot" as never, text: "x" }, steward),
    ).toThrow(AxiomError);
    expect(() => ax.addStewardMessage(99, { role: "owner", text: "x" }, owner)).toThrow(
      /not found/,
    );
    expect(() => ax.startStewardChat({ model: "opus", effort: "turbo" as never }, steward)).toThrow(
      AxiomError,
    );
  });
});

describe("prepared fixes", () => {
  const fixInput = {
    title: "Fix the sum",
    repository: "/r",
    branch: "axiom/fix/x",
    base: "feature@abc",
    worktree: "/w",
    complexity: "simple" as const,
    diffstat: "+1 −1 · 1 file",
    tests: "2/2 pass",
  };

  it("adds a suggestion inside its finding with a history entry, and the owner resolves it", () => {
    const { ax } = makeAxiom();
    ax.createTopic({ slug: "t", title: "T" }, owner);
    const f = ax.recordStewardFinding(
      {
        topic: "t",
        level: "attention",
        title: "CI failed",
        fingerprint: "fp",
        promotion: "simple",
      },
      steward,
    );
    ax.setStewardItemNote(f.id, "report only", steward);
    expect(ax.getStewardItem(f.id).note).toBe("report only");
    const { item, suggestion } = ax.addStewardFix(f.id, fixInput, steward);
    expect(item).toMatchObject({ kind: "suggestion", parentItemId: f.id, fingerprint: "fix:fp" });
    expect(suggestion).toMatchObject({ kind: "fix", branch: "axiom/fix/x", tests: "2/2 pass" });
    expect(ax.getStewardSuggestion(item.id).id).toBe(suggestion.id);
    expect(ax.listEntries("t").at(-1)).toMatchObject({ author: "steward" });
    expect(() => ax.addStewardFix(item.id, fixInput, steward)).toThrow(/belongs to a finding/);
    expect(() => ax.resolveStewardFix(item.id, "adopted", "x", steward)).toThrow(/owner/);
    expect(() => ax.resolveStewardFix(f.id, "adopted", "x", owner)).toThrow(/only a suggestion/);
    const done = ax.resolveStewardFix(item.id, "adopted", "Fast-forwarded.", owner);
    expect(done.state).toBe("adopted");
    expect(ax.getStewardItem(f.id).note).toBe("fix adopted: Fast-forwarded.");
    expect(ax.listEntries("t").at(-1)).toMatchObject({ author: "owner" });
  });
});
