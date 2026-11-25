import { lazy, Suspense, useMemo } from "react";
import type { DocData } from "../../api";

const Markdown = lazy(() => import("../doc/Markdown").then((m) => ({ default: m.Markdown })));

/** A reply as the document the Markdown renderer takes. Replies are not files, so relative links
 *  and images have nothing to resolve against. */
function asDoc(text: string, threadId?: number): DocData {
  return {
    replyThreadId: threadId,
    linkId: 0,
    path: "/reply.md",
    relPath: "reply.md",
    root: "/",
    baseDir: "/",
    title: "Reply",
    markdown: text,
    mtime: 0,
  };
}

/** The reply as Markdown. The renderer (and its highlighter) loads as a separate chunk the first
 *  time a card expands. */
export function ReplyMarkdown({
  text,
  slug,
  theme,
  threadId,
}: {
  text: string;
  slug: string;
  theme: "dark" | "light";
  threadId?: number;
}) {
  const doc = useMemo(() => asDoc(text, threadId), [text, threadId]);
  return (
    <Suspense fallback={<p className="dk-note">Loading.</p>}>
      <Markdown doc={doc} slug={slug} theme={theme} />
    </Suspense>
  );
}
