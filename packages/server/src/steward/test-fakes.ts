import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A fake `claude`: records argv and stdin, prints `stdout` (after `sleep` seconds). */
export function fakeClaude(
  dir: string,
  stdout: string,
  opts: { sleep?: number; exit?: number; sleepAfter?: boolean } = {},
) {
  const folder = join(dir, "fake-claude");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "out"), stdout);
  const path = join(folder, "claude");
  writeFileSync(
    path,
    `#!/bin/sh
DIR="${folder}"
for a in "$@"; do printf '%s\\n' "$a"; done > "$DIR/argv"
cat > "$DIR/stdin"
echo x >> "$DIR/runs"
${opts.sleep && !opts.sleepAfter ? `sleep ${opts.sleep}` : ""}
cat "$DIR/out"
${opts.sleep && opts.sleepAfter ? `sleep ${opts.sleep}` : ""}
${opts.exit ? `exit ${opts.exit}` : ""}
`,
  );
  chmodSync(path, 0o755);
  const read = (f: string) => {
    try {
      return readFileSync(join(folder, f), "utf8");
    } catch {
      return "";
    }
  };
  return {
    path,
    setOut: (s: string) => writeFileSync(join(folder, "out"), s),
    argv: () => read("argv").trimEnd().split("\n"),
    stdin: () => read("stdin"),
    runs: () => read("runs").split("\n").filter(Boolean).length,
  };
}

/** The envelope `claude -p --output-format json` prints for a reply. */
export function envelope(result: unknown, tokens = [10, 20, 30, 40]): string {
  const [i, o, cr, cc] = tokens as [number, number, number, number];
  return JSON.stringify({
    type: "result",
    is_error: false,
    result: typeof result === "string" ? result : JSON.stringify(result),
    modelUsage: {
      "claude-haiku-5-5": {
        inputTokens: i,
        outputTokens: o,
        cacheReadInputTokens: cr,
        cacheCreationInputTokens: cc,
      },
    },
  });
}

export interface GhRoute {
  /** Matches when the call's arguments (joined by spaces) contain this text. First match wins. */
  match: string;
  stdout?: unknown;
  stderr?: string;
  exit?: number;
}

/** A fake `gh` that answers from a routes file, which a test can rewrite between calls. */
export function fakeGh(dir: string, routes: GhRoute[]) {
  const folder = join(dir, "fake-gh");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "gh");
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("fs");
const D = ${JSON.stringify(folder)};
const args = process.argv.slice(2).join(" ");
fs.appendFileSync(D + "/calls.log", args + "\\n");
const routes = JSON.parse(fs.readFileSync(D + "/routes.json", "utf8"));
for (const r of routes) {
  if (args.includes(r.match)) {
    if (r.stdout !== undefined) process.stdout.write(typeof r.stdout === "string" ? r.stdout : JSON.stringify(r.stdout));
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exit || 0);
  }
}
process.stderr.write("gh: Not Found (HTTP 404)");
process.exit(1);
`,
  );
  chmodSync(path, 0o755);
  const set = (r: GhRoute[]) => writeFileSync(join(folder, "routes.json"), JSON.stringify(r));
  set(routes);
  return {
    path,
    set,
    calls: () =>
      (() => {
        try {
          return readFileSync(join(folder, "calls.log"), "utf8");
        } catch {
          return "";
        }
      })()
        .split("\n")
        .filter(Boolean),
  };
}

export interface PrView {
  number?: number;
  state?: string;
  isDraft?: boolean;
  mergeable?: string;
  reviewDecision?: string;
  reviewRequests?: unknown[];
  latestReviews?: unknown[];
  reviews?: unknown[];
  comments?: unknown[];
  statusCheckRollup?: unknown[];
  createdAt?: string;
  headRefOid?: string;
}

/** The JSON of `gh pr view --json ...` for PR `number` with the given differences from a quiet PR. */
export function prView(v: PrView = {}) {
  return {
    number: v.number ?? 12,
    title: "Add the thing",
    url: "https://github.com/acme/app/pull/12",
    author: { login: "me" },
    state: v.state ?? "OPEN",
    isDraft: v.isDraft ?? false,
    mergeable: v.mergeable ?? "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: v.reviewDecision ?? "",
    reviewRequests: v.reviewRequests ?? [{ __typename: "User", login: "bob" }],
    latestReviews: v.latestReviews ?? [],
    reviews: v.reviews ?? [],
    comments: v.comments ?? [],
    statusCheckRollup: v.statusCheckRollup ?? [
      { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
    baseRefName: "main",
    baseRefOid: "base1",
    headRefName: "feat/x",
    headRefOid: v.headRefOid ?? "head1",
    createdAt: v.createdAt ?? "2026-11-24T09:00:00Z",
    updatedAt: "2026-11-25T09:00:00Z",
  };
}
