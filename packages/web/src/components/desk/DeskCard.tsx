import { type KeyboardEvent, type PointerEvent, useId, useState } from "react";
import { Link } from "wouter";
import { api, type DeskThread, type DeskTopic, type ThreadRuntime } from "../../api";
import { useResource } from "../../data/useResource";
import { hrefs } from "../../layouts/shared/routes";
import { isPlainClick } from "../../lib/click";
import {
  activityAge,
  contextLevel,
  contextRatio,
  modelName,
  runLine,
  runningActivity,
  runningSubagents,
  SUBAGENT_STATUS_WORD,
  type SubagentNode,
  subagentNames,
  subagentSummary,
  subagentTime,
  subagentTree,
  threadLabel,
  threadsByActivity,
  tokenCount,
} from "../../lib/desk";
import { ago } from "../../lib/time";
import { useNow } from "../../lib/useNow";
import { ArtifactsMenu } from "../ArtifactsMenu";
import { StatusPill } from "../StatusPill";
import { ReplyMarkdown } from "./LazyReply";
import { ReplyBox } from "./ReplyBox";
import { RequestsPanel } from "./RequestsPanel";

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

/** How old the step is once it is more than a few seconds old; ticks on its own clock. */
function ActivityAge({ at }: { at: string }) {
  const age = activityAge(at, useNow(5000));
  return age ? (
    <time className="dk-actage" dateTime={at}>
      · {age}
    </time>
  ) : null;
}

/**
 * What the thread runs on: "Opus 5.5 · high" and a context meter ("190k / 1M" with a bar when the
 * window is known, "190k ctx" without). Nothing at all until something is known.
 */
function Runtime({ runtime: r }: { runtime: ThreadRuntime | null }) {
  if (!r || (r.model === null && r.effort === null && r.contextUsed === null)) return null;
  const used = r.contextUsed;
  const max = r.contextMax;
  const ratio = contextRatio(used, max);
  const nf = new Intl.NumberFormat("en");
  const model = r.model === null ? null : modelName(r.model);
  const modelTip = [r.model, r.effort ? `effort ${r.effort}` : null].filter(Boolean).join(" · ");
  return (
    <div className="dk-runtime">
      {model !== null || r.effort !== null ? (
        <span className="dk-model" title={modelTip}>
          {[model, r.effort].filter((x) => x !== null).join(" · ")}
        </span>
      ) : null}
      {used !== null && ratio !== null && max !== null ? (
        <span
          className="dk-ctx"
          title={`Context: ${nf.format(used)} of ${nf.format(max)} tokens (${Math.round(ratio * 100)}%)`}
        >
          {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot be styled alike in every browser */}
          <span
            className="dk-meter"
            role="meter"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={Math.min(used, max)}
            aria-valuetext={`${tokenCount(used)} of ${tokenCount(max)}`}
            data-level={contextLevel(ratio)}
          >
            <span className="dk-meter-fill" style={{ width: `${ratio * 100}%` }} />
          </span>
          <span aria-hidden="true">
            {tokenCount(used)} / {tokenCount(max)}
          </span>
        </span>
      ) : used !== null ? (
        <span
          className="dk-ctx"
          title={`Context: ${nf.format(used)} tokens (window size unknown)`}
          role="img"
          aria-label={`Context used: ${tokenCount(used)} tokens`}
        >
          <span aria-hidden="true">{tokenCount(used)} ctx</span>
        </span>
      ) : null}
    </div>
  );
}

/** One subagent: status dot, name, type or model, time, the latest step while it runs, and its own. */
function SubagentRow({ node, now }: { node: SubagentNode; now: Date }) {
  const s = node.agent;
  const { name, kind } = subagentNames(s);
  return (
    <li className="dk-tn">
      <div className="dk-tr">
        <span className="dk-tdot" data-s={s.status} aria-hidden="true" />
        <span className="dk-tname" title={name}>
          <span className="sr-only">{SUBAGENT_STATUS_WORD[s.status]}: </span>
          {name}
        </span>
        <span className="dk-tmeta">
          {kind ? `${kind} · ` : ""}
          <time dateTime={s.startedAt}>{subagentTime(s, now)}</time>
        </span>
      </div>
      {s.status === "running" && s.progress ? (
        <p className="dk-tstep" title={s.progress}>
          {s.progress}
        </p>
      ) : null}
      {node.children.length > 0 ? (
        <ul className="dk-kids">
          {node.children.map((c) => (
            <SubagentRow key={c.agent.id} node={c} now={now} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The subagent tree: the thread at the top, the subagents it started below it (and theirs below
 * them), each with a status dot (running, done, failed, cancelled).
 */
function SubagentTree({ thread, now }: { thread: DeskThread; now: Date }) {
  const tree = subagentTree(thread.subagents);
  return (
    <ul className="dk-tlist" aria-label={`Agents of ${threadLabel(thread)}`}>
      <li className="dk-tn">
        <div className="dk-tr">
          <span className={`dk-tdot s-${thread.status}`} aria-hidden="true" />
          <span className="dk-tname dk-troot" title={threadLabel(thread)}>
            {threadLabel(thread)}
          </span>
          <span className="dk-tmeta">{runLine(thread, now)}</span>
        </div>
        <ul className="dk-kids">
          {tree.map((n) => (
            <SubagentRow key={n.agent.id} node={n} now={now} />
          ))}
        </ul>
      </li>
    </ul>
  );
}

/**
 * The subagents as a disclosure: one box whose header row is the toggle (chevron, count and
 * outcome, a dot per subagent) and whose body is the tree. Open while any subagent runs, folded
 * once all have finished; the owner's choice holds while that state does.
 */
function Subagents({ thread, now }: { thread: DeskThread; now: Date }) {
  const bodyId = useId();
  const [choice, setChoice] = useState<{ whileRunning: boolean; open: boolean } | null>(null);
  const subs = thread.subagents;
  const running = runningSubagents(subs) > 0;
  const shown = choice?.whileRunning === running ? choice.open : running;
  return (
    <div className={`dk-agents${shown ? " open" : ""}`}>
      <button
        type="button"
        className="dk-agentsbtn"
        aria-expanded={shown}
        aria-controls={shown ? bodyId : undefined}
        onClick={() => setChoice({ whileRunning: running, open: !shown })}
      >
        <span className="dk-agents-chev" aria-hidden="true" />
        <span className="dk-agents-label">{subagentSummary(subs)}</span>
        <span className="dk-agents-dots" aria-hidden="true">
          {subs.slice(0, 12).map((s) => (
            <span key={s.id} className="dk-tdot" data-s={s.status} />
          ))}
        </span>
      </button>
      {shown ? (
        <div className="dk-agents-body" id={bodyId}>
          <SubagentTree thread={thread} now={now} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One fixed-height line: the run state, and for a running thread its newest step. Its subagents,
 * if any, follow as their own disclosure box (see Subagents).
 */
function RunLine({ thread, now }: { thread: DeskThread; now: Date }) {
  const step = runningActivity(thread);
  const subs = thread.subagents;
  // An idle thread with running subagents is waiting on them.
  const waiting =
    runningSubagents(subs) > 0 &&
    thread.status !== "wip" &&
    thread.status !== "hitl" &&
    thread.status !== "error";
  return (
    <>
      <p className={`dk-run${step ? " live" : ""}`}>
        <span className={`dk-rundot s-${thread.status}`} aria-hidden="true" />
        {step ? (
          <>
            <span className="dk-runtext" title={`running · ${step}`}>
              running · <span className="dk-act">{step}</span>
            </span>
            {thread.activity ? <ActivityAge at={thread.activity.at} /> : null}
          </>
        ) : (
          <span className="dk-runtext">
            {waiting ? "waiting on subagents" : runLine(thread, now)}
          </span>
        )}
      </p>
      {subs.length > 0 ? <Subagents thread={thread} now={now} /> : null}
    </>
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
      onKeyDown={(e) => {
        // `r` on a focused card (not while typing in a field) opens the composer.
        if (e.key !== "r" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
        const el = e.target as HTMLElement;
        if (el.closest("input, textarea, select, [contenteditable], [role=menu]")) return;
        e.preventDefault();
        setReplying(true);
      }}
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
      <div className="dk-meta">
        <span>{tc.total === 0 ? "No tasks yet" : `${tc.done}/${tc.total} done`}</span>
        <span>
          Last worked <time dateTime={topic.lastWorkedAt}>{ago(topic.lastWorkedAt, now)}</time>
        </span>
        <span className="dk-links">
          <span>
            {topic.linkCount} {topic.linkCount === 1 ? "link" : "links"}
          </span>
          {topic.artifacts.length > 0 ? (
            <ArtifactsMenu links={topic.artifacts} slug={topic.slug} />
          ) : null}
        </span>
      </div>

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
          <Runtime runtime={thread.runtime} />
          <RunLine key={thread.id} thread={thread} now={now} />
          <RequestsPanel thread={thread} />
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

      <ReplyBox
        topicSlug={topic.slug}
        thread={thread}
        threads={threads}
        repository={topic.repository}
        open={replying}
        onOpenChange={setReplying}
        onSent={onSent}
      />
    </article>
  );
}
