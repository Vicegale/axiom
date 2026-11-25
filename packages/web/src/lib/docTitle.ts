import { useSyncExternalStore } from "react";

let title: string | null = null;
const listeners = new Set<() => void>();

/** The open document's title, for the page title; null when no document is open. */
export function setDocTitle(next: string | null): void {
  if (title === next) return;
  title = next;
  for (const l of listeners) l();
}

export function useDocTitle(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => title,
    () => null,
  );
}
