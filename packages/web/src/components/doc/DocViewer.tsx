import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { ApiError, api } from "../../api";
import { useResource } from "../../data/useResource";
import { hrefs } from "../../layouts/shared/routes";
import { setDocTitle } from "../../lib/docTitle";
import { readStored, writeStored } from "../../lib/storage";
import { useWide } from "../../lib/wide";
import { jumpTo, Markdown } from "./Markdown";

/** How often an open document is checked for changes on disk. */
export const POLL_MS = 3000;
/** The viewer's width at which the table of contents moves from the top to a side column. */
const SIDE_TOC_PX = 960;

export interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}

interface Props {
  slug: string;
  linkId: number;
  path: string | undefined;
  /** The heading level for the document's title: 1 where the viewer is the page's main content. */
  level?: 1 | 2;
  /** The topic's title, for the back link's label. */
  topicTitle?: string;
}

function useTheme(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
  );
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.getAttribute("data-theme") === "light" ? "light" : "dark");
    const mo = new MutationObserver(read);
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

/** True once the element is at least `px` wide. Without ResizeObserver (tests) it is true. */
function useWideEnough(ref: React.RefObject<HTMLElement | null>, px: number): boolean {
  const [ok, setOk] = useState(typeof ResizeObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setOk((e?.contentRect.width ?? 0) >= px));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, px]);
  return ok;
}

/** The document viewer: header, table of contents and the rendered file. It fills whatever pane
 *  the layout gives it (Inbox reader, Board sheet, Console panel). */
export function DocViewer({ slug, linkId, path, level = 1, topicTitle }: Props) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") setTick((t) => t + 1);
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);
  const key = `doc:${slug}:${linkId}:${path ?? ""}`;
  const { data: fetched, error } = useResource(key, () => api.doc(slug, linkId, path), tick);
  // A poll that returns the same mtime keeps the same object, so nothing below re-renders.
  const doc = useRef(fetched);
  if (fetched && (doc.current?.path !== fetched.path || doc.current?.mtime !== fetched.mtime)) {
    doc.current = fetched;
  } else if (!fetched) {
    doc.current = undefined;
  }
  const current = doc.current;

  const theme = useTheme();
  const [wide, setWide] = useWide();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const side = useWideEnough(rootRef, SIDE_TOC_PX);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(() => readStored("axiom.doc.toc") !== "0");

  useEffect(() => {
    setDocTitle(current?.title ?? null);
    return () => setDocTitle(null);
  }, [current?.title]);

  // A different document starts at the top (or at its #anchor); a changed file keeps its place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path is the trigger.
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !current) return;
    const hash = window.location.hash.slice(1);
    if (hash) requestAnimationFrame(() => jumpTo(decodeURIComponent(hash)));
    else sc.scrollTop = 0;
  }, [current?.path]);

  // The table of contents is read from the rendered headings (h2 and h3 of the document).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the file changes.
  useLayoutEffect(() => {
    const found: Heading[] = [];
    for (const h of articleRef.current?.querySelectorAll<HTMLElement>(
      "[data-level='2'],[data-level='3']",
    ) ?? []) {
      const clone = h.cloneNode(true) as HTMLElement;
      for (const a of clone.querySelectorAll(".dv-anchor")) a.remove();
      if (h.id && !h.closest("[data-footnotes]")) {
        found.push({
          id: h.id,
          text: clone.textContent?.trim() ?? "",
          level: h.dataset.level === "3" ? 3 : 2,
        });
      }
    }
    setHeadings((old) =>
      old.length === found.length &&
      old.every((o, i) => o.id === found[i]?.id && o.text === found[i]?.text)
        ? old
        : found,
    );
  }, [current?.markdown, current?.path, theme]);

  // The active heading is the last one scrolled past the top of the document.
  const track = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const top = sc.getBoundingClientRect().top + 24;
    let at: string | null = null;
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el && el.getBoundingClientRect().top <= top) at = h.id;
    }
    setActive(at ?? headings[0]?.id ?? null);
  }, [headings]);
  useEffect(() => {
    track();
    const sc = scrollRef.current;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(track);
    };
    sc?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sc?.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [track]);

  const H = level === 1 ? "h1" : "h2";
  const back = hrefs.topic(slug);
  const toc = useMemo(
    () =>
      headings.length === 0 ? null : (
        <ol className="dv-toc-list">
          {headings.map((h) => (
            <li key={h.id} className={`l${h.level}`}>
              <a
                href={`#${h.id}`}
                aria-current={h.id === active ? "location" : undefined}
                onClick={(e) => {
                  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  jumpTo(h.id);
                }}
              >
                {h.text}
              </a>
            </li>
          ))}
        </ol>
      ),
    [headings, active],
  );

  return (
    <section
      className="dv"
      ref={rootRef}
      data-wide={wide ? "true" : undefined}
      data-toc={side ? "side" : "top"}
      aria-label="Document"
    >
      <header className="dv-head">
        <Link href={back} className="dv-back">
          <span aria-hidden="true">←</span> Back to topic
          {topicTitle ? <span className="sr-only">: {topicTitle}</span> : null}
        </Link>
        <div className="dv-titles">
          <H className="dv-title">{current?.title ?? "Document"}</H>
          {current ? (
            <p className="dv-path" title={current.path}>
              {current.relPath}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="btn sm dv-wide"
          aria-pressed={wide}
          title="Hide the lists and sidebars so the document gets the full width"
          onClick={() => setWide(!wide)}
        >
          Wide
        </button>
      </header>
      <div className="dv-scroll" ref={scrollRef}>
        {error && !current ? (
          <p className="dv-state" role="alert">
            {error instanceof ApiError && error.status === 404
              ? "That file no longer exists, or the link does not point to one."
              : error instanceof ApiError && error.status === 403
                ? `The viewer will not open this file: ${error.message}`
                : `Could not load the document: ${error.message}`}
          </p>
        ) : !current ? (
          <p className="dv-state">Loading.</p>
        ) : (
          <div className="dv-grid">
            {toc ? (
              side ? (
                <div className="dv-side" data-open={tocOpen}>
                  <button
                    type="button"
                    className="dv-toc-btn"
                    aria-expanded={tocOpen}
                    aria-controls="dv-toc"
                    onClick={() => {
                      setTocOpen(!tocOpen);
                      writeStored("axiom.doc.toc", tocOpen ? "0" : "1");
                    }}
                  >
                    Contents
                  </button>
                  <nav id="dv-toc" aria-label="Table of contents" hidden={!tocOpen}>
                    {toc}
                  </nav>
                </div>
              ) : (
                <details className="dv-top-toc">
                  <summary>Contents</summary>
                  <nav aria-label="Table of contents">{toc}</nav>
                </details>
              )
            ) : null}
            <article className="dv-prose" ref={articleRef}>
              <Markdown doc={current} slug={slug} theme={theme} />
            </article>
          </div>
        )}
      </div>
    </section>
  );
}

export default DocViewer;
