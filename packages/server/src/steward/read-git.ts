#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Read-only git for Steward's research stages (follow-up SF2; owner, 2026-11-26: "read-only
 * allowlist"). The model runs `node <this file> <repository> <subcommand> [args...]`; the
 * permission rule allows exactly that prefix, and this script, not a wildcard, decides what is
 * read-only. A rule like `Bash(git -C * log *)` would also match `git -C x push log`, which is why
 * the check is in code.
 *
 * Allowed: the subcommands below, with options that cannot write a file, start a program or
 * change a ref. Anything else exits 2 with the reason.
 */

const SUBCOMMANDS = new Set([
  "log",
  "show",
  "diff",
  "status",
  "branch",
  "blame",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "rev-list",
  "grep",
  "describe",
  "shortlog",
  "cat-file",
  "merge-base",
  "reflog",
  "worktree",
  "remote",
  "tag",
]);

/** Options that write a file or run another program. */
const FORBIDDEN_OPTION =
  /^(--output|-O|--open-files-in-pager|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack)/;

/** For subcommands that can also write, the only forms allowed. */
function narrowCheck(sub: string, args: string[]): string | null {
  const flags = args.filter((a) => a.startsWith("-"));
  const plain = args.filter((a) => !a.startsWith("-"));
  switch (sub) {
    case "branch": {
      const listing = new Set([
        "-a",
        "--all",
        "-r",
        "--remotes",
        "-v",
        "-vv",
        "--verbose",
        "--list",
        "-l",
        "--contains",
        "--no-contains",
        "--merged",
        "--no-merged",
        "--show-current",
        "--sort",
        "--format",
        "--points-at",
        "--color=never",
        "--no-color",
      ]);
      const bad = flags.find((f) => !listing.has(f.split("=")[0] as string));
      if (bad) return `git branch ${bad} can change branches`;
      // Without --list (or a filter that takes a commit), a plain name would create a branch.
      const filters = ["--list", "-l", "--contains", "--no-contains", "--merged", "--no-merged"];
      if (plain.length > 0 && !flags.some((f) => filters.includes(f.split("=")[0] as string))) {
        return "git branch <name> creates a branch; use --list <pattern>";
      }
      return null;
    }
    case "tag":
      if (!flags.some((f) => f === "-l" || f === "--list") && (plain.length > 0 || flags.length))
        return "git tag only with -l/--list";
      return null;
    case "reflog":
      if (plain[0] && plain[0] !== "show") return "git reflog only shows";
      return null;
    case "worktree":
      if (plain[0] !== "list") return "git worktree only lists";
      return null;
    case "remote":
      if (plain.length > 0 && plain[0] !== "show" && plain[0] !== "get-url")
        return "git remote only lists or shows";
      if (plain[0] === "show" && !flags.includes("-n"))
        return "git remote show needs -n (no fetch)";
      return null;
    default:
      return null;
  }
}

/** Why the call is refused, or null when it is read-only. Exported for tests. */
export function refuseGit(args: string[]): string | null {
  const [repo, sub, ...rest] = args;
  if (!repo || !sub) return "usage: read-git <repository> <subcommand> [args...]";
  if (!SUBCOMMANDS.has(sub)) return `git ${sub} is not one of the read-only subcommands`;
  const bad = rest.find((a) => FORBIDDEN_OPTION.test(a));
  if (bad) return `${bad} can write a file or run a program`;
  return narrowCheck(sub, rest);
}

function main(argv: string[]): number {
  const why = refuseGit(argv);
  if (why) {
    process.stderr.write(`read-git refused: ${why}\n`);
    return 2;
  }
  const [repo, sub, ...rest] = argv as [string, string, ...string[]];
  const r = spawnSync(
    "git",
    ["--no-pager", "-c", "core.pager=cat", "-c", "color.ui=never", "-C", repo, sub, ...rest],
    {
      stdio: "inherit",
      // No index refresh or lock taken by status and friends.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
    },
  );
  if (r.error) {
    process.stderr.write(`read-git: ${r.error.message}\n`);
    return 1;
  }
  return r.status ?? 1;
}

/** This file's path, for the permission rule and the prompt. */
export const READ_GIT_PATH = fileURLToPath(import.meta.url);

const self = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(READ_GIT_PATH);
  } catch {
    return false;
  }
})();
if (self) process.exit(main(process.argv.slice(2)));
