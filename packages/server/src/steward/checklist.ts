import type { Axiom, StewardBlindSpot } from "@axiom/core";
import type { ConnectorSource, SourceAvailability } from "./connectors.js";
import { describeGhError, ghJson, runGh } from "./gh.js";
import { type PollError, parsePrTarget } from "./pr.js";

/**
 * The fixed blind-spot checklist (03): what Steward cannot see, found in code with no model. It
 * runs at the start of every wake; stage 2 adds its own judgement later.
 */

export interface ChecklistInput {
  ax: Axiom;
  gh: string;
  env?: NodeJS.ProcessEnv;
  /** What the connector probe found; null when it could not run or sources are not wanted. */
  connectors: Record<ConnectorSource, SourceAvailability>;
  /** The PR errors of the last poll. */
  prErrors?: PollError[];
}

export interface ChecklistResult {
  spots: StewardBlindSpot[];
  /** Whether `gh` works (so gather may mention PR facts as current). */
  githubOk: boolean;
}

interface SearchHit {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
}

export async function runChecklist(i: ChecklistInput): Promise<ChecklistResult> {
  const { ax } = i;
  const settings = ax.getStewardSettings();
  const spots: StewardBlindSpot[] = [];
  let githubOk = false;

  // Sources.
  if (settings.sources.github) {
    try {
      await runGh(i.gh, ["api", "user", "--jq", ".login"], { env: i.env });
      githubOk = true;
    } catch (e) {
      spots.push({
        kind: "source unreachable",
        text: `GitHub is unreachable: ${describeGhError(e)}. PR signals and PRs outside topics cannot be checked.`,
        ref: "github",
      });
    }
  }
  for (const source of ["slack", "googleDrive"] as const) {
    if (!settings.sources[source]) continue;
    const c = i.connectors[source];
    if (!c.available) {
      spots.push({
        kind: "source unreachable",
        text: `${c.reason ?? source} (the connector is not available to headless Claude)`,
        ref: source,
      });
    }
  }

  // The owner's open PRs that belong to no topic.
  if (githubOk) {
    try {
      const hits = await ghJson<SearchHit[]>(
        i.gh,
        [
          "search",
          "prs",
          "--author",
          "@me",
          "--state",
          "open",
          "--json",
          "number,repository,title,url",
          "--limit",
          "100",
        ],
        { env: i.env },
      );
      const known = new Set(
        ax
          .listLinksOfKind("pr")
          .map((l) => parsePrTarget(l.target))
          .filter((p) => p !== null)
          .map((p) => `${p.repo.toLowerCase()}#${p.number}`),
      );
      for (const h of hits) {
        const ref = `${h.repository.nameWithOwner}#${h.number}`;
        if (known.has(ref.toLowerCase())) continue;
        spots.push({
          kind: "pr without topic",
          text: `Your open PR ${ref} (${h.title}) belongs to no topic.`,
          ref,
        });
      }
    } catch (e) {
      spots.push({
        kind: "source unreachable",
        text: `Could not list your open PRs: ${describeGhError(e)}`,
        ref: "github",
      });
    }
  }
  for (const e of i.prErrors ?? []) {
    spots.push({
      kind: "pr unreadable",
      text: `Could not read PR ${e.repo}#${e.number}: ${e.text}`,
      topic: e.topic,
      ref: `${e.repo}#${e.number}`,
    });
  }

  // Topics Steward watches.
  for (const t of ax.listTopics()) {
    if (t.status === "done" || !t.stewardEnabled) continue;
    if (!t.goal || t.goal.trim() === "") {
      spots.push({
        kind: "no goal",
        text: `Topic ${t.slug} has no goal, so Steward cannot judge progress.`,
        topic: t.slug,
      });
    }
    if (t.status === "monitoring") {
      const confirmed = ax.getTopic(t.slug).monitorTargets.some((m) => m.state === "confirmed");
      if (!confirmed) {
        spots.push({
          kind: "no monitor target",
          text: `Topic ${t.slug} is in monitoring but has no confirmed monitor target.`,
          topic: t.slug,
        });
      }
    }
  }
  return { spots, githubOk };
}
