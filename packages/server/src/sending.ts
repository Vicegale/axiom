import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { type Actor, type Axiom, AxiomError, type Thread } from "@axiom/core";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { briefing } from "./briefing.js";
import type { ChangeBus } from "./events.js";
import type { T3Project } from "./providers/t3/reader.js";
import { defaultT3Cli } from "./providers/t3/replies.js";

const owner: Actor = { kind: "owner" };
const T3_TIMEOUT_MS = 60_000;
/** How long a detached `claude -p` is watched for an early failure before the request returns. */
const CLAUDE_GRACE_MS = 1500;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * The model and effort choices of the picker. Neither `claude` nor the `t3` CLI lists models
 * (`t3 --help` has no provider or model subcommand), so this is a static list; the owner can
 * still type any model through the API.
 */
export const COMPOSE_OPTIONS = {
  source: "static",
  providers: {
    t3: {
      // T3 provider instance ids are not listed by the CLI; leave the instance to T3's default.
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
      efforts: [...EFFORTS],
    },
    "claude-code": {
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
      efforts: [...EFFORTS],
    },
  },
} as const;

/** The environment of an agent run: no Claude Code / T3 session variables, hooks stay active. */
export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "CLAUDECODE" || k === "AXIOM_INTERNAL") continue;
    if (k.startsWith("T3CODE_") || k.startsWith("CLAUDE_CODE_")) continue;
    out[k] = v;
  }
  return out;
}

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function resumeCommand(ax: Axiom, th: Pick<Thread, "id" | "providerThreadId">): string {
  const cwd = ax.threadCwd(th.id);
  const resume = `claude --resume ${th.providerThreadId}`;
  return cwd ? `cd ${q(cwd)} && ${resume}` : resume;
}

export class ProviderError extends Error {}

export interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a binary with `input` on stdin and waits for it. */
export function runCapture(
  cli: string,
  args: string[],
  input: string,
  options: { cwd?: string; timeoutMs: number },
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      cwd: options.cwd,
      env: agentEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ProviderError(`${cli} timed out after ${options.timeoutMs / 1000} s`));
    }, options.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ProviderError(`cannot run ${cli}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function failure(what: string, r: Captured): ProviderError {
  const why = (r.stderr.trim() || r.stdout.trim()).slice(0, 500);
  return new ProviderError(`${what} exited with ${r.code}${why ? `: ${why}` : ""}`);
}

/**
 * Starts `claude -p` detached: the request does not wait for the run, only for an early failure
 * (cannot start, or exits non-zero within the grace period). Later failures are logged.
 */
function spawnDetached(
  cli: string,
  args: string[],
  input: string,
  cwd: string | undefined,
  graceMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      cwd,
      env: agentEnv(process.env),
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => settle(resolve), graceMs);
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on("error", (e) =>
      settle(() => reject(new ProviderError(`cannot run ${cli}: ${e.message}`))),
    );
    child.on("close", (code) => {
      if (code === 0) return settle(resolve);
      const why = stderr.trim().slice(0, 500);
      const error = new ProviderError(`claude exited with ${code}${why ? `: ${why}` : ""}`);
      if (settled) console.error("claude run failed:", error.message);
      else settle(() => reject(error));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const textField = z.string().refine((s) => s.trim() !== "", "text is required");
const bodies = {
  send: z.strictObject({
    text: textField,
    model: z.string().min(1).optional(),
    effort: z.enum(EFFORTS).optional(),
  }),
  newThread: z.strictObject({
    text: textField,
    provider: z.enum(["t3", "claude-code"]),
    model: z.string().min(1).optional(),
    effort: z.enum(EFFORTS).optional(),
    providerInstance: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  }),
};

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AxiomError(
      "validation",
      r.error.issues
        .map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
        .join("; "),
    );
  }
  return r.data;
}

/** The id of the thread `t3 thread start --json` created. */
export function parseStartedThreadId(stdout: string): string {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new ProviderError("t3 thread start printed no JSON");
  }
  const o = (data ?? {}) as Record<string, unknown>;
  const nested = (o.thread ?? {}) as Record<string, unknown>;
  for (const v of [o.threadId, nested.id, nested.threadId, o.id]) {
    if (typeof v === "string" && v) return v;
  }
  throw new ProviderError("t3 thread start printed no thread id");
}

export interface SendingOptions {
  ax: Axiom;
  bus: ChangeBus;
  /** Binaries when the `t3Cli` / `claudeCli` settings are not set. */
  t3Cli?: string;
  claudeCli: string;
  graceMs?: number;
  /** The live T3 projects; throws when T3 cannot be read. */
  listProjects?: () => T3Project[];
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const firstLine = (text: string) => (text.trim().split("\n")[0] ?? "").trim().slice(0, 120);

export function registerSendRoutes(app: Hono, o: SendingOptions): void {
  const { ax, bus } = o;
  const setting = (key: string, fallback: string) => {
    const s = ax.getSetting(key);
    return typeof s === "string" && s ? s : fallback;
  };
  const t3Cli = () => setting("t3Cli", o.t3Cli ?? defaultT3Cli());
  const claudeCli = () => setting("claudeCli", o.claudeCli);
  const graceMs = o.graceMs ?? CLAUDE_GRACE_MS;

  const providerFailure = (c: Context, e: unknown) => {
    if (!(e instanceof ProviderError)) throw e;
    return c.json({ error: { code: "provider", message: e.message } }, 502);
  };

  // Sessions Axiom starts run with `-p`, where nobody can answer a prompt in a terminal:
  // the agent's own record keeping (the `axiom` CLI) is always allowed; anything else
  // still asks, through the PermissionRequest hook (the Desk card). The `=` form keeps
  // the variadic flag from swallowing later arguments.
  const claudeFlags = (model?: string, effort?: string) => [
    "--allowedTools=Bash(axiom *)",
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
  ];

  const body = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      throw new AxiomError("validation", "request body must be valid JSON");
    }
  };

  /**
   * The model and effort the owner chose for a send: shown on the card at once (the context is
   * unchanged; the provider reports the real values when the run finishes).
   */
  const recordChoice = (threadId: number, input: { model?: string; effort?: string }) => {
    if (input.model === undefined && input.effort === undefined) return;
    ax.setThreadRuntime(threadId, {
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    });
  };

  /** What the owner said is history. */
  const record = (topicId: number, text: string) => {
    ax.addEntry(topicId, { kind: "owner input", body: text }, owner);
  };

  app.get("/api/compose/options", (c) => c.json(COMPOSE_OPTIONS));

  app.post("/api/threads/:id/send", async (c) => {
    const idRaw = c.req.param("id");
    if (!/^\d+$/.test(idRaw)) throw new AxiomError("validation", "thread id must be an integer");
    const th = ax.getThread(Number(idRaw));
    const input = parse(bodies.send, await body(c));
    try {
      if (th.provider === "t3") {
        if (input.model !== undefined || input.effort !== undefined) {
          throw new AxiomError(
            "validation",
            "T3 cannot change the model or effort of an existing thread; start a new thread to choose them.",
          );
        }
        const r = await runCapture(
          t3Cli(),
          ["thread", "send", th.providerThreadId, "-"],
          input.text,
          {
            timeoutMs: T3_TIMEOUT_MS,
          },
        );
        if (r.code !== 0) throw failure("t3 thread send", r);
      } else if (th.provider === "claude-code") {
        if (th.endedAt === null) {
          return c.json(
            {
              error: {
                code: "conflict",
                message: "This session is open in a terminal; reply there or close it first.",
                resumeCommand: resumeCommand(ax, th),
              },
            },
            409,
          );
        }
        ax.threadReopened(th.id);
        recordChoice(th.id, input);
        try {
          await spawnDetached(
            claudeCli(),
            ["-p", "--resume", th.providerThreadId, ...claudeFlags(input.model, input.effort)],
            input.text,
            ax.threadCwd(th.id) ?? undefined,
            graceMs,
          );
        } catch (e) {
          bus.emit(); // the reopen is visible
          throw e;
        }
      } else {
        throw new AxiomError("validation", `cannot send to a ${th.provider} thread`);
      }
    } catch (e) {
      return providerFailure(c, e);
    }
    record(th.topicId, input.text);
    bus.emit();
    return c.json({ ok: true, thread: ax.getThread(th.id).id });
  });

  app.post("/api/topics/:slug/threads/new", async (c) => {
    const slug = c.req.param("slug");
    const topic = ax.getTopic(slug);
    const input = parse(bodies.newThread, await body(c));
    const repo = topic.links.find((l) => l.kind === "repository")?.target;
    const title = firstLine(input.text);
    // The agent gets its Axiom context first; history keeps only the owner's words (record below).
    const message = briefing(
      topic,
      ax.listTasks(slug),
      input.text,
      ax.listStewardItemsWithFix({ topic: slug }),
    );
    let thread: Thread;
    try {
      if (input.provider === "t3") {
        const project = input.project ?? repo;
        if (!project) {
          throw new AxiomError(
            "validation",
            "no project: give `project`, or link a repository to the topic",
          );
        }
        if (!input.project && repo) {
          // The server fell back to the repository link: check T3 would accept it.
          const bad = `This topic's folder ${repo} isn't a T3 project. Choose a project.`;
          if (!isDir(repo)) throw new AxiomError("validation", bad);
          let projects: T3Project[] | undefined;
          try {
            projects = o.listProjects?.();
          } catch {
            projects = undefined; // T3 unreadable: let the CLI decide
          }
          const inside = (p: T3Project) =>
            repo === p.workspaceRoot || repo.startsWith(`${p.workspaceRoot.replace(/\/+$/, "")}/`);
          if (projects && !projects.some(inside)) throw new AxiomError("validation", bad);
        }
        if (input.effort !== undefined && input.model === undefined) {
          throw new AxiomError("validation", "effort needs a model");
        }
        const args = ["thread", "start", project, "-", "--title", title];
        if (input.providerInstance || input.model) {
          if (!input.providerInstance || !input.model) {
            throw new AxiomError("validation", "T3 needs providerInstance and model together");
          }
          args.push("--provider", input.providerInstance, "--model", input.model);
          if (input.effort) args.push("--option", `effort=${input.effort}`);
        }
        args.push("--json");
        const r = await runCapture(t3Cli(), args, message, { timeoutMs: T3_TIMEOUT_MS });
        if (r.code !== 0) throw failure("t3 thread start", r);
        const id = parseStartedThreadId(r.stdout);
        thread = ax.attachThread(slug, { provider: "t3", providerThreadId: id, title }, owner);
        recordChoice(thread.id, input);
      } else {
        const cwd = input.cwd ?? repo;
        if (!cwd) {
          throw new AxiomError(
            "validation",
            "no folder: give `cwd`, or link a repository to the topic",
          );
        }
        const sessionId = randomUUID();
        thread = ax.attachThread(
          slug,
          { provider: "claude-code", providerThreadId: sessionId, title },
          owner,
        );
        ax.setThreadCwd(thread.id, cwd);
        recordChoice(thread.id, input);
        try {
          await spawnDetached(
            claudeCli(),
            ["-p", "--session-id", sessionId, ...claudeFlags(input.model, input.effort)],
            message,
            cwd,
            graceMs,
          );
        } catch (e) {
          bus.emit(); // the attached thread is visible
          throw e;
        }
      }
    } catch (e) {
      return providerFailure(c, e);
    }
    record(topic.id, input.text);
    bus.emit();
    return c.json(thread, 201);
  });
}
