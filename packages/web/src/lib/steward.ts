import type { StewardItem } from "../api";

/** 133_000 → "133k", 1_210_000 → "1.21M", 940 → "940". */
export function tokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number(m.toFixed(m >= 10 ? 0 : 2))}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** "haiku" → "Haiku". */
export function familyName(family: string): string {
  return family.charAt(0).toUpperCase() + family.slice(1);
}

/** Roughly four characters to a token: enough for a meter. */
export function estimateTokens(texts: string[]): number {
  return Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);
}

export const STAGE_NAMES: Record<string, string> = {
  gather: "Gather and summarise",
  decide: "Decide",
  promoted: "Promoted task",
  "tidy-up": "Tidy-up",
  chat: "Chat",
};

/** The from and to of a status-change action, when its data has them. */
export function statusChange(item: StewardItem): { from: string | null; to: string } | null {
  const a = item.action;
  if (a?.kind !== "status change") return null;
  const d = a.data as { from?: string | null; to?: string } | null;
  return d?.to ? { from: d.from ?? null, to: d.to } : null;
}

/** What an in-place rebase did (ST7), when the item's action is one and its data has the tips. */
export function rebaseInfo(item: StewardItem): {
  branch: string;
  base: string;
  oldTip: string;
  newTip: string;
  backupRef: string;
} | null {
  const a = item.action;
  if (a?.kind !== "rebase in place" || a.undoneAt !== null) return null;
  const d = a.data as Record<string, string> | null;
  if (!d?.branch || !d.base || !d.oldTip || !d.newTip || !d.backupRef) return null;
  return {
    branch: d.branch,
    base: d.base,
    oldTip: d.oldTip,
    newTip: d.newTip,
    backupRef: d.backupRef,
  };
}
