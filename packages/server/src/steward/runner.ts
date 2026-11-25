import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Axiom,
  type Effort,
  modelFamily,
  type StewardRun,
  type StewardStage,
  type TokenCounts,
} from "@axiom/core";
import type { z } from "zod";
import { ClaudeTimeoutError, spawnClaude } from "../claude.js";

/**
 * One stage of Steward: one headless Claude Code call (ADR 0006). The prompt goes in on stdin, a
 * JSON object comes out, is validated with the stage's zod schema, and the call is recorded as a
 * `steward_run` with its tokens per model.
 */

const actor = { kind: "steward" } as const;

/** What a stage tells the model about itself. The user message carries the actual task. */
export const STAGE_SYSTEM_PROMPT =
  "You are one stage of Steward, a background assistant of the Axiom tracker. Follow the instructions in the user message. Reply with exactly one JSON object and nothing else: no Markdown fence, no commentary.";

/**
 * Flags that trim what a headless call loads (measured in docs/plan/steward.md, ST1): no setting
 * sources (user and project settings, hooks, permission rules) and no slash commands or skills.
 */
const TRIM_FLAGS = ["--setting-sources", "", "--disable-slash-commands"];

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
const PROMOTED_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
/** Promoted work never pushes or talks to GitHub: Axiom does anything with side effects. */
const PROMOTED_DENIED = ["Bash(git push *)", "Bash(gh *)"];

export interface StageToolOptions {
  /**
   * Gather only: connector (MCP) servers whose tools the stage may call, by name (for example
   * `claude_ai_Slack`). A headless call denies any tool not allowed, and a rule per server
   * (`mcp__<server>`) is the form Claude Code accepts; `mcp__*` is not. Without a server named
   * here, gather still starts the user's connectors but cannot use them.
   */
  mcpServers?: string[];
  /** Folders outside `cwd` the read-only tools may read (for example a repository). */
  addDirs?: string[];
}

/** The claude CLI arguments of a stage. Exported so tests and docs show the exact flags. */
export function stageArgs(
  stage: StewardStage,
  model: string,
  effort: Effort,
  tools: StageToolOptions = {},
): string[] {
  const base = [
    "-p",
    "--model",
    model,
    "--effort",
    effort,
    "--no-session-persistence",
    "--output-format",
    "json",
    ...TRIM_FLAGS,
  ];
  const dirs = (tools.addDirs ?? []).flatMap((d) => ["--add-dir", d]);
  switch (stage) {
    case "gather": {
      // Read-only tools plus the user's MCP connectors: no --strict-mcp-config here.
      const allowed = [...READ_ONLY_TOOLS, ...(tools.mcpServers ?? []).map((s) => `mcp__${s}`)];
      return [
        ...base,
        "--tools",
        READ_ONLY_TOOLS.join(","),
        "--allowedTools",
        allowed.join(","),
        ...dirs,
        "--system-prompt",
        STAGE_SYSTEM_PROMPT,
      ];
    }
    case "promoted":
      // Edit and run commands inside the working folder (the Steward worktree); no connectors.
      // The default system prompt stays: this stage writes code.
      return [
        ...base,
        "--tools",
        PROMOTED_TOOLS.join(","),
        "--allowedTools",
        PROMOTED_TOOLS.join(","),
        "--disallowedTools",
        PROMOTED_DENIED.join(","),
        "--strict-mcp-config",
      ];
    case "chat":
      // Read-only for now.
      return [
        ...base,
        "--tools",
        READ_ONLY_TOOLS.join(","),
        "--allowedTools",
        READ_ONLY_TOOLS.join(","),
        ...dirs,
        "--strict-mcp-config",
        "--system-prompt",
        STAGE_SYSTEM_PROMPT,
      ];
    default:
      // decide and tidy-up: no tools, no connectors; everything they need is in the prompt.
      return [
        ...base,
        "--tools",
        "",
        "--strict-mcp-config",
        "--system-prompt",
        STAGE_SYSTEM_PROMPT,
      ];
  }
}

export type StageErrorCode =
  | "cap"
  | "timeout"
  | "claude"
  | "is-error"
  | "invalid-json"
  | "schema"
  | "usage";

export class StageError extends Error {
  constructor(
    readonly code: StageErrorCode,
    message: string,
    /** The recorded run. */
    readonly run: StewardRun,
  ) {
    super(message);
    this.name = "StageError";
  }
}

export interface StageContext {
  ax: Axiom;
  /** The `claude` binary. */
  cli: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunStageOptions<T> extends StageToolOptions {
  stage: StewardStage;
  model: string;
  effort: Effort;
  prompt: string;
  schema: z.ZodType<T>;
  /** A fresh temporary folder when not given (the Steward worktree for a promoted stage). */
  cwd?: string;
  /** Default: the `stageTimeoutMin` setting for decide, promoted and tidy-up; none otherwise. */
  timeoutMs?: number;
  /** Exactly one of `wakeId` and `chatId`. */
  wakeId?: number;
  chatId?: number;
}

export interface StageResult<T> {
  data: T;
  run: StewardRun;
  /** Extra runs recorded when the call used a second model. */
  otherRuns: StewardRun[];
  /** The model's reply as text. */
  text: string;
}

interface ModelUsageEntry extends TokenCounts {
  model: string;
}

/** Reads `modelUsage` of the JSON envelope into the four token counts per model. */
export function parseModelUsage(envelope: Record<string, unknown>): ModelUsageEntry[] {
  const mu = envelope.modelUsage;
  if (typeof mu !== "object" || mu === null) return [];
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return Object.entries(mu as Record<string, Record<string, unknown>>).map(([model, u]) => ({
    model,
    inputTokens: n(u?.inputTokens),
    outputTokens: n(u?.outputTokens),
    cacheReadTokens: n(u?.cacheReadInputTokens),
    cacheCreationTokens: n(u?.cacheCreationInputTokens),
  }));
}

const total = (u: TokenCounts) =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;

/** The envelope's model matching the one asked for, else the one that used the most tokens. */
function mainUsage(usage: ModelUsageEntry[], asked: string): ModelUsageEntry | undefined {
  const family = modelFamily(asked);
  return (
    usage.find((u) => modelFamily(u.model) === family) ??
    [...usage].sort((a, b) => total(b) - total(a))[0]
  );
}

/** Finds the outermost {...} in the reply and parses it. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("the reply is not valid JSON");
  }
}

export async function runStage<T>(
  ctx: StageContext,
  o: RunStageOptions<T>,
): Promise<StageResult<T>> {
  const { ax } = ctx;
  if ((o.wakeId === undefined) === (o.chatId === undefined)) {
    throw new Error("a stage belongs to exactly one of a wake and a chat");
  }
  if (o.stage === "promoted" && !o.cwd) {
    throw new Error("a promoted stage needs its working folder (the Steward worktree)");
  }
  const owner = o.wakeId !== undefined ? { wakeId: o.wakeId } : { chatId: o.chatId as number };
  const run = ax.startStewardRun(
    { ...owner, stage: o.stage, model: o.model, effort: o.effort },
    actor,
  );
  const fail = (code: StageErrorCode, message: string, usage?: ModelUsageEntry[]): StageError => {
    const status = code === "cap" || code === "timeout" ? "cut short" : "failed";
    const main = usage ? mainUsage(usage, o.model) : undefined;
    const finished = ax.finishStewardRun(
      run.id,
      { status, error: message, ...(main ? { model: main.model, usage: main } : {}) },
      actor,
    );
    return new StageError(code, message, finished);
  };

  const cap = ax.stewardCapCheck(o.model);
  if (!cap.allowed) {
    throw fail(
      "cap",
      `daily token cap reached for ${cap.family}: ${cap.used} of ${cap.cap} tokens used today`,
    );
  }

  const timeoutMs =
    o.timeoutMs ??
    (o.stage === "decide" || o.stage === "promoted" || o.stage === "tidy-up"
      ? ax.getStewardSettings().stageTimeoutMin * 60_000
      : undefined);
  const cwd = o.cwd ?? mkdtempSync(join(tmpdir(), "axiom-steward-"));
  let stdout: string;
  try {
    stdout = await spawnClaude(ctx.cli, o.prompt, {
      args: stageArgs(o.stage, o.model, o.effort, o),
      cwd,
      env: ctx.env,
      timeoutMs,
    });
  } catch (e) {
    if (e instanceof ClaudeTimeoutError) throw fail("timeout", e.message);
    throw fail("claude", e instanceof Error ? e.message : String(e));
  } finally {
    if (!o.cwd) rmSync(cwd, { recursive: true, force: true });
  }

  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    envelope = parsed as Record<string, unknown>;
  } catch {
    throw fail("claude", "claude did not return a JSON envelope");
  }
  const usage = parseModelUsage(envelope);
  const text = typeof envelope.result === "string" ? envelope.result : "";
  if (envelope.is_error === true) throw fail("is-error", text || "claude reported an error", usage);

  let data: T;
  try {
    const checked = o.schema.safeParse(extractJsonObject(text));
    if (!checked.success) {
      const detail = checked.error.issues
        .map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
        .join("; ");
      throw fail("schema", `the reply does not match the stage's schema: ${detail}`, usage);
    }
    data = checked.data;
  } catch (e) {
    if (e instanceof StageError) throw e;
    throw fail("invalid-json", e instanceof Error ? e.message : String(e), usage);
  }

  const main = mainUsage(usage, o.model);
  const finished = ax.finishStewardRun(
    run.id,
    { status: "done", ...(main ? { model: main.model, usage: main } : {}) },
    actor,
  );
  // A second model used by the call (for example a helper) counts against its own cap.
  const otherRuns = usage
    .filter((u) => u !== main)
    .map((u) =>
      ax.recordStewardRun(
        {
          ...owner,
          stage: o.stage,
          model: u.model,
          effort: o.effort,
          startedAt: run.startedAt,
          usage: u,
          status: "done",
        },
        actor,
      ),
    );
  return { data, run: finished, otherRuns, text };
}
