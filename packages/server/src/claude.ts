import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const FALLBACK_CLAUDE = "/opt/claude-code/bin/claude";

/** `claude` on PATH, else the system install, else the bare name. Looked up once at server start. */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, "claude");
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  try {
    accessSync(FALLBACK_CLAUDE, constants.X_OK);
    return FALLBACK_CLAUDE;
  } catch {}
  return "claude";
}

/** The environment of a headless run: no Claude Code / T3 session variables, hook disabled. */
export function summaryEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "CLAUDECODE" || k.startsWith("T3CODE_") || k.startsWith("CLAUDE_CODE_")) continue;
    out[k] = v;
  }
  out.AXIOM_INTERNAL = "1";
  return out;
}

export interface SpawnClaudeOptions {
  args: string[];
  cwd: string;
  /** Default `process.env`; always passed through `summaryEnv`. */
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this long. Default: no limit. */
  timeoutMs?: number;
}

export class ClaudeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs / 1000} s`);
  }
}

/** Runs `cli` with `prompt` on stdin and resolves with its stdout. Rejects on a bad exit or timeout. */
export function spawnClaude(
  cli: string,
  prompt: string,
  options: SpawnClaudeOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, options.args, {
      cwd: options.cwd,
      env: summaryEnv(options.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => finish(() => reject(new Error(`cannot run ${cli}: ${e.message}`))));
    child.on("close", (code) =>
      finish(() => {
        if (timedOut) reject(new ClaudeTimeoutError(options.timeoutMs ?? 0));
        else if (code !== 0) {
          reject(new Error(`claude exited with ${code}: ${err.trim().slice(0, 300)}`));
        } else resolve(out);
      }),
    );
    child.stdin.on("error", () => {}); // a process that exits early closes the pipe
    child.stdin.end(prompt);
  });
}
