import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AxiomNotification,
  api,
  type Health,
  type NotificationsResponse,
  type Settings,
  type TopicListItem,
} from "../api";
import { useResource } from "./useResource";

const COALESCE_MS = 40;

export interface AxiomData {
  /** Bumps on every server change; anything on screen refetches when it moves. */
  tick: number;
  /** Ask for a refetch (coalesced with an incoming SSE change). */
  refresh: () => void;
  live: boolean;
  topics: TopicListItem[] | undefined;
  notifications: AxiomNotification[] | undefined;
  hiddenCount: number;
  settings: Settings | undefined;
  health: Health | undefined;
  error: Error | null;
  clearError: () => void;
  /** Show settings the server just returned, before the refetch lands. */
  applySettings: (s: Settings) => void;
  reportError: (e: unknown) => void;
}

const Ctx = createContext<AxiomData | null>(null);

export function useAxiom(): AxiomData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAxiom outside DataProvider");
  return v;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setTick((t) => t + 1);
    }, COALESCE_MS);
  }, []);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/events");
    let first = true;
    es.addEventListener("change", refresh);
    es.addEventListener("open", () => {
      setLive(true);
      // A reconnect may have missed changes; the first open is covered by the initial load.
      if (!first) refresh();
      first = false;
    });
    es.addEventListener("error", () => setLive(false));
    return () => {
      es.close();
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [refresh]);

  const topics = useResource("topics", api.topics, tick);
  const notes = useResource<NotificationsResponse>("notifications", api.notifications, tick);
  const settings = useResource("settings", api.settings, tick);
  const health = useResource("health", api.health, tick);

  const [saved, setSaved] = useState<Settings | undefined>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh fetch supersedes a saved copy.
  useEffect(() => setSaved(undefined), [settings.data]);

  const firstError = topics.error ?? notes.error ?? settings.error ?? health.error;
  const reportError = useCallback(
    (e: unknown) => setError(e instanceof Error ? e : new Error(String(e))),
    [],
  );
  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<AxiomData>(
    () => ({
      tick,
      refresh,
      live,
      topics: topics.data,
      notifications: notes.data?.notifications,
      hiddenCount: notes.data?.hiddenCount ?? 0,
      settings: saved ?? settings.data,
      applySettings: setSaved,
      health: health.data,
      error: error ?? firstError,
      clearError,
      reportError,
    }),
    [
      tick,
      refresh,
      live,
      topics.data,
      notes.data,
      settings.data,
      saved,
      health.data,
      error,
      firstError,
      clearError,
      reportError,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
