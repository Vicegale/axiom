import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What a quiet stage 2 says. */
export const QUIET_DECISION = {
  brief: "Nothing needs you.",
  findings: [],
  questions: [],
  topicUpdates: [],
  memory: [],
};

/**
 * A fake `claude`: records argv and stdin per stage, prints `stdout` for stage 1 (gather) and
 * `decideOut` for stage 2 (decide) and `tidyOut` for the memory tidy-up (told apart by their prompts), after `sleep` seconds.
 */
export function fakeClaude(
  dir: string,
  stdout: string,
  opts: {
    sleep?: number;
    exit?: number;
    sleepAfter?: boolean;
    decideOut?: string;
    tidyOut?: string;
    /** The reply of the promoted stage (ST6) and a shell snippet it runs first, in its folder. */
    promotedOut?: string;
    promotedScript?: string;
  } = {},
) {
  const folder = join(dir, "fake-claude");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "out.gather"), stdout);
  writeFileSync(join(folder, "out.decide"), opts.decideOut ?? envelope(QUIET_DECISION));
  writeFileSync(join(folder, "out.promoted"), opts.promotedOut ?? envelope({ summary: "x" }));
  writeFileSync(join(folder, "promoted.sh"), opts.promotedScript ?? "");
  writeFileSync(
    join(folder, "out.tidy"),
    opts.tidyOut ?? envelope({ summary: "Nothing to tidy." }),
  );
  const path = join(folder, "claude");
  writeFileSync(
    path,
    `#!/bin/sh
DIR="${folder}"
for a in "$@"; do printf '%s\\n' "$a"; done > "$DIR/argv.tmp"
cat > "$DIR/stdin.tmp"
if grep -q "promoted stage of Steward" "$DIR/stdin.tmp"; then S=promoted; sh "$DIR/promoted.sh" > "$DIR/promoted.log" 2>&1; elif grep -q "stage 2 (decide)" "$DIR/stdin.tmp"; then S=decide; elif grep -q "Steward memory tidy-up" "$DIR/stdin.tmp"; then S=tidy; else S=gather; fi
mv "$DIR/argv.tmp" "$DIR/argv.$S"
mv "$DIR/stdin.tmp" "$DIR/stdin.$S"
echo x >> "$DIR/runs.$S"
${opts.sleep && !opts.sleepAfter ? `sleep ${opts.sleep}` : ""}
cat "$DIR/out.$S"
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
  type Stage = "gather" | "decide" | "tidy" | "promoted";
  return {
    path,
    /** The reply of stage 1 (gather). */
    setOut: (s: string) => writeFileSync(join(folder, "out.gather"), s),
    setDecide: (s: string) => writeFileSync(join(folder, "out.decide"), s),
    setPromoted: (out: string, script = "") => {
      writeFileSync(join(folder, "out.promoted"), out);
      writeFileSync(join(folder, "promoted.sh"), script);
    },
    setTidy: (s: string) => writeFileSync(join(folder, "out.tidy"), s),
    argv: (stage: Stage = "gather") => read(`argv.${stage}`).trimEnd().split("\n"),
    stdin: (stage: Stage = "gather") => read(`stdin.${stage}`),
    runs: (stage: Stage = "gather") => read(`runs.${stage}`).split("\n").filter(Boolean).length,
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
