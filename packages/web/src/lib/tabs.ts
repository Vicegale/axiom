import type { KeyboardEvent } from "react";

/**
 * Arrow-key handling for a `role="tablist"` (WAI-ARIA tabs): left / right (wrapping), Home and
 * End select and focus the neighbouring tab. Pair with `tabIndex={selected ? 0 : -1}` on tabs.
 * Tab elements must have the id `${idPrefix}-${tab}`.
 */
export function tabListKeys<T extends string>(
  tabs: readonly T[],
  current: T,
  select: (tab: T) => void,
  idPrefix: string,
) {
  return (e: KeyboardEvent) => {
    const at = tabs.indexOf(current);
    let next = -1;
    if (e.key === "ArrowRight") next = (at + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    const tab = tabs[next];
    if (tab === undefined) return;
    e.preventDefault();
    select(tab);
    document.getElementById(`${idPrefix}-${tab}`)?.focus();
  };
}
