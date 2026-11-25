import { useEffect, useRef } from "react";
import type { AxiomNotification } from "../api";

/** Notification ids not in `seen`; adds them to `seen`. */
export function takeNew(
  seen: Set<number>,
  list: readonly AxiomNotification[],
): AxiomNotification[] {
  const fresh = list.filter((n) => !seen.has(n.id));
  for (const n of list) seen.add(n.id);
  return fresh;
}

export type PermissionState = NotificationPermission | "unsupported";

export function browserPermission(): PermissionState {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

interface Options {
  /** undefined until the first load finishes: that load only seeds the seen set. */
  notifications: readonly AxiomNotification[] | undefined;
  titleOf: (slug: string) => string;
  onOpen: (slug: string) => void;
}

/** Shows a browser Notification for each notification id not seen before (when permitted). */
export function useBrowserNotifications({ notifications, titleOf, onOpen }: Options): void {
  const seen = useRef<Set<number> | null>(null);
  const latest = useRef({ titleOf, onOpen });
  latest.current = { titleOf, onOpen };

  useEffect(() => {
    if (!notifications) return;
    if (seen.current === null) {
      seen.current = new Set(notifications.map((n) => n.id));
      return;
    }
    const fresh = takeNew(seen.current, notifications);
    if (browserPermission() !== "granted") return;
    for (const n of fresh) {
      const note = new Notification(`${n.kind}: ${latest.current.titleOf(n.topicSlug)}`, {
        body: n.body ?? undefined,
        tag: `axiom-${n.id}`,
      });
      note.onclick = () => {
        window.focus();
        latest.current.onOpen(n.topicSlug);
        note.close();
      };
    }
  }, [notifications]);
}
