import { useRoute } from "wouter";
import { isViewId, type ViewId } from "../../lib/domain";

export type Route =
  | { kind: "all" }
  | { kind: "view"; view: ViewId }
  | { kind: "topic"; slug: string }
  | { kind: "notifications" }
  | { kind: "settings" }
  | { kind: "unknown" };

export const hrefs = {
  all: "/",
  view: (v: ViewId) => `/view/${v}`,
  topic: (slug: string) => `/topic/${encodeURIComponent(slug)}`,
  notifications: "/notifications",
  settings: "/settings",
};

/** The current location as one of the app's routes. */
export function useAppRoute(): Route {
  const [isAll] = useRoute("/");
  const [isView, viewParams] = useRoute("/view/:view");
  const [isTopic, topicParams] = useRoute("/topic/:slug");
  const [isNotifs] = useRoute("/notifications");
  const [isSettings] = useRoute("/settings");
  if (isAll) return { kind: "all" };
  if (isView && viewParams && isViewId(viewParams.view)) {
    return { kind: "view", view: viewParams.view };
  }
  if (isTopic && topicParams) return { kind: "topic", slug: topicParams.slug };
  if (isNotifs) return { kind: "notifications" };
  if (isSettings) return { kind: "settings" };
  return { kind: "unknown" };
}
