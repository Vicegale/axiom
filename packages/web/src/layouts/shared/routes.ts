import { useRoute, useSearch } from "wouter";
import { isViewId, type ViewId } from "../../lib/domain";

export type Route =
  | { kind: "all" }
  | { kind: "view"; view: ViewId }
  | { kind: "topic"; slug: string }
  | { kind: "doc"; slug: string; linkId: number; path: string | undefined }
  | { kind: "notifications" }
  | { kind: "settings" }
  | { kind: "desk" }
  | { kind: "unknown" };

export const hrefs = {
  all: "/",
  view: (v: ViewId) => `/view/${v}`,
  topic: (slug: string) => `/topic/${encodeURIComponent(slug)}`,
  /** The document viewer; `path` is a Markdown file relative to the linked document. */
  doc: (slug: string, linkId: number, path?: string) =>
    `/topic/${encodeURIComponent(slug)}/doc/${linkId}${
      path ? `?path=${encodeURIComponent(path)}` : ""
    }`,
  notifications: "/notifications",
  settings: "/settings",
  desk: "/desk",
};

/** The current location as one of the app's routes. */
export function useAppRoute(): Route {
  const [isAll] = useRoute("/");
  const [isView, viewParams] = useRoute("/view/:view");
  const [isTopic, topicParams] = useRoute("/topic/:slug");
  const [isDoc, docParams] = useRoute("/topic/:slug/doc/:linkId");
  const search = useSearch();
  const [isNotifs] = useRoute("/notifications");
  const [isSettings] = useRoute("/settings");
  const [isDesk] = useRoute("/desk");
  if (isAll) return { kind: "all" };
  if (isView && viewParams && isViewId(viewParams.view)) {
    return { kind: "view", view: viewParams.view };
  }
  if (isDoc && docParams && /^\d+$/.test(docParams.linkId)) {
    return {
      kind: "doc",
      slug: docParams.slug,
      linkId: Number(docParams.linkId),
      path: new URLSearchParams(search.split("#")[0]).get("path") ?? undefined,
    };
  }
  if (isTopic && topicParams) return { kind: "topic", slug: topicParams.slug };
  if (isNotifs) return { kind: "notifications" };
  if (isSettings) return { kind: "settings" };
  if (isDesk) return { kind: "desk" };
  return { kind: "unknown" };
}
