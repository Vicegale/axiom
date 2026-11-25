import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ApiError, api } from "../../api";
import { useResource } from "../../data/useResource";
import { hrefs } from "../../layouts/shared/routes";
import { setDocTitle } from "../../lib/docTitle";
import { useWide } from "../../lib/wide";

/** How often an open artifact is checked for changes on disk. */
const POLL_MS = 3000;

/** No `allow-same-origin`: the page gets an opaque origin and cannot reach Axiom's API or cookies. */
export const IFRAME_SANDBOX = "allow-scripts allow-popups allow-forms allow-modals allow-downloads";

interface Props {
  slug: string;
  linkId: number;
  level?: 1 | 2;
  topicTitle?: string;
}

/** An HTML page (sandboxed iframe) or an image linked as an artifact, in the viewer's chrome. */
export function ArtifactViewer({ slug, linkId, level = 1, topicTitle }: Props) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") setTick((t) => t + 1);
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);
  const { data: fetched, error } = useResource(
    `artifact:${slug}:${linkId}`,
    () => api.artifact(slug, linkId),
    tick,
  );
  // A poll that returns the same mtime keeps the same object, so nothing below re-renders.
  const held = useRef(fetched);
  if (fetched && (held.current?.path !== fetched.path || held.current?.mtime !== fetched.mtime)) {
    held.current = fetched;
  } else if (!fetched) {
    held.current = undefined;
  }
  const art = held.current;

  const [wide, setWide] = useWide();
  const [actual, setActual] = useState(false);
  useEffect(() => {
    setDocTitle(art?.title ?? null);
    return () => setDocTitle(null);
  }, [art?.title]);

  const H = level === 1 ? "h1" : "h2";
  const rawUrl = art ? api.artifactRawUrl(slug, linkId, art.mtime) : "";

  return (
    <section
      className="dv"
      data-wide={wide ? "true" : undefined}
      data-kind={art?.kind}
      aria-label="Document"
    >
      <header className="dv-head">
        <Link href={hrefs.topic(slug)} className="dv-back">
          <span aria-hidden="true">←</span> Back to topic
          {topicTitle ? <span className="sr-only">: {topicTitle}</span> : null}
        </Link>
        <div className="dv-titles">
          <H className="dv-title">{art?.title ?? "Document"}</H>
          {art ? (
            <p className="dv-path" title={art.path}>
              {art.relPath}
            </p>
          ) : null}
        </div>
        {art?.kind === "html" ? (
          <a className="btn sm dv-wide" href={rawUrl} target="_blank" rel="noreferrer">
            Open in new tab
          </a>
        ) : null}
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
      {error && !art ? (
        <div className="dv-scroll">
          <p className="dv-state" role="alert">
            {error instanceof ApiError && error.status === 404
              ? "That file no longer exists, or the link does not point to one."
              : error instanceof ApiError && error.status === 403
                ? `The viewer will not open this file: ${error.message}`
                : error instanceof ApiError && error.status === 413
                  ? `The viewer will not open this file: ${error.message}`
                  : `Could not load the file: ${error.message}`}
          </p>
        </div>
      ) : !art ? (
        <div className="dv-scroll">
          <p className="dv-state">Loading.</p>
        </div>
      ) : art.kind === "html" ? (
        <iframe
          className="av-frame"
          title={art.title}
          src={rawUrl}
          sandbox={IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="dv-scroll av-image" data-actual={actual ? "true" : undefined}>
          <button
            type="button"
            className="av-image-btn"
            aria-pressed={actual}
            title={actual ? "Fit to the pane" : "Show at actual size"}
            onClick={() => setActual(!actual)}
          >
            <img src={rawUrl} alt={art.title} />
          </button>
        </div>
      )}
    </section>
  );
}
