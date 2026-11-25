import type { TokenCounts } from "./types.js";

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
