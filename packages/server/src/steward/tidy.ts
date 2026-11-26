import type { Axiom, StewardItem, StewardPrRecord } from "@axiom/core";
import { parsePrTarget } from "./pr.js";

/**
 * Tidying by mechanical rules (03, Jobs 4), in code with no model. Each change goes through the
 * normal status path, is marked as Steward's in the history, and is recorded as an action that
 * can be undone. Judgement calls ("looks done", "looks stale") are left to stage 2 as questions.
 *
 * (a) A topic in `review` whose PR links are all merged becomes `done`.
 * (b) A topic in `monitoring` with no confirmed monitor target becomes `blocked`. 01's stop table
 *     already does this when a thread stops, but not for a topic set to `monitoring` by hand or
 *     one whose target was removed later, which is what this covers (after a short grace, so an
 *     agent that has just set `monitoring` can still add its target). A topic whose thread is
 *     monitoring its own background commands is left alone: they re-invoke the agent.
 */

const actor = { kind: "steward" } as const;
export const MONITORING_GRACE_MS = 15 * 60_000;

export interface TidyOptions {
  wakeId: number;
  now: Date;
  /** Only this topic (an owner wake about one topic). */
  topic?: string;
}

export function runTidy(ax: Axiom, o: TidyOptions): StewardItem[] {
  const out: StewardItem[] = [];
  const records = new Map<string, StewardPrRecord>(
    ax.listStewardPrs().map((r) => [`${r.repo.toLowerCase()}#${r.number}`, r]),
  );
  const prLinks = ax.listLinksOfKind("pr");
  for (const t of ax.listTopics()) {
    if (!t.stewardEnabled || (o.topic !== undefined && t.slug !== o.topic)) continue;
    try {
      if (t.status === "review") {
        const links = prLinks.filter((l) => l.topicId === t.id);
        const refs: string[] = [];
        let allMerged = links.length > 0;
        for (const l of links) {
          const p = parsePrTarget(l.target);
          const ref = p ? `${p.repo}#${p.number}` : null;
          const rec = ref ? records.get(ref.toLowerCase()) : undefined;
          if (!ref || !rec || rec.state !== "MERGED") {
            allMerged = false;
            break;
          }
          refs.push(ref);
        }
        if (!allMerged) continue;
        const fingerprint = `tidy:done:${t.slug}:${refs
          .map((r) => r.toLowerCase())
          .sort()
          .join(",")}`;
        if (ax.findStewardItemByFingerprint(fingerprint)) continue;
        const merged = refs.join(", ");
        out.push(
          ax.stewardTidyStatus(
            {
              wakeId: o.wakeId,
              topic: t.id,
              to: "done",
              reason: `all its pull requests are merged (${merged})`,
              title: `Moved ${t.slug} from review to done`,
              body: `Its pull request${refs.length > 1 ? "s are" : " is"} merged (${merged}), so Steward marked the topic done.`,
              fingerprint,
            },
            actor,
          ).item,
        );
      } else if (t.status === "monitoring") {
        const confirmed = ax.getTopic(t.slug).monitorTargets.some((m) => m.state === "confirmed");
        if (confirmed) continue;
        // An agent waiting on its own background commands needs no target: they re-invoke it.
        if (ax.topicWaitsOnCommands(t.id)) continue;
        const since = ax
          .listEntries(t.slug)
          .reverse()
          .find(
            (e) =>
              e.kind === "status change" && (e.data as { to?: string } | null)?.to === "monitoring",
          );
        if (since && o.now.getTime() - Date.parse(since.at) < MONITORING_GRACE_MS) continue;
        const fingerprint = `tidy:blocked:${t.slug}:${since?.id ?? 0}`;
        if (ax.findStewardItemByFingerprint(fingerprint)) continue;
        out.push(
          ax.stewardTidyStatus(
            {
              wakeId: o.wakeId,
              topic: t.id,
              to: "blocked",
              reason: "it was monitoring with no confirmed monitor target (01's stop rule)",
              title: `Moved ${t.slug} from monitoring to blocked`,
              body: "A topic in monitoring needs a confirmed monitor target. Confirm one and set it back, or leave it blocked.",
              fingerprint,
            },
            actor,
          ).item,
        );
      }
    } catch (e) {
      console.error(`steward tidy failed for ${t.slug}:`, e);
    }
  }
  return out;
}
