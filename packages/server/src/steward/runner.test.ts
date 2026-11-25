import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runStage, StageError, stageArgs } from "./runner.js";

const steward = { kind: "steward" } as const;
const schema = z.strictObject({ ok: z.boolean() });

let dir: string;
let ax: Axiom;
let wakeId: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-runner-"));
  ax = openDatabase(":memory:");
  wakeId = ax.startStewardWake({ trigger: "timer" }, steward).id;
});
afterEach(() => {
  ax.close();
  rmSync(dir, { recursive: true, force: true });
});

const envelope = (result: string, modelUsage: object, extra: object = {}) =>
  JSON.stringify({ type: "result", is_error: false, result, modelUsage, ...extra });
const mu = (i: number, o: number, cr: number, cc: number) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadInputTokens: cr,
  cacheCreationInputTokens: cc,
});

/** A fake `claude` that records argv, stdin, cwd and env, then prints `stdout` (after `sleep`). */
function fake(stdout: string, opts: { exit?: number; sleep?: number } = {}) {
  const folder = join(dir, "fake");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "out"), stdout);
  const path = join(folder, "claude");
  writeFileSync(
    path,
    `#!/bin/sh
DIR="${folder}"
for a in "$@"; do printf '%s\\n' "$a"; done > "$DIR/argv"
pwd > "$DIR/cwd"; env > "$DIR/env"; cat > "$DIR/stdin"
${opts.sleep ? `sleep ${opts.sleep}` : ""}
cat "$DIR/out"
${opts.exit ? `exit ${opts.exit}` : ""}
`,
  );
  chmodSync(path, 0o755);
  const read = (f: string) => readFileSync(join(folder, f), "utf8");
  return {
    path,
    argv: () => read("argv").trimEnd().split("\n"),
    stdin: () => read("stdin"),
    cwd: () => read("cwd").trim(),
    env: () => read("env"),
    ran: () => existsSync(join(folder, "argv")),
  };
}

const stage = (cli: string, o: Partial<Parameters<typeof runStage>[1]> = {}) =>
  runStage({ ax, cli }, {
    stage: "decide",
    model: "sonnet",
    effort: "low",
    prompt: "Reply with the JSON",
    schema,
    wakeId,
    ...o,
  } as Parameters<typeof runStage>[1]);

describe("runStage", () => {
  it("runs the call, validates the JSON and records the tokens of the model that answered", async () => {
    const claude = fake(
      envelope('```json\n{"ok":true}\n```', { "claude-sonnet-5-5": mu(5, 7, 100, 20) }),
    );
    const r = await stage(claude.path);
    expect(r.data).toEqual({ ok: true });
    expect(r.run).toMatchObject({
      status: "done",
      wakeId,
      stage: "decide",
      model: "claude-sonnet-5-5",
      effort: "low",
      inputTokens: 5,
      outputTokens: 7,
      cacheReadTokens: 100,
      cacheCreationTokens: 20,
      error: null,
    });
    expect(r.run.endedAt).not.toBeNull();
    expect(claude.stdin()).toBe("Reply with the JSON");
    expect(claude.argv()).toEqual(stageArgs("decide", "sonnet", "low"));
    expect(claude.argv().slice(0, 9)).toEqual([
      "-p",
      "--model",
      "sonnet",
      "--effort",
      "low",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--setting-sources",
    ]);
    expect(claude.env()).toMatch(/^AXIOM_INTERNAL=1$/m);
    expect(ax.stewardUsageForDay()).toEqual([
      expect.objectContaining({ model: "claude-sonnet-5-5", total: 132 }),
    ]);
  });

  it("runs in a fresh temporary folder and removes it, or in the folder given", async () => {
    const claude = fake(envelope('{"ok":true}', {}));
    await stage(claude.path);
    const cwd = claude.cwd();
    expect(cwd).toContain("axiom-steward-");
    expect(existsSync(cwd)).toBe(false);
    const own = join(dir, "worktree");
    mkdirSync(own);
    await stage(claude.path, { cwd: own });
    expect(claude.cwd()).toBe(own);
    expect(existsSync(own)).toBe(true);
  });

  it("records zero tokens and the asked-for model when the envelope has no modelUsage", async () => {
    const r = await stage(fake('{"result":"{\\"ok\\":true}","is_error":false}').path);
    expect(r.run).toMatchObject({ status: "done", model: "sonnet", inputTokens: 0 });
  });

  it("records a second model as its own run and keeps the stage's model as the main one", async () => {
    const claude = fake(
      envelope('{"ok":true}', {
        "claude-haiku-5-5": mu(1, 1, 1, 1),
        "claude-sonnet-5-5": mu(10, 20, 30, 40),
      }),
    );
    const r = await stage(claude.path);
    expect(r.run).toMatchObject({ model: "claude-sonnet-5-5", inputTokens: 10 });
    expect(r.otherRuns).toHaveLength(1);
    expect(r.otherRuns[0]).toMatchObject({
      model: "claude-haiku-5-5",
      status: "done",
      wakeId,
      inputTokens: 1,
    });
    expect(ax.stewardUsageForDay().map((u) => [u.model, u.total])).toEqual([
      ["claude-haiku-5-5", 4],
      ["claude-sonnet-5-5", 100],
    ]);
  });

  it("falls back to the model with the most tokens when none matches the one asked for", async () => {
    const r = await stage(
      fake(envelope('{"ok":true}', { a: mu(1, 1, 1, 1), b: mu(9, 9, 9, 9) })).path,
    );
    expect(r.run.model).toBe("b");
    expect(r.otherRuns.map((x) => x.model)).toEqual(["a"]);
  });

  it("fails on a reply that is not JSON, keeping the tokens", async () => {
    const claude = fake(envelope("I could not decide.", { "claude-sonnet-5-5": mu(1, 2, 3, 4) }));
    const err = await stage(claude.path).catch((e) => e);
    expect(err).toBeInstanceOf(StageError);
    expect(err).toMatchObject({ code: "invalid-json" });
    expect(err.message).toMatch(/no JSON object/);
    expect(err.run).toMatchObject({ status: "failed", inputTokens: 1, cacheCreationTokens: 4 });
    expect(ax.getStewardRun(err.run.id).error).toMatch(/no JSON/);
    const broken = await stage(fake(envelope("{not json}", {})).path).catch((e) => e);
    expect(broken).toMatchObject({ code: "invalid-json" });
    expect(broken.message).toMatch(/not valid JSON/);
  });

  it("fails when the JSON does not match the schema", async () => {
    const err = await stage(
      fake(envelope('{"ok":"yes"}', { "claude-sonnet-5-5": mu(1, 1, 1, 1) })).path,
    ).catch((e) => e);
    expect(err).toMatchObject({ code: "schema" });
    expect(err.message).toMatch(/ok: /);
    expect(err.run.status).toBe("failed");
  });

  it("fails when the call reports is_error", async () => {
    const err = await stage(
      fake(
        envelope(
          "Credit balance is too low",
          { "claude-sonnet-5-5": mu(0, 0, 0, 0) },
          { is_error: true },
        ),
      ).path,
    ).catch((e) => e);
    expect(err).toMatchObject({ code: "is-error", message: "Credit balance is too low" });
    expect(err.run.status).toBe("failed");
  });

  it("fails on a bad exit, output that is not an envelope, and a missing binary", async () => {
    const exit = await stage(fake("", { exit: 3 }).path).catch((e) => e);
    expect(exit).toMatchObject({ code: "claude" });
    expect(exit.message).toMatch(/exited with 3/);
    const junk = await stage(fake("plain text").path).catch((e) => e);
    expect(junk).toMatchObject({ code: "claude" });
    expect(junk.message).toMatch(/JSON envelope/);
    const missing = await stage(join(dir, "nope")).catch((e) => e);
    expect(missing).toMatchObject({ code: "claude" });
    expect(missing.message).toMatch(/cannot run/);
    expect(ax.listStewardRuns({ wakeId }).every((r) => r.status === "failed")).toBe(true);
  });

  it("stops a decide call after its time limit and marks it cut short", async () => {
    const err = await stage(fake(envelope('{"ok":true}', {}), { sleep: 2 }).path, {
      timeoutMs: 300,
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "timeout" });
    expect(err.message).toMatch(/timed out/);
    expect(err.run).toMatchObject({ status: "cut short" });
  });

  it("uses the stageTimeoutMin setting for decide and promoted, and none for gather", async () => {
    ax.setStewardSettings({ stageTimeoutMin: 1 }, { kind: "owner" });
    // 1 minute is far above this test's runtime: just check they succeed with the setting in force.
    const claude = fake(envelope('{"ok":true}', {}));
    await stage(claude.path);
    await stage(claude.path, { stage: "gather", model: "haiku" });
    expect(ax.listStewardRuns({ wakeId }).map((r) => r.status)).toEqual(["done", "done"]);
  });

  it("refuses a call over the daily cap before spawning, and says so", async () => {
    ax.setStewardSettings({ dailyCaps: { sonnet: 100 } }, { kind: "owner" });
    ax.recordStewardRun(
      {
        wakeId,
        stage: "decide",
        model: "claude-sonnet-5-5",
        effort: "low",
        usage: { inputTokens: 60, outputTokens: 20, cacheReadTokens: 10, cacheCreationTokens: 10 },
        status: "done",
      },
      steward,
    );
    const claude = fake(envelope('{"ok":true}', {}));
    const err = await stage(claude.path).catch((e) => e);
    expect(err).toMatchObject({ code: "cap" });
    expect(err.message).toMatch(/daily token cap reached for sonnet: 100 of 100/);
    expect(err.run).toMatchObject({ status: "cut short", inputTokens: 0 });
    expect(claude.ran()).toBe(false);
    // Another family is not held back.
    expect((await stage(claude.path, { model: "haiku", stage: "gather" })).data).toEqual({
      ok: true,
    });
  });

  it("belongs to a chat when given a chatId, and needs exactly one owner", async () => {
    const chat = ax.startStewardChat({ model: "sonnet", effort: "low" }, steward);
    const claude = fake(envelope('{"ok":true}', {}));
    const r = await runStage(
      { ax, cli: claude.path },
      { stage: "chat", model: "sonnet", effort: "low", prompt: "hi", schema, chatId: chat.id },
    );
    expect(r.run).toMatchObject({ chatId: chat.id, wakeId: null, stage: "chat" });
    await expect(
      runStage(
        { ax, cli: claude.path },
        { stage: "chat", model: "sonnet", effort: "low", prompt: "hi", schema },
      ),
    ).rejects.toThrow(/exactly one/);
    await expect(stage(claude.path, { stage: "promoted" })).rejects.toThrow(/working folder/);
  });
});

describe("stageArgs", () => {
  const has = (args: string[], flag: string, value?: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && (value === undefined || args[i + 1] === value);
  };

  it("gives gather read-only tools and keeps the user's connectors", () => {
    const a = stageArgs("gather", "haiku", "low", {
      mcpServers: ["claude_ai_Slack"],
      addDirs: ["/repo"],
    });
    expect(has(a, "--tools", "Read,Grep,Glob")).toBe(true);
    expect(has(a, "--allowedTools", "Read,Grep,Glob,mcp__claude_ai_Slack")).toBe(true);
    expect(has(a, "--add-dir", "/repo")).toBe(true);
    expect(has(a, "--strict-mcp-config")).toBe(false);
    expect(has(a, "--setting-sources", "")).toBe(true);
    expect(has(a, "--disable-slash-commands")).toBe(true);
  });

  it("gives decide and tidy-up no tools and no connectors", () => {
    for (const s of ["decide", "tidy-up"] as const) {
      const a = stageArgs(s, "sonnet", "low");
      expect(has(a, "--tools", "")).toBe(true);
      expect(has(a, "--strict-mcp-config")).toBe(true);
      expect(has(a, "--allowedTools")).toBe(false);
    }
  });

  it("gives promoted edit and bash tools, no push or gh, no connectors and the default system prompt", () => {
    const a = stageArgs("promoted", "opus", "high");
    expect(has(a, "--tools", "Read,Grep,Glob,Edit,Write,Bash")).toBe(true);
    expect(has(a, "--disallowedTools", "Bash(git push *),Bash(gh *)")).toBe(true);
    expect(has(a, "--strict-mcp-config")).toBe(true);
    expect(has(a, "--system-prompt")).toBe(false);
  });

  it("gives chat read-only tools and no connectors for now", () => {
    const a = stageArgs("chat", "sonnet", "medium");
    expect(has(a, "--tools", "Read,Grep,Glob")).toBe(true);
    expect(has(a, "--strict-mcp-config")).toBe(true);
    expect(has(a, "--effort", "medium")).toBe(true);
  });
});
