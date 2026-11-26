import { basename } from "node:path";
import type { Axiom } from "./axiom.js";
import type { StewardMemory, TokenCounts } from "./types.js";

/**
 * How many tokens a call counts for the daily caps (03): input + output + cache creation + cache
 * read. The one place that decides this, so the rule is easy to change.
 */
export function countTokens(u: TokenCounts): number {
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}

/** `claude-haiku-5-5` and `haiku` are both `haiku`; a model of no known family stands for itself. */
export function modelFamily(model: string): string {
  const m = model.toLowerCase();
  for (const family of ["haiku", "sonnet", "opus"]) if (m.includes(family)) return family;
  return model;
}

/** The ISO start and end of a local calendar day (`YYYY-MM-DD`, the server's time zone). */
export function localDayRange(day: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`invalid day "${day}", expected YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return {
    start: new Date(y, mo - 1, d).toISOString(),
    end: new Date(y, mo - 1, d + 1).toISOString(),
  };
}

/** The local calendar day of `date` as `YYYY-MM-DD`. */
export function localDay(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `stored` laid over `defaults`, key by key through nested objects; arrays and scalars replace. */
export function mergeDefaults<T>(defaults: T, stored: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(stored)) {
    return (stored === undefined ? defaults : stored) as T;
  }
  const out: Record<string, unknown> = { ...defaults };
  for (const [k, v] of Object.entries(stored)) out[k] = mergeDefaults(out[k], v);
  return out as T;
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

/**
 * Repositories the tracker knows, by every name they go by (lower case): the folder of a
 * repository or worktree link (its path and its last segment) and the `owner/name` of a PR link
 * (and `name`). The first name a repository was seen under is its key.
 */
export function knownRepos(ax: Axiom): Map<string, string> {
  const out = new Map<string, string>();
  const add = (primary: string, ...aliases: string[]) => {
    for (const a of [primary, ...aliases])
      if (a && !out.has(a.toLowerCase())) out.set(a.toLowerCase(), primary);
  };
  for (const kind of ["repository", "worktree"] as const) {
    for (const l of ax.listLinksOfKind(kind)) {
      const t = l.target.replace(/\/+$/, "");
      add(t, basename(t));
    }
  }
  for (const l of ax.listLinksOfKind("pr")) {
    const p = parsePrTarget(l.target);
    if (p) add(p.repo, p.repo.split("/")[1] ?? "");
  }
  return out;
}

/** Checks the thing an attached memory item is about and returns its key as it is stored. */
export function resolveAttachedKey(ax: Axiom, kind: string, key: string): string {
  const k = key.trim();
  if (!k) throw new Error("attached memory needs the key it is attached to");
  if (kind === "topic") {
    try {
      return ax.getTopic(k).slug;
    } catch {
      throw new Error(`"${k}" is not a topic slug`);
    }
  }
  if (kind === "repo") {
    const hit = knownRepos(ax).get(k.replace(/\/+$/, "").toLowerCase());
    if (!hit)
      throw new Error(`"${k}" is not a repository any topic links (a path, owner/name or name)`);
    return hit;
  }
  if (kind === "person") {
    if (k.length > 80 || /[\r\n]/.test(k)) throw new Error("a person's name is one short line");
    return k;
  }
  throw new Error(`unknown attached kind "${kind}"`);
}

/** Every name (lower case) of the repositories the topics with these ids link. */
export function topicRepoNames(ax: Axiom, topicIds: ReadonlySet<number>): Set<string> {
  const names = new Set<string>();
  for (const kind of ["repository", "worktree", "pr"] as const) {
    for (const l of ax.listLinksOfKind(kind)) {
      if (!topicIds.has(l.topicId)) continue;
      if (kind === "pr") {
        const p = parsePrTarget(l.target);
        if (p) {
          names.add(p.repo.toLowerCase());
          names.add((p.repo.split("/")[1] ?? "").toLowerCase());
        }
      } else {
        const t = l.target.replace(/\/+$/, "");
        names.add(t.toLowerCase());
        names.add(basename(t).toLowerCase());
      }
    }
  }
  return names;
}

/**
 * What Steward's memory says about one topic: the core, the items attached to the topic and the
 * items attached to the repositories it links (not people; those are found by name in text).
 */
export function memoryForTopic(
  ax: Axiom,
  slug: string,
  options: { includeRetired?: boolean } = {},
): StewardMemory[] {
  const topic = ax.getTopic(slug);
  const repos = topicRepoNames(ax, new Set([topic.id]));
  return ax
    .listStewardMemory({ includeRetired: options.includeRetired })
    .filter(
      (m) =>
        m.scope === "core" ||
        (m.scope === "attached" &&
          ((m.attachedKind === "topic" && m.attachedKey === topic.slug) ||
            (m.attachedKind === "repo" && repos.has((m.attachedKey ?? "").toLowerCase())))),
    );
}
