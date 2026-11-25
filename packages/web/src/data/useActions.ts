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
      setFavorite: (slug: string, on: boolean) => run(() => api.setFavorite(slug, on)),
      setDeskHidden: (slug: string, hidden: boolean) => run(() => api.setDeskHidden(slug, hidden)),
      setDeskOrder: (slugs: string[]) => run(() => api.setDeskOrder(slugs)),
      markStale: (slug: string) => run(() => api.markStale(slug)),
      dismissStalePrompt: (slug: string) => run(() => api.dismissStalePrompt(slug)),
      setTaskStatus: (slug: string, key: string, status: TaskStatus) =>
        run(() => api.setTaskStatus(slug, key, status)),
      confirmMonitor: (id: number) => run(() => api.confirmMonitor(id)),
      deleteEntry: (id: number) => run(() => api.deleteEntry(id)),
      answerSteward: (id: number, text: string) => run(() => api.answerStewardItem(id, text)),
      dismissSteward: (id: number) => run(() => api.dismissStewardItem(id)),
      undoSteward: (id: number) => run(() => api.undoStewardAction(id)),
      saveSettings: (patch: Partial<Settings>) =>
        run(async () => applySettings(await api.putSettings(patch))),
    }),
    [run, applySettings],
  );
}

export type Actions = ReturnType<typeof useActions>;
