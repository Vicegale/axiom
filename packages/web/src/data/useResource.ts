import { useEffect, useRef, useState } from "react";

export interface Resource<T> {
  data: T | undefined;
  error: Error | null;
}

/**
 * Fetches `load()` for `key` and again whenever `tick` changes. The previous data stays on
 * screen while a refetch runs; data from another key never shows. Late responses are dropped.
 */
export function useResource<T>(key: string, load: () => Promise<T>, tick: number): Resource<T> {
  const [state, setState] = useState<{ key: string; data?: T; error: Error | null }>({
    key,
    error: null,
  });
  const loadRef = useRef(load);
  loadRef.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the refetch trigger.
  useEffect(() => {
    let live = true;
    loadRef
      .current()
      .then((data) => live && setState({ key, data, error: null }))
      .catch((e: unknown) => {
        if (!live) return;
        const error = e instanceof Error ? e : new Error(String(e));
        setState((s) => (s.key === key ? { ...s, error } : { key, error }));
      });
    return () => {
      live = false;
    };
  }, [key, tick]);

  return state.key === key
    ? { data: state.data, error: state.error }
    : { data: undefined, error: null };
}
