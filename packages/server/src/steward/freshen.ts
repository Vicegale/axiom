import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Axiom, AxiomError, type StewardItem } from "@axiom/core";
import {
  checkedOutAt,
  DIFF_MAX_CHARS,
  type FoundRepository,
  findRepository,
  freeBranch,
  GitError,
  git,
  isAncestor,
  pruneEmptyParents,
  removeFix,
  slugify,
  worktreesRoot,
} from "./fixes.js";
import { knownRepos } from "./memory.js";
import { type PrSnapshot, watchedPrs } from "./pr.js";

/**
 * Freshening branches (ST7; 03 "Autonomy rule" and "Jobs 2"). In every wake, after the PR poll and
 * the decision, Steward looks at the head branch of each open PR of a Steward-enabled topic and,
 * when it is behind its base, either rebases the owner's branch in place (only when every
 * condition below holds), or rebases a copy as `axiom/rebase/<branch>` for the owner to adopt.
 * No model is involved. Nothing here ever pushes: the only remote command is `git fetch`.
 *
 * When (all of): the PR is open, its head branch exists locally in the PR's repository (the topic's
 * `repository`/`worktree` link whose `origin` is the PR's repository), the branch is behind
 * `origin/<base>` (that is, `origin/<base>` is not an ancestor of the branch), and either the PR's
 * "conflict coming" signal is active or the topic is in `review`. At most one rebase (in place,
 * copy or a conflicting attempt) per repository per wake. A repository whose attached memory
 * says it merges main (see `NO_REBASE`) only gets a finding, once per branch.
 *
 * In place, all of: the base is `main` or `master`; the repository has a `user.email`; the branch
 * has no merge commits above the base (a rebase would flatten them); where the branch is checked
 * out (if anywhere) that worktree has no uncommitted changes (tracked or untracked, ignored files
 * excepted) and no rebase, merge, cherry-pick or revert in progress; nobody else pushed since the
 * owner's last commit, which is: `origin/<branch>` is fetched, it is an ancestor of the local
 * branch (the local branch is not behind or diverged from it) and its tip commit has the owner's
 * `user.email` as author and as committer (a commit made on GitHub's web or by a teammate fails
 * this); and the rebase onto the fetched `origin/<base>` has no conflicts.
 *
 * Git runs without the owner's hooks (`core.hooksPath=/dev/null`) and without an editor.
 */

const steward = { kind: "steward" } as const;
const owner = { kind: "owner" } as const;

/**
 * What an attached memory item about a repository must say for Steward to only report, never
 * rebase: "merges main", "never rebase", "don't / do not / must not / should not rebase",
 * "no rebase", "not rebase". Matched case-insensitively on the item's text. To opt a repository
 * out, add a memory item attached to it (Memory page, kind repository) such as "No rebase here."
 */
export const NO_REBASE =
  /\b(?:merges?\s+main|never\s+rebas(?:e|ing)|(?:do\s+not|don[’']t|must\s+not|mustn[’']t|should\s+not|shouldn[’']t)\s+(?:be\s+)?rebas(?:e|ed|ing)|no[\s-]rebas(?:e|ing)|not\s+(?:to\s+)?rebase)\b/i;

const refuse = (message: string) => new AxiomError("conflict", message);
const short = (sha: string) => sha.slice(0, 7);

function gitEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return {
    ...(env ?? process.env),
    GIT_EDITOR: "true",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
}

const gitIn = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  git(cwd, args, { env: gitEnv(env) });

const refExists = (repo: string, ref: string, env?: NodeJS.ProcessEnv) =>
  gitIn(repo, ["rev-parse", "--verify", "--quiet", ref], env).then(
    () => true,
    () => false,
  );

/** The matching memory text when the repository's attached memory says to only report. */
export function memoryOptOut(
  ax: Axiom,
  repo: { path: string; name: string; slug: string },
): string | null {
  const names = new Set(
    [repo.slug, repo.name, repo.path, basename(repo.path)].map((n) => n.toLowerCase()),
  );
  const known = knownRepos(ax);
  for (const m of ax.listStewardMemory({ scope: "attached", attachedKind: "repo" })) {
    const key = (m.attachedKey ?? "").replace(/\/+$/, "").toLowerCase();
    const primary = (known.get(key) ?? "").replace(/\/+$/, "").toLowerCase();
    if ((names.has(key) || (primary && names.has(primary))) && NO_REBASE.test(m.text)) {
      return m.text;
    }
  }
  return null;
}

/** Why a checkout cannot be touched: uncommitted changes (tracked or untracked) or an operation in progress. */
async function checkoutProblem(cwd: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
  if (!existsSync(cwd)) return "its checkout is missing";
  if (await gitIn(cwd, ["status", "--porcelain"], env)) {
    return "your checkout has uncommitted changes";
  }
  for (const f of [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ]) {
    const p = await gitIn(cwd, ["rev-parse", "--git-path", f], env);
    if (existsSync(join(cwd, p))) {
      return "a rebase, merge or cherry-pick is in progress in your checkout";
    }
  }
  return null;
}

type Rebased = { ok: true } | { ok: false; files: string[] };

/** `git rebase <onto>` in `cwd`; on conflicts it aborts (leaving the branch as it was) and names the files. */
async function rebaseHere(cwd: string, onto: string, env?: NodeJS.ProcessEnv): Promise<Rebased> {
  try {
    await gitIn(cwd, ["rebase", "--quiet", onto], env);
    return { ok: true };
  } catch (e) {
    const files = (
      await gitIn(cwd, ["diff", "--name-only", "--diff-filter=U"], env).catch(() => "")
    )
      .split("\n")
      .filter(Boolean);
    await gitIn(cwd, ["rebase", "--abort"], env).catch(() => {});
    if (files.length === 0) throw e; // not a conflict: a real failure, tried again next wake
    return { ok: false, files };
  }
}

/** A temporary worktree under the worktrees folder, removed when `fn` ends. */
async function withTempWorktree<T>(
  repo: string,
  branch: string,
  start: { detach: string } | { checkout: string },
  env: NodeJS.ProcessEnv | undefined,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const tmp = join(worktreesRoot(env), ".freshen", `${Date.now()}-${slugify(branch)}`);
  mkdirSync(dirname(tmp), { recursive: true });
  await gitIn(
    repo,
    "detach" in start
      ? ["worktree", "add", "--quiet", "--detach", tmp, start.detach]
      : ["worktree", "add", "--quiet", tmp, start.checkout],
    env,
  );
  try {
    return await fn(tmp);
  } finally {
    await gitIn(repo, ["worktree", "remove", "--force", tmp], env).catch(() =>
      rmSync(tmp, { recursive: true, force: true }),
    );
    await gitIn(repo, ["worktree", "prune"], env).catch(() => {});
    pruneEmptyParents(tmp);
  }
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");

const ZERO = "0000000000000000000000000000000000000000";

/** Saves `tip` as `refs/axiom/backup/<branch>/<UTC timestamp>`; never overwrites a ref. */
async function saveBackup(
  repo: string,
  branch: string,
  tip: string,
  now: Date,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const base = `refs/axiom/backup/${branch}/${stamp(now)}`;
  for (let n = 1; ; n++) {
    const ref = n === 1 ? base : `${base}-${n}`;
    try {
      await gitIn(repo, ["update-ref", ref, tip, ZERO], env);
      return ref;
    } catch (e) {
      if (n > 20 || !(await refExists(repo, ref, env))) throw e;
    }
  }
}

// ---- the in-place checks and the two outcomes -----------------------------------------------

interface Subject {
  repo: FoundRepository;
  branch: string;
  base: string;
  /** The fetched `origin/<base>` and its commit. */
  baseRef: string;
  baseTip: string;
  ownTip: string;
}

/** Why the branch may not be rebased in place (a phrase), or null when every condition holds. */
async function inPlaceBlocker(s: Subject, env?: NodeJS.ProcessEnv): Promise<string | null> {
  const { repo, branch } = s;
  if (s.base !== "main" && s.base !== "master") return `the base is ${s.base}, not main`;
  const email = (
    await gitIn(repo.path, ["config", "user.email"], env).catch(() => "")
  ).toLowerCase();
  if (!email) return "the repository has no git identity (user.email)";
  const merges = await gitIn(
    repo.path,
    ["rev-list", "--merges", "--count", `${s.baseTip}..${s.ownTip}`],
    env,
  );
  if (merges !== "0") return "the branch has merge commits";
  const where = await checkedOutAt(repo.path, branch);
  if (where) {
    const problem = await checkoutProblem(where, env);
    if (problem) return problem;
  }
  try {
    await gitIn(
      repo.path,
      ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      env,
    );
  } catch {
    return `origin/${branch} could not be read`;
  }
  const remote = `refs/remotes/origin/${branch}`;
  if (!(await isAncestor(repo.path, remote, s.ownTip))) {
    return "someone else pushed to the branch (origin has commits yours lacks)";
  }
  const [ae, ce] = (await gitIn(repo.path, ["log", "-1", "--format=%ae%n%ce", remote], env))
    .toLowerCase()
    .split("\n");
  if (ae !== email || ce !== email) return `the newest commit on origin/${branch} is not yours`;
  return null;
}

type InPlace =
  | { kind: "done"; oldTip: string; newTip: string; backupRef: string }
  | { kind: "conflict"; files: string[] }
  | { kind: "blocked"; reason: string };

async function rebaseInPlace(s: Subject, now: Date, env?: NodeJS.ProcessEnv): Promise<InPlace> {
  const { repo, branch } = s;
  const ref = `refs/heads/${branch}`;
  const where = await checkedOutAt(repo.path, branch);
  if (!where) {
    // Not checked out anywhere: a temporary worktree on the branch does the rebase.
    return withTempWorktree(repo.path, branch, { checkout: branch }, env, async (tmp) => {
      const backupRef = await saveBackup(repo.path, branch, s.ownTip, now, env);
      const r = await rebaseHere(tmp, s.baseRef, env);
      if (!r.ok) {
        await gitIn(repo.path, ["update-ref", "-d", backupRef], env).catch(() => {});
        return { kind: "conflict", files: r.files } as const;
      }
      return {
        kind: "done",
        oldTip: s.ownTip,
        newTip: await gitIn(repo.path, ["rev-parse", ref], env),
        backupRef,
      } as const;
    });
  }
  // Checked out: first find out in a throwaway worktree whether it is clean, so a conflicting
  // rebase never touches the owner's checkout; then rebase where the branch is checked out.
  const dry = await withTempWorktree(repo.path, branch, { detach: s.ownTip }, env, (tmp) =>
    rebaseHere(tmp, s.baseRef, env),
  );
  if (!dry.ok) return { kind: "conflict", files: dry.files };
  const problem = await checkoutProblem(where, env);
  if (problem) return { kind: "blocked", reason: problem };
  if ((await gitIn(repo.path, ["rev-parse", ref], env)) !== s.ownTip) {
    return { kind: "blocked", reason: "the branch moved meanwhile" };
  }
  const backupRef = await saveBackup(repo.path, branch, s.ownTip, now, env);
  const r = await rebaseHere(where, s.baseRef, env);
  if (!r.ok) {
    await gitIn(repo.path, ["update-ref", "-d", backupRef], env).catch(() => {});
    return { kind: "conflict", files: r.files };
  }
  return {
    kind: "done",
    oldTip: s.ownTip,
    newTip: await gitIn(repo.path, ["rev-parse", ref], env),
    backupRef,
  };
}

/** What a rebased copy remembers (the suggestion's `base` column). */
interface CopyBase {
  /** The owner's branch the copy is for, and its tip when the copy was made. */
  target: string;
  tip: string;
  /** What it was rebased onto. */
  base: string;
  baseTip: string;
}
const encodeCopy = (c: CopyBase): string => JSON.stringify(c);
function decodeCopy(base: string): CopyBase {
  try {
    const c = JSON.parse(base) as Partial<CopyBase>;
    if (c.target && c.tip && c.base && c.baseTip) return c as CopyBase;
  } catch {}
  throw refuse("this rebased copy has no record of the branch it was made from");
}

type CopyResult = { kind: "copy"; item: StewardItem } | { kind: "conflict"; files: string[] };

async function rebaseCopy(
  ax: Axiom,
  s: Subject,
  o: { topic: string; wakeId?: number; fingerprint: string; reason: string; title: string },
  env?: NodeJS.ProcessEnv,
): Promise<CopyResult> {
  const { repo, branch } = s;
  // A copy still waiting for the same branch is replaced by the fresh one.
  for (const old of ax.listStewardItems({ state: "open" })) {
    if (old.kind !== "suggestion") continue;
    const sug = ax.getStewardSuggestion(old.id);
    if (sug.kind !== "rebase copy" || sug.repository !== repo.path) continue;
    let target: string | null = null;
    try {
      target = decodeCopy(sug.base).target;
    } catch {}
    if (target !== branch) continue;
    await removeFix(sug.repository, sug.worktree, sug.branch);
    ax.updateStewardItem(old.id, { state: "discarded" }, steward);
  }
  const name = await freeBranch(repo.path, `axiom/rebase/${branch}`);
  const wt = join(worktreesRoot(env), repo.name, ...name.split("/"));
  mkdirSync(dirname(wt), { recursive: true });
  await gitIn(repo.path, ["worktree", "add", "--quiet", "-b", name, wt, s.ownTip], env);
  try {
    const r = await rebaseHere(wt, s.baseRef, env);
    if (!r.ok) {
      await removeFix(repo.path, wt, name);
      return { kind: "conflict", files: r.files };
    }
    const commits = Number(await gitIn(wt, ["rev-list", "--count", `${s.baseTip}..HEAD`], env));
    const { item } = ax.addStewardRebaseCopy(
      {
        topic: o.topic,
        title: o.title,
        fingerprint: o.fingerprint,
        repository: repo.path,
        branch: name,
        base: encodeCopy({ target: branch, tip: s.ownTip, base: s.base, baseTip: s.baseTip }),
        worktree: wt,
        diffstat: `${o.reason} · ${commits} ${commits === 1 ? "commit" : "commits"}`,
        ...(o.wakeId !== undefined ? { wakeId: o.wakeId } : {}),
      },
      steward,
    );
    return { kind: "copy", item };
  } catch (e) {
    await removeFix(repo.path, wt, name);
    throw e;
  }
}

// ---- the wake step --------------------------------------------------------------------------

export interface FreshenOptions {
  ax: Axiom;
  wakeId?: number;
  /** Only this topic (an owner wake about one topic). */
  topic?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface FreshenResult {
  items: StewardItem[];
  /** One line per branch that needed something, or failed. */
  notes: string[];
}

const listFiles = (files: string[]) =>
  files.length > 6
    ? `${files.slice(0, 6).join(", ")} and ${files.length - 6} more`
    : files.join(", ");

/** One pass over the watched PRs' branches. A failure on one branch is logged and the pass goes on. */
export async function runFreshen(o: FreshenOptions): Promise<FreshenResult> {
  const now = o.now ?? new Date();
  const res: FreshenResult = { items: [], notes: [] };
  const busy = new Set<string>(); // repositories that had their rebase this wake
  for (const w of watchedPrs(o.ax)) {
    if (o.topic !== undefined && w.topic !== o.topic) continue;
    try {
      await freshenOne(o, w, now, busy, res);
    } catch (e) {
      console.error(`steward freshen failed for ${w.repo}#${w.number}:`, e);
      res.notes.push(`${w.repo}#${w.number}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return res;
}

async function freshenOne(
  o: FreshenOptions,
  w: { topic: string; repo: string; number: number },
  now: Date,
  busy: Set<string>,
  res: FreshenResult,
): Promise<void> {
  const { ax, env } = o;
  const rec = ax.getStewardPr(w.repo, w.number);
  const snap = rec?.snapshot as Partial<PrSnapshot> | undefined;
  if (rec?.state !== "OPEN" || !snap?.headRef || !snap.baseRef) return;
  const conflict = rec.active["conflict coming"] !== undefined;
  if (!conflict && ax.getTopic(w.topic).status !== "review") return;

  const repo = await findRepository(ax, { topicSlug: w.topic }, w);
  if (!repo || busy.has(repo.path)) return;
  const branch = snap.headRef;
  const base = snap.baseRef;
  if (!(await refExists(repo.path, `refs/heads/${branch}`, env))) return; // nothing of the owner's here
  try {
    await gitIn(
      repo.path,
      ["fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`],
      env,
    );
  } catch (e) {
    const why = e instanceof GitError ? (e.stderr.split("\n")[0] ?? "") : "?";
    res.notes.push(`${w.repo}#${w.number}: could not fetch ${base} (${why})`);
    return;
  }
  const baseRef = `refs/remotes/origin/${base}`;
  const subject: Subject = {
    repo,
    branch,
    base,
    baseRef,
    baseTip: await gitIn(repo.path, ["rev-parse", `${baseRef}^{commit}`], env),
    ownTip: await gitIn(repo.path, ["rev-parse", `refs/heads/${branch}^{commit}`], env),
  };
  if (await isAncestor(repo.path, subject.baseTip, subject.ownTip)) return; // not behind

  const pr = `${w.repo}#${w.number}`;
  const key = `${w.repo.toLowerCase()}:${branch}`;
  // One record per (branch, its tip, the base's tip), whatever came of it: done, undone, offered as
  // a copy, conflicting or dismissed, it is not tried again until one of the tips moves.
  const fingerprint = `rebase:${key}:${subject.ownTip}:${subject.baseTip}`;
  if (ax.findStewardItemByFingerprint(fingerprint)) return;
  const why = conflict
    ? `${base} changed files this branch touches (${pr})`
    : `its topic is in review (${pr})`;
  const wake = o.wakeId !== undefined ? { wakeId: o.wakeId } : {};

  const optOut = memoryOptOut(ax, { path: repo.path, name: repo.name, slug: w.repo });
  if (optOut) {
    const reportFp = `rebase-report:${key}`;
    if (ax.findStewardItemByFingerprint(reportFp)) return;
    res.items.push(
      ax.recordStewardFinding(
        {
          topic: w.topic,
          level: "info",
          signal: "rebase",
          title: `${branch} is behind ${base} (${pr})`,
          body: `Steward's memory says ${repo.name} merges ${base} or is not rebased (“${optOut.slice(0, 120)}”), so it only reports. ${why}.`,
          fingerprint: reportFp,
          ...wake,
        },
        steward,
      ),
    );
    res.notes.push(`${pr}: ${branch} is behind ${base}; reported only (memory)`);
    return;
  }

  busy.add(repo.path);
  const conflictFinding = (files: string[]) =>
    ax.recordStewardFinding(
      {
        topic: w.topic,
        level: "attention",
        signal: "rebase conflict",
        title: `conflicts rebasing ${branch} onto ${base}: ${listFiles(files)}`,
        body: `Steward tried the rebase (${why}) and it conflicts. Nothing was changed on your branch and nothing was kept.`,
        fingerprint,
        ...wake,
      },
      steward,
    );

  let blockedBy = await inPlaceBlocker(subject, env);
  if (!blockedBy) {
    const r = await rebaseInPlace(subject, now, env);
    if (r.kind === "done") {
      const { item } = ax.recordStewardRebase(
        {
          topic: w.topic,
          title: `${branch} was behind ${base} (${pr})`,
          body: `Steward rebased it locally because ${why}.`,
          entry: `Rebased ${branch} onto ${base} locally (clean): ${short(r.oldTip)} → ${short(r.newTip)}; ${why}. Old tip saved at ${r.backupRef}. Pushing is yours.`,
          fingerprint,
          data: {
            repo: repo.path,
            pr,
            branch,
            base,
            oldTip: r.oldTip,
            newTip: r.newTip,
            baseTip: subject.baseTip,
            backupRef: r.backupRef,
          },
          ...wake,
        },
        steward,
      );
      res.items.push(item);
      res.notes.push(`${pr}: rebased ${branch} onto ${base} in place`);
      return;
    }
    if (r.kind === "conflict") {
      res.items.push(conflictFinding(r.files));
      res.notes.push(`${pr}: conflicts rebasing ${branch}`);
      return;
    }
    blockedBy = r.reason;
  }
  const c = await rebaseCopy(
    ax,
    subject,
    {
      topic: w.topic,
      ...wake,
      fingerprint,
      reason: `not in place: ${blockedBy}`,
      title: `${branch} rebased onto ${base}, as a copy`,
    },
    env,
  );
  if (c.kind === "conflict") {
    res.items.push(conflictFinding(c.files));
    res.notes.push(`${pr}: conflicts rebasing ${branch}`);
  } else {
    res.items.push(c.item);
    res.notes.push(`${pr}: rebased a copy of ${branch} (${blockedBy})`);
  }
}

// ---- the owner's clicks ---------------------------------------------------------------------

interface RebaseData {
  repo: string;
  branch: string;
  oldTip: string;
  newTip: string;
  backupRef: string;
}

/**
 * Undo (the owner's click) of an in-place rebase: moves the branch back to the backup ref, but only
 * while the branch is still at the tip Steward rebased it to and, if it is checked out, that
 * checkout has no uncommitted changes (tracked or untracked) and no operation in progress. Else
 * refused with the reason. The backup ref is kept. Never pushes.
 */
export async function undoRebase(ax: Axiom, actionId: number) {
  const a = ax.listStewardActions().find((x) => x.id === actionId);
  if (!a) throw new AxiomError("not-found", `Steward action not found: ${actionId}`);
  if (a.kind !== "rebase in place") throw new AxiomError("validation", "that is not a rebase");
  if (a.undoneAt !== null) throw refuse(`action ${actionId} is already undone`);
  const d = a.data as RebaseData;
  if (!existsSync(d.repo)) throw refuse(`the repository ${d.repo} is gone`);
  const ref = `refs/heads/${d.branch}`;
  const now = await gitIn(d.repo, ["rev-parse", "--verify", "--quiet", ref]).catch(() => null);
  if (now === null) throw refuse(`the branch ${d.branch} no longer exists; nothing to undo`);
  if (now !== d.newTip) {
    throw refuse(
      `${d.branch} has moved since Steward rebased it (now ${short(now)}, Steward left it at ${short(d.newTip)}); it was not touched`,
    );
  }
  const backup = await gitIn(d.repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${d.backupRef}^{commit}`,
  ]).catch(() => null);
  if (backup !== d.oldTip) throw refuse(`the backup ref ${d.backupRef} is gone or changed`);
  const where = await checkedOutAt(d.repo, d.branch);
  if (where) {
    const problem = await checkoutProblem(where);
    if (problem) {
      throw refuse(
        `${d.branch} is checked out in ${where} and ${problem}; commit or stash, then undo`,
      );
    }
    await gitIn(where, ["reset", "--hard", "--quiet", d.oldTip]);
  } else {
    await gitIn(d.repo, ["update-ref", "-m", "axiom: undo rebase", ref, d.oldTip, d.newTip]);
  }
  return ax.markStewardRebaseUndone(
    actionId,
    `${d.branch} is back at ${short(d.oldTip)} (locally); the backup ref ${d.backupRef} is kept.`,
    owner,
  );
}

function openCopy(ax: Axiom, itemId: number) {
  const item = ax.getStewardItem(itemId);
  if (item.kind !== "suggestion") throw refuse("that is not a rebased copy");
  if (item.state !== "open") throw refuse(`that copy was already ${item.state}`);
  const s = ax.getStewardSuggestion(itemId);
  if (s.kind !== "rebase copy") throw refuse("that is not a rebased copy");
  if (!s.branch.startsWith("axiom/rebase/")) throw refuse("not one of Steward's branches");
  return { item, s, info: decodeCopy(s.base) };
}

/** Whether a suggestion is a rebased copy (its Diff and Adopt are this module's). */
export function isRebaseCopy(ax: Axiom, itemId: number): boolean {
  try {
    return ax.getStewardSuggestion(itemId).kind === "rebase copy";
  } catch {
    return false;
  }
}

/**
 * A readable account of a rebased copy: how many commits were replayed onto what, each commit's
 * old and new hash with its subject (`git range-diff`, no patches; `=` means unchanged, `!` that
 * main's changes altered it), then the stat of the copy against the base. Size-capped.
 */
export async function rebaseDiff(
  ax: Axiom,
  itemId: number,
): Promise<{ diff: string; truncated: boolean; branch: string }> {
  const item = ax.getStewardItem(itemId);
  if (item.kind !== "suggestion") throw refuse("that is not a rebased copy");
  const s = ax.getStewardSuggestion(itemId);
  if (s.kind !== "rebase copy") throw refuse("that is not a rebased copy");
  const c = decodeCopy(s.base);
  let out: string;
  try {
    const oldBase = await git(s.repository, ["merge-base", c.tip, c.baseTip]);
    const n = await git(s.repository, ["rev-list", "--count", `${c.baseTip}..${s.branch}`]);
    const rd = await git(s.repository, [
      "range-diff",
      "--no-color",
      "--no-patch",
      "--creation-factor=100",
      `${oldBase}..${c.tip}`,
      `${c.baseTip}..${s.branch}`,
    ]).catch(() =>
      git(s.repository, ["log", "--no-color", "--format=%h %s", `${c.baseTip}..${s.branch}`]),
    );
    const stat = await git(s.repository, [
      "diff",
      "--stat",
      "--no-color",
      `${c.baseTip}..${s.branch}`,
    ]);
    out = [
      `${n} ${n === "1" ? "commit" : "commits"} replayed onto ${c.base} @ ${short(c.baseTip)}`,
      "",
      rd,
      "",
      stat,
    ].join("\n");
  } catch (e) {
    throw refuse(
      e instanceof GitError ? `the branch can no longer be read: ${e.stderr.slice(0, 200)}` : "?",
    );
  }
  return out.length > DIFF_MAX_CHARS
    ? { diff: out.slice(0, DIFF_MAX_CHARS), truncated: true, branch: s.branch }
    : { diff: out, truncated: false, branch: s.branch };
}

/**
 * Adopt (the owner's click) of a rebased copy: moves the owner's branch to the copy's tip, locally.
 * Refused, with the reason, unless the owner's branch still exists and is still at the tip the copy
 * was made from, and, where it is checked out, that checkout has no uncommitted changes (tracked
 * or untracked) and nothing in progress. The old tip is saved under `refs/axiom/backup/<branch>/…`
 * first. Never pushes. On success the item is `adopted` and Steward's worktree and branch go.
 */
export async function adoptRebase(ax: Axiom, itemId: number, now: Date = new Date()) {
  const { s, info } = openCopy(ax, itemId);
  const repo = s.repository;
  if (!existsSync(repo)) throw refuse(`the repository ${repo} is gone`);
  const ref = `refs/heads/${info.target}`;
  const cur = await gitIn(repo, ["rev-parse", "--verify", "--quiet", ref]).catch(() => null);
  if (cur === null) {
    throw refuse(`you have no local branch ${info.target}; check it out first, then Adopt`);
  }
  const copy = await gitIn(repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${s.branch}`,
  ]).catch(() => null);
  if (copy === null) throw refuse(`Steward's branch ${s.branch} is gone`);
  if (cur !== info.tip) {
    throw refuse(
      `${info.target} has moved since the copy was made (now ${short(cur)}, the copy was made from ${short(info.tip)}); discard this copy and let Steward redo it`,
    );
  }
  const where = await checkedOutAt(repo, info.target);
  if (where) {
    const problem = await checkoutProblem(where);
    if (problem) {
      throw refuse(
        `${info.target} is checked out in ${where} and ${problem}; commit or stash, then Adopt`,
      );
    }
  }
  const backupRef = await saveBackup(repo, info.target, cur, now);
  if (where) await gitIn(where, ["reset", "--hard", "--quiet", copy]);
  else await gitIn(repo, ["update-ref", "-m", "axiom: adopt rebased copy", ref, copy, cur]);
  const detail = `Moved ${info.target} to the rebased copy (now ${short(copy)}), locally; the old tip ${short(cur)} is saved at ${backupRef}. Nothing was pushed.`;
  await removeFix(repo, s.worktree, s.branch);
  const item = ax.resolveStewardFix(itemId, "adopted", detail, owner);
  return { item, method: "rebase" as const, branch: info.target, tip: short(copy), backupRef };
}
