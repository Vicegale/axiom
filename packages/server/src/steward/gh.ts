import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const FALLBACK_GH = "/usr/bin/gh";

/** `gh` on PATH, else the system install, else the bare name. Looked up once at server start. */
export function findGh(env: NodeJS.ProcessEnv = process.env): string {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, "gh");
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  try {
    accessSync(FALLBACK_GH, constants.X_OK);
    return FALLBACK_GH;
  } catch {}
  return "gh";
}

export type GhErrorKind = "missing" | "auth" | "rate-limit" | "not-found" | "other";

/** A failed `gh` call, sorted into the few causes Steward reports as a blind spot. */
export class GhError extends Error {
  constructor(
    readonly kind: GhErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "GhError";
  }
}

function classify(stderr: string): GhErrorKind {
  const s = stderr.toLowerCase();
  if (/rate limit|secondary rate|abuse detection/.test(s)) return "rate-limit";
  if (/gh auth login|not logged in|authentication|bad credentials|http 401|gh_token/.test(s)) {
    return "auth";
  }
  if (/http 404|not found|could not resolve to/.test(s)) return "not-found";
  return "other";
}

export interface RunGhOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Runs `gh` with `args` (read-only calls only) and resolves with its stdout. Rejects with a GhError. */
export function runGh(cli: string, args: string[], options: RunGhOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      args,
      {
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...(options.env ?? process.env), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EACCES") {
          return reject(new GhError("missing", `cannot run ${cli}: ${err.message}`));
        }
        const text = (stderr || err.message).trim().slice(0, 300);
        reject(new GhError(classify(text), text));
      },
    );
  });
}

/** Runs `gh` and parses its stdout as JSON. */
export async function ghJson<T>(cli: string, args: string[], o?: RunGhOptions): Promise<T> {
  const out = await runGh(cli, args, o);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new GhError("other", `gh ${args.slice(0, 2).join(" ")} did not return JSON`);
  }
}

/** Why a GhError is a blind spot, in a sentence. */
export function describeGhError(e: unknown): string {
  if (e instanceof GhError) {
    switch (e.kind) {
      case "missing":
        return "gh is not installed";
      case "auth":
        return "gh is not logged in (run gh auth login)";
      case "rate-limit":
        return "GitHub's rate limit was hit";
      case "not-found":
        return "not found, or no access";
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
