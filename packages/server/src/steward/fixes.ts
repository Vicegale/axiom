import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type Axiom, AxiomError, type StewardItem, type StewardSuggestion } from "@axiom/core";
import { parsePrTarget } from "./pr.js";

/**
 * Git work for prepared fixes (ST6; 03 "Promotion"): where a fix is made, how it is verified,
 * and what the owner's clicks do. Plain `git` only: nothing here pushes, and nothing touches a
 * branch that is not Steward's own `axiom/…` branch except Adopt, on the owner's click.
 */

const owner = { kind: "owner" } as const;
/** The part of a diff shown in the view; the rest is cut and says so. */
export const DIFF_MAX_CHARS = 200_000;

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Runs `git` in `cwd` and resolves with its stdout (trimmed of the final newline). */
export function git(cwd: string, args: string[], o: GitOptions = {}): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: o.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...(o.env ?? process.env), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        if (!err) return res(stdout.replace(/\n$/, ""));
        const text = (stderr || err.message).trim();
        rej(new GitError(`git ${args[0]} failed: ${text.slice(0, 300)}`, text));
      },
    );
  });
}

/** `${XDG_DATA_HOME:-~/.local/share}/axiom/worktrees`. */
export function worktreesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "axiom", "worktrees");
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "fix";

// ---- where a fix is made -------------------------------------------------------------------

/** `owner/repo` of a git remote URL (https, ssh or scp-like); null for anything else. */
export function repoOfRemote(url: string): string | null {
  const m = /[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? (m[1] as string).toLowerCase() : null;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A link target as a local folder (`~` expanded), or null when it is not one. */
function localPath(target: string): string | null {
  const t = target.trim();
  const p = t.startsWith("~/") ? join(homedir(), t.slice(2)) : t;
  return p.startsWith("/") && isDir(p) ? resolve(p) : null;
}

export interface FoundRepository {
  /** The folder of the owner's clone (a worktree of it works as well). */
  path: string;
  /** The `repo` of `owner/repo`, or the folder's name. */
  name: string;
}

/** The finding's PR (`owner/repo#n`) from its fingerprint, or from the topic's only PR link. */
export function prOfFinding(ax: Axiom, item: StewardItem): { repo: string; number: number } | null {
  const m = /^pr:([^#]+)#(\d+):/.exec(item.fingerprint ?? "");
  if (m) return { repo: m[1] as string, number: Number(m[2]) };
  if (!item.topicSlug) return null;
  const prs = ax
    .getTopic(item.topicSlug)
    .links.filter((l) => l.kind === "pr")
    .map((l) => parsePrTarget(l.target))
    .filter((p) => p !== null);
  return prs.length === 1 ? (prs[0] as { repo: string; number: number }) : null;
}

/**
 * The owner's local clone for a finding: among the topic's `repository` and `worktree` links, the
 * one whose `origin` is the PR's repository; with no PR, the topic's first repository link that
 * is a git folder. Null when there is none.
 */
export async function findRepository(
  ax: Axiom,
  item: Pick<StewardItem, "topicSlug">,
  pr: { repo: string } | null,
): Promise<FoundRepository | null> {
  if (!item.topicSlug) return null;
  const links = ax
    .getTopic(item.topicSlug)
    .links.filter((l) => l.kind === "repository" || l.kind === "worktree")
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "repository" ? -1 : 1));
  for (const l of links) {
    const p = localPath(l.target);
    if (!p) continue;
    let top: string;
    try {
      top = await git(p, ["rev-parse", "--show-toplevel"]);
    } catch {
      continue; // not a git folder
    }
    let remote: string | null = null;
    try {
      remote = repoOfRemote(await git(top, ["config", "--get", "remote.origin.url"]));
    } catch {}
    if (pr && remote !== pr.repo.toLowerCase()) continue;
    const name = remote ? (remote.split("/")[1] as string) : basename(top);
    return { path: top, name };
  }
  return null;
}

/** A branch name free in `repo`: `base`, else `base-2`... */
export async function freeBranch(repo: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    try {
      await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    } catch {
      return name;
    }
  }
}

export interface PreparedWorktree {
  repository: string;
  branch: string;
  worktree: string;
  /** The owner's branch the fix is meant for (the PR's head branch), when known. */
  target: string | null;
  /** The commit the fix starts from. */
  baseSha: string;
}

/**
 * Creates `axiom/fix/<slug>` from the PR head (or the topic's repository default) in a new
 * worktree under the worktrees folder. The PR head is fetched from `origin` with plain git: the
 * pull ref first, then the head branch. The owner's checkout and branches are not touched.
 */
export async function prepareWorktree(o: {
  repo: FoundRepository;
  slug: string;
  pr: { number: number } | null;
  headRef: string | null;
  headOid: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<PreparedWorktree> {
  const { repo } = o;
  let start: string;
  let target: string | null = o.headRef;
  if (o.pr) {
    let fetched = false;
    for (const ref of [`refs/pull/${o.pr.number}/head`, ...(o.headRef ? [o.headRef] : [])]) {
      try {
        await git(repo.path, ["fetch", "--quiet", "origin", ref], { env: o.env });
        fetched = true;
        break;
      } catch {}
    }
    if (fetched) {
      start = await git(repo.path, ["rev-parse", "FETCH_HEAD^{commit}"]);
    } else if (o.headOid) {
      // Offline or no such ref: the commit may already be here.
      start = await git(repo.path, ["rev-parse", "--verify", `${o.headOid}^{commit}`]).catch(() => {
        throw new GitError(
          `could not fetch the head of #${o.pr?.number} from origin`,
          "fetch failed",
        );
      });
    } else {
      throw new GitError(`could not fetch the head of #${o.pr.number} from origin`, "fetch failed");
    }
  } else {
    // No PR: the repository's current branch tip when it is a branch, else its default branch.
    const head = await git(repo.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
      () => null,
    );
    target = head;
    start = await git(repo.path, ["rev-parse", "--verify", "HEAD^{commit}"]);
  }
  const branch = await freeBranch(repo.path, `axiom/fix/${slugify(o.slug)}`);
  const worktree = join(worktreesRoot(o.env), repo.name, ...branch.split("/"));
  mkdirSync(dirname(worktree), { recursive: true });
  await git(repo.path, ["worktree", "add", "-b", branch, worktree, start]);
  return { repository: repo.path, branch, worktree, target, baseSha: start };
}

/** Removes the empty folders above a removed worktree, up to (not including) the worktrees folder. */
export function pruneEmptyParents(path: string): void {
  const root = worktreesRoot();
  for (let p = dirname(path); p.startsWith(`${root}/`); p = dirname(p)) {
    try {
      rmdirSync(p); // only succeeds when empty
    } catch {
      return;
    }
  }
}

/** Removes a Steward worktree and its `axiom/…` branch. Never throws; never touches other branches. */
export async function removeFix(repository: string, worktree: string | null, branch: string) {
  if (worktree && existsSync(repository)) {
    await git(repository, ["worktree", "remove", "--force", worktree]).catch(() => {
      rmSync(worktree, { recursive: true, force: true });
    });
    await git(repository, ["worktree", "prune"]).catch(() => {});
    pruneEmptyParents(worktree);
  }
  if (branch.startsWith("axiom/") && existsSync(repository)) {
    await git(repository, ["branch", "-D", branch]).catch(() => {});
  }
}

// ---- verification --------------------------------------------------------------------------

const FORBIDDEN: [RegExp, string][] = [
  [/\bgit\b[^;&|\n]*\bpush\b/, "git push"],
  [/(^|[\s;&|(`$])gh\s/, "gh"],
  [/\b(curl|wget|ssh|scp|nc|ncat)\b/, "a network tool"],
  [/\bsudo\b/, "sudo"],
  [/\brm\s+-\S*[rf]\S*\s+(\/|~|\$HOME|\.\.)(\s|$|\/\*)/, "rm of a system folder"],
  [/\bgit\b[^;&|\n]*\b(remote|config|credential)\b/, "git remote or config"],
  [/\bmkfs|\bdd\s+if=|:\(\)\s*\{/, "a destructive command"],
];

/** Why Axiom will not run the model's test command, or null when it looks like a test run. */
export function unsafeTestCommand(cmd: string): string | null {
  const c = cmd.trim();
  if (!c) return "the test command is empty";
  if (c.length > 500) return "the test command is too long";
  if (/[\n\r]/.test(c)) return "the test command has several lines";
  for (const [re, what] of FORBIDDEN) if (re.test(c)) return `the test command uses ${what}`;
  return null;
}

/** "142/142 pass" from a test run's output when it can be read, else "pass". */
export function parseTests(output: string): string {
  const node = /^[#ℹ] tests (\d+)[\s\S]*?^[#ℹ] pass (\d+)/m.exec(output);
  if (node) return `${node[2]}/${node[1]} pass`;
  const vitest = /Tests\s+(?:\d+ failed \| )?(\d+) passed(?: \| \d+ \w+)* \((\d+)\)/.exec(output);
  if (vitest) return `${vitest[1]}/${vitest[2]} pass`;
  const jest = /Tests:\s+(?:\d+ \w+, )*(\d+) passed, (\d+) total/.exec(output);
  if (jest) return `${jest[1]}/${jest[2]} pass`;
  const py = /=+ (\d+) passed.* in /.exec(output);
  if (py) return `${py[1]}/${py[1]} pass`;
  return "pass";
}

export interface TestRun {
  ok: boolean;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Runs the test command in the worktree through a shell, with a timeout. */
export function runTests(
  cwd: string,
  cmd: string,
  o: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<TestRun> {
  return new Promise((res) => {
    execFile(
      "/bin/sh",
      ["-c", cmd],
      {
        cwd,
        timeout: o.timeoutMs ?? 5 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
        killSignal: "SIGKILL",
        env: { ...(o.env ?? process.env), CI: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
      },
      (err, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`;
        if (!err) return res({ ok: true, output, exitCode: 0, timedOut: false });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        res({
          ok: false,
          output,
          exitCode: typeof e.code === "number" ? e.code : null,
          timedOut: e.killed === true,
        });
      },
    );
  });
}

/** "+3 −1 · 1 file" from `git diff --shortstat`. */
export function formatDiffstat(shortstat: string): string {
  const files = /(\d+) files? changed/.exec(shortstat)?.[1] ?? "0";
  const ins = /(\d+) insertions?\(\+\)/.exec(shortstat)?.[1] ?? "0";
  const del = /(\d+) deletions?\(-\)/.exec(shortstat)?.[1] ?? "0";
  return `+${ins} −${del} · ${files} ${files === "1" ? "file" : "files"}`;
}

// ---- the owner's clicks --------------------------------------------------------------------

/** The suggestion's `base` column: the owner's branch and the commit the fix started from. */
export const encodeBase = (target: string | null, sha: string): string => `${target ?? ""}@${sha}`;
export function decodeBase(base: string): { target: string | null; sha: string } {
  const i = base.lastIndexOf("@");
  return i < 0
    ? { target: null, sha: base }
    : { target: base.slice(0, i) || null, sha: base.slice(i + 1) };
}

const refuse = (message: string) => new AxiomError("conflict", message);

function openFix(
  ax: Axiom,
  itemId: number,
  kinds: StewardSuggestion["kind"][] = ["fix"],
): { item: StewardItem; s: StewardSuggestion } {
  const item = ax.getStewardItem(itemId);
  if (item.kind !== "suggestion") throw refuse("that is not a prepared fix");
  if (item.state !== "open") throw refuse(`that fix was already ${item.state}`);
  const s = ax.getStewardSuggestion(itemId);
  if (!kinds.includes(s.kind)) throw refuse("only a fix can be adopted");
  if (!s.branch.startsWith("axiom/")) throw refuse("not one of Steward's branches");
  return { item, s };
}

/** The diff of a fix (its commits against the commit it started from), size-capped. */
export async function fixDiff(
  ax: Axiom,
  itemId: number,
): Promise<{ diff: string; truncated: boolean; branch: string }> {
  const item = ax.getStewardItem(itemId);
  if (item.kind !== "suggestion") throw refuse("that is not a prepared fix");
  const s = ax.getStewardSuggestion(itemId);
  const { sha } = decodeBase(s.base);
  let out: string;
  try {
    out = await git(s.repository, ["diff", "--no-color", `${sha}...${s.branch}`]);
  } catch (e) {
    throw refuse(
      e instanceof GitError ? `the branch can no longer be read: ${e.stderr.slice(0, 200)}` : "?",
    );
  }
  return out.length > DIFF_MAX_CHARS
    ? { diff: out.slice(0, DIFF_MAX_CHARS), truncated: true, branch: s.branch }
    : { diff: out, truncated: false, branch: s.branch };
}

/** Where `branch` is checked out among the repository's worktrees, or null. */
export async function checkedOutAt(repo: string, branch: string): Promise<string | null> {
  const list = await git(repo, ["worktree", "list", "--porcelain"]);
  let path: string | null = null;
  for (const line of list.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

export async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  try {
    await git(repo, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

/** Fast-forwards when the fix descends from the checked-out branch's tip, else cherry-picks. */
async function applyIn(
  cwd: string,
  fix: { branch: string; baseSha: string },
): Promise<"fast-forward" | "cherry-pick"> {
  if (await isAncestor(cwd, "HEAD", fix.branch)) {
    await git(cwd, ["merge", "--ff-only", "--quiet", fix.branch]);
    return "fast-forward";
  }
  const commits = await git(cwd, [
    "rev-list",
    "--reverse",
    "--no-merges",
    `${fix.baseSha}..${fix.branch}`,
  ]);
  const list = commits.split("\n").filter(Boolean);
  if (list.length === 0) throw refuse("the fix has no commits");
  try {
    await git(cwd, ["cherry-pick", ...list]);
  } catch (e) {
    await git(cwd, ["cherry-pick", "--abort"]).catch(() => {});
    throw refuse(
      `the fix does not apply cleanly to ${await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "your branch")}; nothing was changed${e instanceof GitError ? ` (${e.stderr.split("\n")[0]?.slice(0, 160)})` : ""}`,
    );
  }
  return "cherry-pick";
}

export interface AdoptResult {
  item: StewardItem;
  method: "fast-forward" | "cherry-pick";
  branch: string;
  tip: string;
}

/**
 * Adopt (the owner's click): brings the fix onto the owner's branch locally. Fast-forwards when the
 * fix descends from the branch's tip, else cherry-picks the fix's commits. When the branch is
 * checked out somewhere that checkout must have no uncommitted changes (else refused, with the
 * reason); when it is not, a temporary worktree does the work and is removed. Never pushes. On
 * success the item is `adopted` and Steward's own worktree and branch are removed.
 */
export async function adoptFix(ax: Axiom, itemId: number): Promise<AdoptResult> {
  const { s } = openFix(ax, itemId);
  const { target, sha } = decodeBase(s.base);
  if (!target) throw refuse("this fix has no branch of yours to go onto");
  const repo = s.repository;
  if (!existsSync(repo)) throw refuse(`the repository ${repo} is gone`);
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${target}`]);
  } catch {
    throw refuse(`you have no local branch ${target}; check it out first, then Adopt`);
  }
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${s.branch}`]);
  } catch {
    throw refuse(`Steward's branch ${s.branch} is gone`);
  }

  const fix = { branch: s.branch, baseSha: sha };
  const where = await checkedOutAt(repo, target);
  let method: "fast-forward" | "cherry-pick";
  if (where) {
    const dirty = await git(where, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty) {
      throw refuse(
        `${target} is checked out in ${where} with uncommitted changes; commit or stash them, then Adopt`,
      );
    }
    method = await applyIn(where, fix);
  } else {
    const tmp = join(worktreesRoot(), ".adopt", `${Date.now()}-${slugify(target)}`);
    mkdirSync(dirname(tmp), { recursive: true });
    await git(repo, ["worktree", "add", "--quiet", tmp, target]);
    try {
      method = await applyIn(tmp, fix);
    } finally {
      await git(repo, ["worktree", "remove", "--force", tmp]).catch(() =>
        rmSync(tmp, { recursive: true, force: true }),
      );
      await git(repo, ["worktree", "prune"]).catch(() => {});
      pruneEmptyParents(tmp);
    }
  }
  const tip = await git(repo, ["rev-parse", "--short", `refs/heads/${target}`]);
  const detail = `${method === "fast-forward" ? "Fast-forwarded" : "Cherry-picked onto"} ${target} (now ${tip}), locally; nothing was pushed.`;
  await removeFix(repo, s.worktree, s.branch);
  const item = ax.resolveStewardFix(itemId, "adopted", detail, owner);
  return { item, method, branch: target, tip };
}

/**
 * Discard (the owner's click): removes Steward's worktree and branch and marks the fix (or the
 * rebased copy of ST7) discarded.
 */
export async function discardFix(ax: Axiom, itemId: number): Promise<StewardItem> {
  const { s } = openFix(ax, itemId, ["fix", "rebase copy"]);
  await removeFix(s.repository, s.worktree, s.branch);
  return ax.resolveStewardFix(itemId, "discarded", `${s.branch} was deleted.`, owner);
}
