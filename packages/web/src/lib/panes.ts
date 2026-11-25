import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { readStored, removeStored, writeStored } from "./storage";

/** Below this width the layouts fall back to one main column with overlays (spec 09, item 3). */
export const NARROW_QUERY = "(max-width: 56.25em)";

export function isNarrow(): boolean {
  return typeof matchMedia === "function" && matchMedia(NARROW_QUERY).matches;
}

export interface PaneOptions {
  default: number;
  min: number;
  /** A number, or a function of the current window (so a pane cannot push the rest off screen). */
  max: number | (() => number);
}

const maxOf = (o: PaneOptions) => (typeof o.max === "function" ? o.max() : o.max);
const clampTo = (v: number, o: PaneOptions) => {
  const hi = Math.max(o.min, maxOf(o));
  return Math.round(Math.min(hi, Math.max(o.min, v)));
};

export interface PaneSize {
  /** The size shown, in px, already clamped to the current window. */
  size: number;
  min: number;
  max: number;
  /** Update the layout while dragging: no React render, no storage write. */
  preview: (px: number) => void;
  /** Keep a size: state and localStorage. */
  commit: (px: number) => void;
  reset: () => void;
}

/**
 * One resizable pane. The size lives in the CSS custom property `--pane-<key>` on <html>, so a
 * drag only calls `style.setProperty` and nothing re-renders. It is remembered in localStorage
 * (`axiom.pane.<key>`), clamped on load and again whenever the window is resized.
 */
export function usePaneSize(key: string, options: PaneOptions): PaneSize {
  const opts = useRef(options);
  opts.current = options;
  const storageKey = `axiom.pane.${key}`;
  const [raw, setRaw] = useState(() => {
    const stored = Number(readStored(storageKey));
    return readStored(storageKey) !== null && Number.isFinite(stored) ? stored : options.default;
  });
  const [, setViewport] = useState(0);
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const size = clampTo(raw, options);
  const varName = `--pane-${key}`;
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(varName, `${size}px`);
  }, [varName, size]);
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty(varName);
    },
    [varName],
  );

  const preview = useCallback(
    (px: number) =>
      document.documentElement.style.setProperty(varName, `${clampTo(px, opts.current)}px`),
    [varName],
  );
  const commit = useCallback(
    (px: number) => {
      const v = clampTo(px, opts.current);
      setRaw(v);
      document.documentElement.style.setProperty(varName, `${v}px`);
      writeStored(storageKey, String(v));
    },
    [varName, storageKey],
  );
  const reset = useCallback(() => {
    setRaw(opts.current.default);
    document.documentElement.style.setProperty(
      varName,
      `${clampTo(opts.current.default, opts.current)}px`,
    );
    removeStored(storageKey);
  }, [varName, storageKey]);

  return { size, min: options.min, max: Math.max(options.min, maxOf(options)), preview, commit, reset };
}

/**
 * A pane that can collapse, remembered per browser (`axiom.pane.<key>.collapsed`). With nothing
 * remembered it starts collapsed on a narrow window, where the pane is an overlay.
 */
export function useCollapsed(key: string): [boolean, () => void, (v: boolean) => void] {
  const storageKey = `axiom.pane.${key}.collapsed`;
  const [collapsed, setCollapsed] = useState(() => {
    const stored = readStored(storageKey);
    return stored === null ? isNarrow() : stored === "1";
  });
  const set = useCallback(
    (v: boolean) => {
      setCollapsed(v);
      writeStored(storageKey, v ? "1" : "0");
    },
    [storageKey],
  );
  const toggle = useCallback(() => set(!collapsed), [set, collapsed]);
  return [collapsed, toggle, set];
}
