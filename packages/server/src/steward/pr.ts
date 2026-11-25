import type { Axiom, StewardPrRecord, StewardSettings } from "@axiom/core";
import { describeGhError, GhError, ghJson, runGh } from "./gh.js";

/**
 * Watching PRs with `gh` (03, Decisions "PR signals" and "gh polling"). No model: a poll reads a
 * PR, keeps the latest snapshot and turns what changed into signals.
 */

const actor = { kind: "steward" } as const;

/** Days an open, non-draft PR may go without a reviewer before "no reviewer" is raised. */
export const NO_REVIEWER_DAYS = 3;
const DAY_MS = 86_400_000;

export type PrSignalName = StewardSettings["prSignals"][number];

export interface PrSnapshot {
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  state: string;
  draft: boolean;
  mergeable: string;
  mergeState: string;
  reviewDecision: string;
  headRef: string;
  headOid: string;
  baseRef: string;
  baseOid: string;
  createdAt: string;
  updatedAt: string;
  failedChecks: string[];
  pendingChecks: number;
  passedChecks: number;
  /** `login@submittedAt` of each reviewer whose latest review asks for changes. */
  changesRequestedBy: string[];
  approvedBy: string[];
  /** Users and teams asked to review. */
  reviewRequests: string[];
  /** Reviews written by someone other than the author. */
  reviewCount: number;
  /** Comments, review bodies and inline review comments by someone other than the author. */
  commentCount: number;
  /** The PR's changed files. */
  files: string[];
  /** Files changed on the base branch since the merge base; null when it could not be read. */
  baseChangedFiles: string[] | null;
  /** Files both the PR and the base branch changed: a conflict is coming. */
  overlap: string[];
  /** Whole days since the PR was opened, while it has had no review and no request. */
  daysWithoutReviewer: number | null;
}

/** `owner/repo#12` or a github.com pull URL, as a repo and a number; null for anything else. */
export function parsePrTarget(target: string): { repo: string; number: number } | null {
  const t = target.trim();
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(t);
  if (short) return { repo: short[1] as string, number: Number(short[2]) };
  const url = /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(t);
  if (url) return { repo: url[1] as string, number: Number(url[2]) };
  return null;
}

interface ViewJson {
  number: number;
  title: string;
  url: string;
  author?: { login?: string };
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  reviewRequests?: { login?: string; name?: string; slug?: string }[];
  latestReviews?: { author?: { login?: string }; state: string; submittedAt?: string }[];
  reviews?: { author?: { login?: string }; body?: string }[];
  comments?: { author?: { login?: string } }[];
  statusCheckRollup?: {
    __typename?: string;
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
  }[];
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  createdAt: string;
  updatedAt: string;
}

const VIEW_FIELDS = [
  "number",
  "title",
  "url",
  "author",
  "state",
  "isDraft",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "reviewRequests",
  "latestReviews",
  "reviews",
  "comments",
  "statusCheckRollup",
  "baseRefName",
  "baseRefOid",
  "headRefName",
  "headRefOid",
  "createdAt",
  "updatedAt",
].join(",");

const FAILED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);

/** Splits `statusCheckRollup` (check runs and status contexts) into failed, pending and passed. */
export function summarizeChecks(rollup: ViewJson["statusCheckRollup"]): {
  failed: string[];
  pending: number;
  passed: number;
} {
  const out = { failed: [] as string[], pending: 0, passed: 0 };
  for (const c of rollup ?? []) {
    const name = c.name ?? c.context ?? "check";
    if (c.__typename === "StatusContext" || c.state !== undefined) {
      const st = (c.state ?? "").toUpperCase();
      if (FAILED.has(st)) out.failed.push(name);
      else if (st === "PENDING" || st === "EXPECTED") out.pending++;
      else out.passed++;
      continue;
    }
    const status = (c.status ?? "").toUpperCase();
    const conclusion = (c.conclusion ?? "").toUpperCase();
    if (status && status !== "COMPLETED") out.pending++;
    else if (FAILED.has(conclusion)) out.failed.push(name);
    else out.passed++; // success, neutral, skipped, cancelled (usually superseded)
  }
  out.failed = [...new Set(out.failed)].sort();
  return out;
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Reads a PR: `gh pr view`, its files, inline comments and what changed on its base since it forked. */
export async function fetchPr(
  gh: string,
  repo: string,
  number: number,
  now: Date,
  env?: NodeJS.ProcessEnv,
): Promise<PrSnapshot> {
  const o = { env };
  const v = await ghJson<ViewJson>(
    gh,
    ["pr", "view", String(number), "-R", repo, "--json", VIEW_FIELDS],
    o,
  );
  const author = v.author?.login ?? "";
  const other = (login: string | undefined) => (login ?? "") !== author;
  const checks = summarizeChecks(v.statusCheckRollup);
  const latest = v.latestReviews ?? [];
  const open = v.state === "OPEN";

  let files: string[] = [];
  let inline = 0;
  let baseChangedFiles: string[] | null = null;
  if (open) {
    files = lines(
      await runGh(
        gh,
        ["api", `repos/${repo}/pulls/${number}/files`, "--paginate", "--jq", ".[].filename"],
        o,
      ),
    );
    inline = lines(
      await runGh(
        gh,
        ["api", `repos/${repo}/pulls/${number}/comments`, "--paginate", "--jq", ".[].user.login"],
        o,
      ),
    ).filter(other).length;
    try {
      // The three-dot compare lists what the base branch changed since the merge base.
      baseChangedFiles = lines(
        await runGh(
          gh,
          [
            "api",
            `repos/${repo}/compare/${v.headRefOid}...${v.baseRefName}`,
            "--paginate",
            "--jq",
            ".files[].filename",
          ],
          o,
        ),
      );
    } catch (e) {
      // A PR from a fork can have a head the base repository cannot compare; not fatal.
      if (e instanceof GhError && (e.kind === "missing" || e.kind === "auth")) throw e;
      baseChangedFiles = null;
    }
  }
  const overlap = baseChangedFiles ? files.filter((f) => baseChangedFiles?.includes(f)) : [];
  const reviews = (v.reviews ?? []).filter((r) => other(r.author?.login));
  const reviewRequests = (v.reviewRequests ?? []).map((r) => r.login ?? r.slug ?? r.name ?? "?");
  const ageDays = Math.floor((now.getTime() - Date.parse(v.createdAt)) / DAY_MS);
  return {
    repo,
    number,
    url: v.url,
    title: v.title,
    author,
    state: v.state,
    draft: v.isDraft,
    mergeable: v.mergeable,
    mergeState: v.mergeStateStatus,
    reviewDecision: v.reviewDecision ?? "",
    headRef: v.headRefName,
    headOid: v.headRefOid,
    baseRef: v.baseRefName,
    baseOid: v.baseRefOid,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    failedChecks: checks.failed,
    pendingChecks: checks.pending,
    passedChecks: checks.passed,
    changesRequestedBy: latest
      .filter((r) => r.state === "CHANGES_REQUESTED")
      .map((r) => `${r.author?.login ?? "?"}@${r.submittedAt ?? ""}`)
      .sort(),
    approvedBy: latest
      .filter((r) => r.state === "APPROVED")
      .map((r) => r.author?.login ?? "?")
      .sort(),
    reviewRequests: reviewRequests.sort(),
    reviewCount: reviews.length,
    commentCount:
      (v.comments ?? []).filter((c) => other(c.author?.login)).length +
      reviews.filter((r) => (r.body ?? "").trim() !== "").length +
      inline,
    files,
    baseChangedFiles,
    overlap,
    daysWithoutReviewer: reviews.length === 0 && reviewRequests.length === 0 ? ageDays : null,
  };
}

/**
 * The signals that hold for `cur`, each with a key: a signal is new when it is active and its key
 * differs from the one stored before. Only open PRs have signals. "New review comments" is an
 * event (active only for the poll that saw the count grow), so it needs a previous snapshot.
 */
export function activeSignals(
  cur: PrSnapshot,
  prev: PrSnapshot | null,
  enabled: readonly PrSignalName[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (cur.state !== "OPEN") return out;
  const on = (s: PrSignalName) => enabled.includes(s);
  if (on("ci failed") && cur.failedChecks.length > 0) {
    out["ci failed"] = `${cur.headOid}:${cur.failedChecks.join(",")}`;
  }
  if (
    on("changes requested") &&
    (cur.changesRequestedBy.length > 0 || cur.reviewDecision === "CHANGES_REQUESTED")
  ) {
    out["changes requested"] = cur.changesRequestedBy.join(",") || "decision";
  }
  if (on("new review comments") && prev && cur.commentCount > prev.commentCount) {
    out["new review comments"] = String(cur.commentCount);
  }
  if (on("conflict coming") && (cur.mergeable === "CONFLICTING" || cur.overlap.length > 0)) {
    out["conflict coming"] = `${cur.mergeable}:${cur.overlap.join(",")}`;
  }
  if (
    on("no reviewer") &&
    !cur.draft &&
    cur.daysWithoutReviewer !== null &&
    cur.daysWithoutReviewer >= NO_REVIEWER_DAYS
  ) {
    out["no reviewer"] = "yes";
  }
  if (
    on("ready to merge") &&
    !cur.draft &&
    cur.reviewDecision === "APPROVED" &&
    cur.failedChecks.length === 0 &&
    cur.pendingChecks === 0 &&
    cur.mergeable !== "CONFLICTING"
  ) {
    out["ready to merge"] = cur.headOid;
  }
  return out;
}

export interface PrSignalEvent {
  topic: string;
  repo: string;
  number: number;
  signal: string;
  detail: string;
}

export interface PollError {
  repo: string;
  number: number;
  topic: string;
  text: string;
  kind: string;
}

export interface PollResult {
  polled: number;
  signals: PrSignalEvent[];
  errors: PollError[];
}

function describeSignal(signal: string, s: PrSnapshot): string {
  switch (signal) {
    case "ci failed":
      return `CI failed: ${s.failedChecks.join(", ")}`;
    case "changes requested":
      return `changes requested by ${s.changesRequestedBy.map((r) => r.split("@")[0]).join(", ") || "a reviewer"}`;
    case "new review comments":
      return `new comments (${s.commentCount} in all)`;
    case "conflict coming":
      return s.mergeable === "CONFLICTING"
        ? "has a merge conflict"
        : `${s.baseRef} changed files this PR touches: ${s.overlap.slice(0, 5).join(", ")}`;
    case "no reviewer":
      return `no reviewer for ${s.daysWithoutReviewer} days`;
    case "ready to merge":
      return "approved and green, ready to merge";
    default:
      return signal;
  }
}

export interface PrPollerOptions {
  ax: Axiom;
  /** The `gh` binary. */
  gh: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

/** The PRs Steward watches: PR links of topics that are not `done` and have Steward on. */
export function watchedPrs(ax: Axiom): { topic: string; repo: string; number: number }[] {
  const active = new Set(
    ax
      .listTopics()
      .filter((t) => t.status !== "done" && t.stewardEnabled)
      .map((t) => t.slug),
  );
  const seen = new Set<string>();
  const out: { topic: string; repo: string; number: number }[] = [];
  for (const l of ax.listLinksOfKind("pr")) {
    if (!active.has(l.topicSlug)) continue;
    const p = parsePrTarget(l.target);
    if (!p || seen.has(`${p.repo}#${p.number}`)) continue;
    seen.add(`${p.repo}#${p.number}`);
    out.push({ topic: l.topicSlug, ...p });
  }
  return out;
}

export class PrPoller {
  /** Errors of the last poll, kept for the blind-spot checklist. */
  lastErrors: PollError[] = [];
  lastPollAt: number | null = null;
  private polling = false;

  constructor(private readonly o: PrPollerOptions) {}

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  /** Whether a poll is due `intervalMin` minutes after the last one. */
  due(intervalMin: number): boolean {
    return (
      this.lastPollAt === null || this.now().getTime() - this.lastPollAt >= intervalMin * 60_000
    );
  }

  /** Reads every watched PR that is still open (or never read) and returns the new signals. */
  async poll(): Promise<PollResult> {
    const result: PollResult = { polled: 0, signals: [], errors: [] };
    if (this.polling) return result;
    this.polling = true;
    try {
      const { ax, gh, env } = this.o;
      const enabled = ax.getStewardSettings().prSignals;
      for (const w of watchedPrs(ax)) {
        const stored = ax.getStewardPr(w.repo, w.number);
        if (stored && stored.state !== "OPEN") continue; // merged or closed: nothing more to watch
        let snap: PrSnapshot;
        try {
          snap = await fetchPr(gh, w.repo, w.number, this.now(), env);
        } catch (e) {
          result.errors.push({
            ...w,
            text: describeGhError(e),
            kind: e instanceof GhError ? e.kind : "other",
          });
          if (
            e instanceof GhError &&
            (e.kind === "missing" || e.kind === "auth" || e.kind === "rate-limit")
          ) {
            break; // the same cause would fail every PR
          }
          continue;
        }
        result.polled++;
        const prev = stored ? (stored.snapshot as PrSnapshot) : null;
        const active = activeSignals(snap, prev, enabled);
        const fired: StewardPrRecord["fired"] = [...(stored?.fired ?? [])];
        for (const [signal, key] of Object.entries(active)) {
          if (stored?.active[signal] === key) continue;
          const detail = describeSignal(signal, snap);
          fired.push({ signal, at: this.now().toISOString(), detail });
          result.signals.push({ topic: w.topic, repo: w.repo, number: w.number, signal, detail });
        }
        ax.saveStewardPr(
          { repo: w.repo, number: w.number, state: snap.state, snapshot: snap, active, fired },
          actor,
        );
      }
      this.lastErrors = result.errors;
      this.lastPollAt = this.now().getTime();
      return result;
    } finally {
      this.polling = false;
    }
  }
}
