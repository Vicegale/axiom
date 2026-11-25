import { type KeyboardEvent, type PointerEvent, useId, useState } from "react";
import { Link } from "wouter";
import { api, type DeskThread, type DeskTopic } from "../../api";
import { useResource } from "../../data/useResource";
import { hrefs } from "../../layouts/shared/routes";
import { isPlainClick } from "../../lib/click";
import { runLine, threadLabel, threadsByActivity } from "../../lib/desk";
import { ago } from "../../lib/time";
import { StatusPill } from "../StatusPill";
import { ReplyMarkdown } from "./LazyReply";
import { ReplyBox } from "./ReplyBox";

export interface MoveHandle {
  moving: boolean;
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onBlur: () => void;
}

interface Props {
  topic: DeskTopic;
  now: Date;
  theme: "dark" | "light";
  move: MoveHandle;
  onFavorite: (on: boolean) => void;
  onHide: () => void;
  onOpen: () => void;
  onSent: () => void;
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const STAR = "M7 1.8l1.6 3.4 3.7.5-2.7 2.6.7 3.7L7 10.2 3.7 12l.7-3.7L1.7 5.7l3.7-.5z";
const HIDE = "M1.5 7s2-3.6 5.5-3.6S12.5 7 12.5 7s-2 3.6-5.5 3.6S1.5 7 1.5 7zM2.5 11.5l9-9";
const OPEN =
  "M8 2.5h3.5V6M11.5 2.5 6.5 7.5M10 8.5v2.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V4.8a.8.8 0 0 1 .8-.8h2.2";
const GRIP = "M5 3v.01M9 3v.01M5 7v.01M9 7v.01M5 11v.01M9 11v.01";

/** The full reply, fetched when the section is open and again if the thread gets a newer one. */
function ReplyBody({
  thread,
  slug,
  theme,
}: {
  thread: DeskThread;
  slug: string;
  theme: "dark" | "light";
}) {
  const { data, error } = useResource(
    `reply:${thread.id}:${thread.lastReplyAt}`,
    () => api.threadReply(thread.id),
    0,
  );
  if (error) return <p className="dk-note">Could not load the reply: {error.message}</p>;
  if (!data) return <p className="dk-note">Loading.</p>;
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable
    <section className="dk-md dv-prose" tabIndex={0} aria-label="Latest reply">
      <ReplyMarkdown text={data.text} slug={slug} theme={theme} threadId={thread.id} />
    </section>
  );
}

export function DeskCard({ topic, now, theme, move, onFavorite, onHide, onOpen, onSent }: Props) {
  const uid = useId();
  const threads = threadsByActivity(topic.threads);
  const [picked, setPicked] = useState<number | null>(null);
  const thread = threads.find((t) => t.id === picked) ?? threads[0] ?? null;
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const href = hrefs.topic(topic.slug);
  const open = (e: React.MouseEvent) => {
    if (isPlainClick(e)) onOpen();
  };
  const tc = topic.taskCounts;
  const next = thread?.summary?.next.trim();

  return (
    <article
      className={`dk-card${topic.highlighted ? " hl" : ""}${move.moving ? " moving" : ""}${
        topic.favorite ? " fav" : ""
      }`}
      data-slug={topic.slug}
      aria-labelledby={`${uid}-t`}
    >
      <header className="dk-head">
        <h2 id={`${uid}-t`} className="dk-title">
          <Link href={href} onClick={open}>
            {topic.title}
          </Link>
        </h2>
        <span className="dk-tools">
          <button
            type="button"
            className="icon-btn dk-move"
            aria-label={`Move ${topic.title}`}
            aria-describedby={`${uid}-mh`}
            title="Drag to move, or use the arrow keys and Enter"
            data-moving={move.moving ? "true" : undefined}
            onPointerDown={move.onPointerDown}
            onKeyDown={move.onKeyDown}
            onBlur={move.onBlur}
          >
            <Icon d={GRIP} />
          </button>
          <span id={`${uid}-mh`} className="sr-only">
            Arrow keys move the card, Enter drops it, Escape cancels.
          </span>
          <button
            type="button"
            className={`icon-btn dk-fav${topic.favorite ? " on" : ""}`}
            aria-pressed={topic.favorite}
            aria-label={`Favourite ${topic.title}`}
            title={topic.favorite ? "Remove from favourites" : "Favourite"}
            onClick={() => onFavorite(!topic.favorite)}
          >
            <Icon d={STAR} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Hide ${topic.title} from the Desk`}
            title="Hide from the Desk (it stays in the tracker)"
            onClick={onHide}
          >
            <Icon d={HIDE} />
          </button>
          <Link
            href={href}
            className="icon-btn"
            aria-label={`Open ${topic.title}`}
            title="Open the topic"
            onClick={open}
          >
            <Icon d={OPEN} />
          </Link>
        </span>
      </header>

      <span className="dk-pills">
        <StatusPill status={topic.status} />
        {/* The selected thread's status only when it says something the topic's doesn't. */}
        {thread && thread.status !== topic.status ? (
          <span className="dk-thpill" title="Selected thread">
            <span className="dk-thpill-l">thread</span>
            <StatusPill status={thread.status} />
          </span>
        ) : null}
      </span>
      <p className="dk-meta">
        <span>{tc.total === 0 ? "No tasks yet" : `${tc.done}/${tc.total} done`}</span>
        <span>
          Last worked <time dateTime={topic.lastWorkedAt}>{ago(topic.lastWorkedAt, now)}</time>
        </span>
        <span>
          {topic.linkCount} {topic.linkCount === 1 ? "link" : "links"}
        </span>
      </p>

      <div className="dk-thread">
        <label htmlFor={`${uid}-th`}>Thread</label>
        {threads.length > 1 ? (
          <select
            id={`${uid}-th`}
            value={thread?.id}
            onChange={(e) => setPicked(Number(e.target.value))}
          >
            {threads.map((t) => (
              <option key={t.id} value={t.id}>
                {threadLabel(t)}
              </option>
            ))}
          </select>
        ) : (
          <span id={`${uid}-th`} className="dk-thread-one">
            {thread ? threadLabel(thread) : "No threads yet"}
          </span>
        )}
      </div>

      {thread ? (
        <>
          <p className="dk-run">
            <span className={`dk-rundot s-${thread.status}`} aria-hidden="true" />
            {runLine(thread, now)}
          </p>
          <div className="dk-now" aria-busy={thread.summaryPending ? true : undefined}>
            <p className="dk-label">
              Now
              {thread.summaryPending ? (
                <span className="dk-gen" role="status">
                  {thread.summary ? "Updating…" : "Generating…"}
                </span>
              ) : null}
            </p>
            {thread.summary ? (
              <div className={thread.summaryPending ? "dk-stale" : undefined}>
                <p className="dk-now-text">{thread.summary.now}</p>
                {next && next.toLowerCase() !== "nothing" ? (
                  <p className="dk-next">
                    <span>Next for you</span> {next}
                  </p>
                ) : null}
              </div>
            ) : thread.summaryPending ? (
              // Placeholder lines the size of a typical summary, so the card doesn't jump.
              <div className="dk-skel" aria-hidden="true">
                <span />
                <span />
                <span className="short" />
              </div>
            ) : (
              <p className="dk-note">{thread.summaryError ?? "No summary yet"}</p>
            )}
          </div>

          {thread.hasReply ? (
            <>
              <button
                type="button"
                className="dk-reply-toggle"
                aria-expanded={expanded}
                aria-controls={`${uid}-rp`}
                onClick={() => setExpanded((v) => !v)}
              >
                <span>
                  Latest reply
                  {thread.lastReplyAt ? ` · ${ago(thread.lastReplyAt, now)}` : ""}
                </span>
                <span>{expanded ? "hide ▴" : "show ▾"}</span>
              </button>
              <div id={`${uid}-rp`} hidden={!expanded}>
                {expanded ? <ReplyBody thread={thread} slug={topic.slug} theme={theme} /> : null}
              </div>
            </>
          ) : (
            <p className="dk-reply-none">No reply yet</p>
          )}
        </>
      ) : null}

      <div className="dk-foot">
        <button
          type="button"
          className="btn ghost"
          aria-expanded={replying}
          aria-controls={`${uid}-rb`}
          onClick={() => setReplying((v) => !v)}
        >
          Reply
        </button>
      </div>
      <div id={`${uid}-rb`} hidden={!replying}>
        {replying ? (
          <ReplyBox
            topicSlug={topic.slug}
            thread={thread}
            threads={threads}
            onSent={() => {
              setReplying(false);
              onSent();
            }}
            onClose={() => setReplying(false)}
          />
        ) : null}
      </div>
    </article>
  );
}
