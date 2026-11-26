/**
 * `axiom update [--dry-run] [install options]`: brings the live Axiom up to the latest `main`.
 *
 * 1. Finds the development checkout: the live `axiom` runs from the release copy, a git worktree of
 *    the checkout (scripts/install.sh), so the checkout is the worktree's common git folder.
 * 2. Fast-forwards the checkout's `main` from its upstream (e.g. origin/main): `git merge --ff-only`
 *    when `main` is checked out there, else `git fetch <remote> <branch>:main`. It never merges or
 *    rebases: a `main` with commits of its own is refused.
 * 3. Runs the checkout's `scripts/install.sh --ref main`, which moves the release copy, rebuilds,
 *    re-points the commands, hooks and skill, and restarts the service on the new build. Other
 *    options (`--yes`, `--no-hooks`, ...) go to install.sh as they are.
 *
 * Dispatched in index.ts before commander, like `axiom server`, so it can hand install.sh the
 * terminal and return its exit code.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BRANCH = "main";

export interface UpdateIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface UpdateOptions {
  /** A folder inside the copy of Axiom this command runs from (default: this file's folder). */
  from?: string;
  /** Test seam: runs install.sh with the terminal attached; returns its exit code. */
  runInstall?: (script: string, args: string[], cwd: string) => number;
}

/** `["update", ...]` without `--db` / `--json`, or null when this isn't `axiom update`. */
export function updateArgs(argv: readonly string[]): string[] | null {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--db") i++;
    else if (a !== "--json") rest.push(a);
  }
  return rest[0] === "update" ? rest.slice(1) : null;
}

class UpdateError extends Error {}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.error) throw new UpdateError(`git not found (${r.error.message})`);
  if (r.status !== 0) {
    const why = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
    throw new UpdateError(`git ${args.join(" ")} failed${why ? `:\n${why}` : ""}`);
  }
  return (r.stdout ?? "").trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/** The worktree (the checkout itself included) that has `branch` checked out, if any. */
function checkedOutAt(repo: string, branch: string): string | null {
  let path: string | null = null;
  for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

const short = (repo: string, rev: string) => git(repo, ["rev-parse", "--short", rev]);

const defaultInstall = (script: string, args: string[], cwd: string): number => {
  const r = spawnSync("bash", [script, ...args], { cwd, stdio: "inherit" });
  if (r.error) throw new UpdateError(`could not run ${script}: ${r.error.message}`);
  return r.status ?? 1;
};

export function runUpdate(args: string[], io: UpdateIo, o: UpdateOptions = {}): number {
  const help = args.includes("--help") || args.includes("-h");
  if (help) {
    io.out(
      [
        "Usage: axiom update [--dry-run] [install options]",
        "",
        "Pulls the latest main into your Axiom checkout (fast-forward only), then runs its",
        "scripts/install.sh --ref main: rebuilds the release copy, re-points the commands, hooks",
        "and skill, and restarts the service. Install options such as --yes or --no-hooks are",
        "passed to install.sh (see scripts/install.sh --help).",
        "",
        "  --dry-run  show what would be pulled and installed; change nothing",
      ].join("\n"),
    );
    return 0;
  }
  const dryRun = args.includes("--dry-run");
  const installArgs = args.filter((a) => a !== "--dry-run");
  try {
    const here = o.from ?? dirname(fileURLToPath(import.meta.url));
    const app = tryGit(here, ["rev-parse", "--show-toplevel"]);
    if (!app) {
      throw new UpdateError(
        `this axiom (${here}) isn't in a git checkout; update by running scripts/install.sh from your Axiom checkout`,
      );
    }
    const common = resolve(app, git(app, ["rev-parse", "--git-common-dir"]));
    const repo = dirname(common);
    const script = join(repo, "scripts", "install.sh");
    if (!existsSync(script)) throw new UpdateError(`no scripts/install.sh in ${repo}`);

    const remote = tryGit(repo, ["config", `branch.${BRANCH}.remote`]);
    const merge = tryGit(repo, ["config", `branch.${BRANCH}.merge`]);
    if (!remote || !merge) {
      throw new UpdateError(
        `${BRANCH} in ${repo} has no upstream to pull from; set one with: git -C ${repo} branch -u origin/${BRANCH} ${BRANCH}`,
      );
    }
    const upstream = `${remote}/${merge.replace(/^refs\/heads\//, "")}`;
    io.out(`Checkout:     ${repo}`);
    if (app !== repo) io.out(`Release copy: ${app}`);

    io.out(`Fetching ${upstream}...`);
    git(repo, ["fetch", "--quiet", remote, merge]);
    const fetched = git(repo, ["rev-parse", "FETCH_HEAD^{commit}"]);
    const local = git(repo, ["rev-parse", `refs/heads/${BRANCH}^{commit}`]);
    const isAncestor = (a: string, b: string) =>
      spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", a, b]).status === 0;

    if (local === fetched || isAncestor(fetched, local)) {
      io.out(
        local === fetched
          ? `${BRANCH} is up to date with ${upstream} (${short(repo, local)})`
          : `${BRANCH} (${short(repo, local)}) is ahead of ${upstream}; installing it as it is`,
      );
    } else if (!isAncestor(local, fetched)) {
      throw new UpdateError(
        `${BRANCH} (${short(repo, local)}) and ${upstream} (${short(repo, fetched)}) have diverged; reconcile them in ${repo}, then run axiom update again`,
      );
    } else {
      const range = `${short(repo, local)}..${short(repo, fetched)}`;
      const n = Number(git(repo, ["rev-list", "--count", `${local}..${fetched}`]));
      const count = `${n} commit${n === 1 ? "" : "s"}`;
      if (dryRun) {
        io.out(`Would fast-forward ${BRANCH} ${range} (${count})`);
      } else {
        // Where main is checked out (the checkout or another worktree) its files move with it.
        const where = checkedOutAt(repo, BRANCH);
        if (where) git(where, ["merge", "--ff-only", "--quiet", fetched]);
        else git(repo, ["update-ref", `refs/heads/${BRANCH}`, fetched, local]);
        io.out(`Fast-forwarded ${BRANCH} ${range} (${count})`);
      }
    }

    const full = ["--ref", BRANCH, ...(app !== repo ? ["--app-dir", app] : []), ...installArgs];
    if (dryRun) {
      io.out(`Would run: ${script} ${full.join(" ")}`);
      return 0;
    }
    io.out(`Running ${script} ${full.join(" ")}`);
    return (o.runInstall ?? defaultInstall)(script, full, repo);
  } catch (e) {
    if (e instanceof UpdateError) {
      io.err(`axiom: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
