import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "./storage";

const KEY = "axiom.doc.wide";
const listeners = new Set<() => void>();
let current: boolean | null = null;

function get(): boolean {
  if (current === null) current = readStored(KEY) === "1";
  return current;
}

export function setWide(v: boolean): void {
  current = v;
  writeStored(KEY, v ? "1" : "0");
  for (const l of listeners) l();
}

/** The viewer's "Wide" mode, remembered per browser and shared by the shell (which hides its
 *  lists and sidebars) and the viewer (which owns the toggle). */
export function useWide(): [boolean, (v: boolean) => void] {
  const wide = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    get,
    () => false,
  );
  return [wide, setWide];
}

/** Test hook: forget the cached value so storage is read again. */
export function resetWideForTests(): void {
  current = null;
}
