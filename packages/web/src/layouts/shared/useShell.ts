import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useAxiom } from "../../data/DataProvider";
import { useActions } from "../../data/useActions";
import type { ViewId } from "../../lib/domain";
import { useBrowserNotifications } from "../../lib/notify";
import { useTheme } from "../../lib/theme";
import { useNow } from "../../lib/useNow";
import { hrefs, useAppRoute } from "./routes";

/**
 * What every layout shell needs: data, owner actions, the route, the clock, the theme, browser
 * notifications, and "open this topic" (POST /open, then the topic's URL).
 */
export function useShell() {
  const data = useAxiom();
  const actions = useActions();
  const route = useAppRoute();
  const [, navigate] = useLocation();
  const now = useNow();
  const [lastList, setLastList] = useState<"all" | ViewId>("all");

  useTheme(data.settings?.theme);

  const listRoute: "all" | ViewId | null =
    route.kind === "all" ? "all" : route.kind === "view" ? route.view : null;
  useEffect(() => {
    if (listRoute) setLastList(listRoute);
  }, [listRoute]);
  /** A topic route keeps the list you came from. */
  const list = listRoute ?? lastList;
  const selected = route.kind === "topic" ? route.slug : undefined;

  const topics = useMemo(() => data.topics ?? [], [data.topics]);
  const titleOf = useMemo(() => {
    const m = new Map(topics.map((t) => [t.slug, t.title]));
    return (slug: string) => m.get(slug);
  }, [topics]);

  /** Marks the topic opened (clears its highlight and notifications) without navigating. */
  const openTopic = useCallback((slug: string) => void actions.open(slug), [actions]);
  /** Opens the topic and shows it. */
  const goTopic = useCallback(
    (slug: string) => {
      openTopic(slug);
      navigate(hrefs.topic(slug));
    },
    [openTopic, navigate],
  );
  const goList = useCallback(
    (l: "all" | ViewId) => navigate(l === "all" ? hrefs.all : hrefs.view(l)),
    [navigate],
  );

  useBrowserNotifications({
    notifications: data.notifications,
    titleOf: (slug) => titleOf(slug) ?? slug,
    onOpen: goTopic,
  });

  return {
    data,
    actions,
    route,
    navigate,
    now,
    list,
    selected,
    topics,
    notifications: data.notifications ?? [],
    titleOf,
    openTopic,
    goTopic,
    goList,
  };
}

/** True when the key event came from a text field (shortcuts must not fire there). */
export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}
