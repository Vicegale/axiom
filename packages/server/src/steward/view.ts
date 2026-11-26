import {
  type Axiom,
  countTokens,
  type StewardAction,
  type StewardBlindSpot,
  type StewardFamilyUsage,
  type StewardItem,
  type StewardMemory,
  type StewardRun,
  type StewardSuggestion,
  type StewardWake,
} from "@axiom/core";

/**
 * What the Steward page shows (ST4), in one read: the brief and its wake's stages, blind spots,
 * the open items grouped as the page lays them out, Steward's own status changes, token use today
 * per model family against its cap, the latest wakes, and the read-only memory core.
 */

export interface StewardSourceState {
  /** The source is switched on in settings. */
  on: boolean;
  /** Reachable at the last wake's checklist; null when off or no wake has checked yet. */
  ok: boolean | null;
  reason: string | null;
}

export interface StewardViewItem extends StewardItem {
  /** Urgent findings on a topic also raised a desktop notification. */
  notified: boolean;
  /** A status change Steward made for this item, with undo while it still holds. */
  action: StewardAction | null;
  /** The branch of a suggestion (a prepared fix), and the model that made it. */
  fix: StewardViewFix | null;
  /** The prepared fix that sits inside this finding (ST6), while it is open. */
  prepared: StewardViewFix | null;
}

export interface StewardViewFix {
  /** The suggestion item's id: Adopt, Diff and Discard act on it. */
  itemId: number;
  title: string;
  branch: string;
  kind: StewardSuggestion["kind"];
  complexity: StewardSuggestion["complexity"];
  diffstat: string | null;
  tests: string | null;
  /** `repo#n` of the pull request the fix is for, when there is one. */
  forRef: string | null;
  /** The model and effort that wrote it, as run. */
  model: string | null;
  effort: StewardRun["effort"] | null;
}

export interface StewardViewStage {
  runId: number;
  stage: StewardRun["stage"];
  model: string;
  effort: StewardRun["effort"];
  status: StewardRun["status"];
  error: string | null;
  tokens: number;
  /** What the stage did, in a few words. */
  did: string;
}

export interface StewardViewWake {
  id: number;
  trigger: StewardWake["trigger"];
  triggerDetail: string | null;
  startedAt: string;
  endedAt: string | null;
  status: StewardWake["status"];
  error: string | null;
  tokens: number;
  summary: string;
  stages: StewardViewStage[];
}

export type StewardViewUsage = StewardFamilyUsage;

export interface StewardView {
  enabled: boolean;
  nextWakeAt: string | null;
  running: boolean;
  count: number;
  brief: { text: string; at: string; wake: StewardViewWake } | null;
  blindSpots: StewardBlindSpot[];
  sources: {
    github: StewardSourceState;
    slack: StewardSourceState;
    googleDrive: StewardSourceState;
  };
  needs: StewardViewItem[];
  questions: StewardViewItem[];
  ready: StewardViewItem[];
  info: StewardViewItem[];
  usage: StewardViewUsage[];
  wakes: StewardViewWake[];
  memory: StewardMemory[];
}

/** Open questions, urgent and attention findings and open suggestions: what needs the owner. */
export function stewardCount(ax: Axiom): number {
  return ax
    .listStewardItems({ state: "open" })
    .filter(
      (i) =>
        i.kind === "question" ||
        (i.kind === "suggestion" && i.parentItemId === null) ||
        (i.kind === "finding" && (i.level === "urgent" || i.level === "attention")),
    ).length;
}

/** What a Desk card shows of Steward's open items on its topic: the most important, and the rest. */
export interface DeskSteward {
  /** The item the strip shows. */
  itemId: number;
  kind: StewardItem["kind"];
  level: StewardItem["level"];
  title: string;
  /** A prepared fix for it: Adopt and Diff act on this suggestion item. */
  fix: { itemId: number; branch: string; kind: StewardSuggestion["kind"] } | null;
  /** The other open items that need the owner, shown as "N more in Steward". */
  more: number;
}

/**
 * Per topic id, the strip for its Desk card. Only what needs the owner counts, as in the tab's
 * count: urgent findings first, then attention findings, then questions, then standalone
 * suggestions (a rebase copy); the newest first within a rank. Info items get no strip. A fix
 * that sits inside an open finding belongs to that finding and is not counted on its own.
 */
export function deskStewardStrips(ax: Axiom): Map<number, DeskSteward> {
  const open = ax.listStewardItems({ state: "open" });
  const openFindingIds = new Set(open.filter((i) => i.kind === "finding").map((i) => i.id));
  const rank = (i: StewardItem): number =>
    i.kind === "finding"
      ? i.level === "urgent"
        ? 0
        : i.level === "attention"
          ? 1
          : -1
      : i.kind === "question"
        ? 2
        : i.parentItemId === null || !openFindingIds.has(i.parentItemId)
          ? 3
          : -1;
  const byTopic = new Map<number, StewardItem[]>();
  for (const i of open) {
    if (i.topicId === null || rank(i) < 0) continue;
    byTopic.set(i.topicId, [...(byTopic.get(i.topicId) ?? []), i]);
  }
  const strips = new Map<number, DeskSteward>();
  for (const [topicId, items] of byTopic) {
    const sorted = items.sort((a, b) => rank(a) - rank(b) || b.id - a.id);
    const top = sorted[0] as StewardItem;
    const fixItem =
      top.kind === "suggestion"
        ? top
        : top.kind === "finding"
          ? open.find((x) => x.kind === "suggestion" && x.parentItemId === top.id)
          : undefined;
    const sug = fixItem ? ax.listStewardSuggestions(fixItem.id)[0] : undefined;
    strips.set(topicId, {
      itemId: top.id,
      kind: top.kind,
      level: top.level,
      title: top.title,
      fix: fixItem && sug ? { itemId: fixItem.id, branch: sug.branch, kind: sug.kind } : null,
      more: sorted.length - 1,
    });
  }
  return strips;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function wakeView(ax: Axiom, w: StewardWake, items: StewardItem[]): StewardViewWake {
  const mine = items.filter((i) => i.wakeId === w.id);
  const count = (kind: StewardItem["kind"]) => mine.filter((i) => i.kind === kind).length;
  const [f, q, s] = [count("finding"), count("question"), count("suggestion")];
  const parts = [
    f ? plural(f, "finding") : "",
    q ? plural(q, "question") : "",
    s ? plural(s, "suggestion") : "",
  ].filter(Boolean);
  const tidyUp = (w.gathered as { tidyUp?: { summary?: string } } | null)?.tidyUp;
  const summary =
    w.status === "running"
      ? "running"
      : w.status === "failed" || w.status === "cut short"
        ? w.status
        : w.trigger === "tidy-up"
          ? `memory: ${tidyUp?.summary ?? "tidied"}`
          : parts.length
            ? parts.join(" · ")
            : "nothing new";
  const gathered = (w.gathered ?? {}) as { activity?: unknown[] };
  const runs = ax.listStewardRuns({ wakeId: w.id });
  const stages = runs.map<StewardViewStage>((r) => ({
    runId: r.id,
    stage: r.stage,
    model: r.model,
    effort: r.effort,
    status: r.status,
    error: r.error,
    tokens: countTokens(r),
    did:
      r.status === "failed" || r.status === "cut short"
        ? (r.error ?? r.status)
        : r.status === "running"
          ? "running"
          : r.stage === "gather"
            ? plural(Array.isArray(gathered.activity) ? gathered.activity.length : 0, "item") +
              " read"
            : r.stage === "promoted"
              ? "prepared a fix"
              : r.stage === "tidy-up"
                ? (tidyUp?.summary ?? "tidied the memory")
                : r.stage === "decide"
                  ? parts.length
                    ? parts.join(", ")
                    : "nothing new"
                  : r.stage,
  }));
  return {
    id: w.id,
    trigger: w.trigger,
    triggerDetail: w.triggerDetail,
    startedAt: w.startedAt,
    endedAt: w.endedAt,
    status: w.status,
    error: w.error,
    tokens: stages.reduce((n, s2) => n + s2.tokens, 0),
    summary,
    stages,
  };
}

export function buildStewardView(ax: Axiom, nextWakeAt: string | null): StewardView {
  const settings = ax.getStewardSettings();
  const all = ax.listStewardItems();
  const actions = ax.listStewardActions();
  const open = all.filter((i) => i.state === "open");
  const fixOf = (i: StewardItem): StewardViewFix | null => {
    if (i.kind !== "suggestion") return null;
    const sug = ax.listStewardSuggestions(i.id)[0];
    if (!sug) return null;
    const run = i.wakeId === null ? undefined : promotedRuns(i.wakeId);
    const parent = i.parentItemId === null ? null : all.find((x) => x.id === i.parentItemId);
    const pr = /^pr:([^#]+)#(\d+):/.exec(parent?.fingerprint ?? "");
    return {
      itemId: i.id,
      title: i.title,
      branch: sug.branch,
      kind: sug.kind,
      complexity: sug.complexity,
      diffstat: sug.diffstat,
      tests: sug.tests,
      forRef: pr ? `${(pr[1] as string).split("/").pop()}#${pr[2]}` : null,
      model: run?.model ?? null,
      effort: run?.effort ?? null,
    };
  };
  const runCache = new Map<number, StewardRun | undefined>();
  const promotedRuns = (wakeId: number) => {
    if (!runCache.has(wakeId)) {
      runCache.set(
        wakeId,
        ax.listStewardRuns({ wakeId }).find((r) => r.stage === "promoted"),
      );
    }
    return runCache.get(wakeId);
  };
  const openFixes = open.filter((i) => i.kind === "suggestion");
  const decorate = (i: StewardItem): StewardViewItem => {
    const child = i.kind === "finding" ? openFixes.find((x) => x.parentItemId === i.id) : undefined;
    return {
      ...i,
      notified: i.level === "urgent" && i.topicId !== null,
      action: actions.filter((a) => a.itemId === i.id).at(-1) ?? null,
      fix: fixOf(i),
      prepared: child ? fixOf(child) : null,
    };
  };
  const openFindingIds = new Set(open.filter((i) => i.kind === "finding").map((i) => i.id));
  const newest = (a: StewardItem, b: StewardItem) => b.id - a.id;
  const findings = open.filter((i) => i.kind === "finding");
  const rank = (i: StewardItem) => (i.level === "urgent" ? 0 : 1);

  const wakeRows = ax.listStewardWakes(30);
  const briefWake = wakeRows.find((w) => w.brief !== null);
  const latest = wakeRows[0];

  const usage = ax.stewardUsageByFamily();

  // Sources as the last checklist saw them: unreachable ones leave a "source unreachable" spot.
  const spots = latest?.blindSpots ?? [];
  const source = (key: "github" | "slack" | "googleDrive"): StewardSourceState => {
    if (!settings.sources[key]) return { on: false, ok: null, reason: null };
    if (!latest) return { on: true, ok: null, reason: null };
    const spot = spots.find((s) => s.kind === "source unreachable" && s.ref === key);
    return { on: true, ok: !spot, reason: spot?.text ?? null };
  };

  return {
    enabled: settings.enabled,
    nextWakeAt,
    running: ax.runningStewardWake() !== null,
    count: stewardCount(ax),
    brief: briefWake?.brief
      ? {
          text: briefWake.brief,
          at: briefWake.endedAt ?? briefWake.startedAt,
          wake: wakeView(ax, briefWake, all),
        }
      : null,
    blindSpots: spots,
    sources: {
      github: source("github"),
      slack: source("slack"),
      googleDrive: source("googleDrive"),
    },
    needs: findings
      .filter((i) => i.level === "urgent" || i.level === "attention")
      .sort((a, b) => rank(a) - rank(b) || newest(a, b))
      .map(decorate),
    questions: open
      .filter((i) => i.kind === "question")
      .sort(newest)
      .map(decorate),
    ready: open
      .filter(
        (i) =>
          i.kind === "suggestion" &&
          (i.parentItemId === null || !openFindingIds.has(i.parentItemId)),
      )
      .sort(newest)
      .map(decorate),
    info: findings
      .filter((i) => i.level === "info" || i.level === null)
      .sort(newest)
      .map(decorate),
    usage,
    wakes: wakeRows.slice(0, 6).map((w) => wakeView(ax, w, all)),
    memory: ax.listStewardMemory({ scope: "core" }),
  };
}
