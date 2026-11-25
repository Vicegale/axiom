import { useCallback, useMemo } from "react";
import { api, type Settings } from "../api";
import type { TaskStatus } from "../lib/domain";
import { useAxiom } from "./DataProvider";

/** The owner's writes. Each reports a failure to the banner and asks for a refetch. */
export function useActions() {
  const { refresh, reportError, applySettings } = useAxiom();

  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await fn();
        return true;
      } catch (e) {
        reportError(e);
        return false;
      } finally {
        refresh();
      }
    },
    [refresh, reportError],
  );

  return useMemo(
    () => ({
      open: (slug: string) => run(() => api.open(slug)),
      setMuted: (slug: string, muted: boolean) => run(() => api.mute(slug, muted)),
      markStale: (slug: string) => run(() => api.markStale(slug)),
      dismissStalePrompt: (slug: string) => run(() => api.dismissStalePrompt(slug)),
      setTaskStatus: (slug: string, key: string, status: TaskStatus) =>
        run(() => api.setTaskStatus(slug, key, status)),
      confirmMonitor: (id: number) => run(() => api.confirmMonitor(id)),
      deleteEntry: (id: number) => run(() => api.deleteEntry(id)),
      saveSettings: (patch: Partial<Settings>) =>
        run(async () => applySettings(await api.putSettings(patch))),
    }),
    [run, applySettings],
  );
}

export type Actions = ReturnType<typeof useActions>;
