import { useState } from "react";
import { Link } from "wouter";
import type {
  Entry,
  LinkItem,
  MonitorTarget,
  Parent,
  TaskItem,
  Thread,
  TopicDetailData,
} from "../api";
import { hrefs } from "../layouts/shared/routes";
import type { TaskStatus } from "../lib/domain";
import { LINK_ORDER, PROVIDER_LABEL } from "../lib/domain";
import { hasScheme, isMarkdownPath } from "../lib/paths";
import { ago, fullStamp, idleDays, stamp } from "../lib/time";
import { type Density, History } from "./History";
import { ParentChip } from "./ParentChip";
import { StatusPill } from "./StatusPill";
import { T3Picker } from "./T3Picker";
import { GraphSection, TasksSection } from "./Tasks";

export interface TopicDetailActions {
  onToggleMute: (muted: boolean) => void;
  onMarkStale: () => void;
  onDismissStale: () => void;
  onConfirmMonitor: (id: number) => void;
  onDeleteEntry: (id: number) => void;
  onTaskStatus: (key: string, status: TaskStatus) => void;
}

interface Props {
  topic: TopicDetailData;
  /** undefined while the history is still loading. */
  entries: readonly Entry[] | undefined;
  /** The topic's tasks; undefined while they load. */
  tasks?: readonly TaskItem[];
  /** Hide the Tasks and Graph sections while the topic has no tasks (the tabs show them). */
  hideEmptyTasks?: boolean;
  /** Called when a graph node is picked, so a tabbed container can switch to the Tasks tab. */
  onPickTask?: (key: string) => void;
  /** Ticket slug to the title of the epic it sits under, for "in <epic>". */
  ticketEpics?: Record<string, string>;
  density?: Density;
  now?: Date;
  actions: TopicDetailActions;
}

/**
 * The topic as the owner reads it. Rendered inside the Inbox reading pane today; the Board sheet
 * and Console panel reuse it.
 */
export function TopicDetail({
  topic: t,
  entries,
  tasks,
  hideEmptyTasks = true,
  onPickTask,
  ticketEpics = {},
  density = "roomy",
  now,
  actions,
}: Props) {
  const at = now ?? new Date();
  const [picked, setPicked] = useState<{ key: string; n: number } | null>(null);
  const showTasks = tasks !== undefined && (tasks.length > 0 || !hideEmptyTasks);
  const attnStatus = t.status ?? (t.openThreadStatuses.includes("error") ? "error" : "hitl");
  return (
    <article className="r-inner" aria-labelledby="r-title">
      <div className="r-top">
        <span className="slug">{t.slug}</span>
        <div className="r-top-actions">
          <button
            type="button"
            className="btn"
            aria-pressed={t.muted}
            onClick={() => actions.onToggleMute(!t.muted)}
            title="Muting hides notifications from this topic, questions included. Its highlight still shows until you open it."
          >
            {t.muted ? "Muted" : "Mute topic"}
          </button>
        </div>
      </div>
      <h1 className="r-h1" id="r-title" tabIndex={-1}>
        {t.title}
      </h1>
      <div className="status-row">
        <StatusPill status={t.status} />
        {t.statusNote ? <span className="status-note">{t.statusNote}</span> : null}
      </div>
      {t.status === null ? (
        <p className="hint">
          More than one thread, so this topic has no status of its own. Each thread shows its own
          status below.
        </p>
      ) : null}
      {t.muted ? (
        <p className="hint">
          Muted. Notifications from this topic are hidden, questions included. Its highlight still
          shows until you open it.
        </p>
      ) : null}
      {t.attention ? (
        <div className={`callout s-${attnStatus}`} role="note">
          <strong>{t.attention.reason}:</strong> {t.attention.text}
        </div>
      ) : null}
      {t.stalePrompt ? (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the prompt box
        <div className="prompt" role="group" aria-label="Mark as stale?">
          <p>Idle for {idleDays(t.lastWorkedAt, at)} days. Mark as stale?</p>
          <div className="prompt-actions">
            <button type="button" className="btn primary" onClick={actions.onMarkStale}>
              Mark stale
            </button>
            <button type="button" className="btn ghost" onClick={actions.onDismissStale}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <dl className="facts">
        {t.goal ? (
          <>
            <dt>Goal</dt>
            <dd>{t.goal}</dd>
          </>
        ) : null}
        <dt>Parents</dt>
        <dd>
          <Parents parents={t.parents} ticketEpics={ticketEpics} />
        </dd>
        {t.links.length ? (
          <>
            <dt>Links</dt>
            <dd>
              <Links links={t.links} slug={t.slug} />
            </dd>
          </>
        ) : null}
        {t.monitorTargets.length ? (
          <>
            <dt>Watching</dt>
            <dd>
              <Monitors
                targets={t.monitorTargets}
                links={t.links}
                onConfirm={actions.onConfirmMonitor}
              />
            </dd>
          </>
        ) : null}
        <dt>Created</dt>
        <dd>{fullStamp(t.createdAt)}</dd>
        <dt>Last worked</dt>
        <dd>
          {fullStamp(t.lastWorkedAt)} <span className="meta">{ago(t.lastWorkedAt, at)}</span>
        </dd>
      </dl>

      <section className="sec" aria-labelledby="h-threads">
        <div className="sec-h">
          <div className="sec-title">
            <h2 id="h-threads">Threads</h2>
            <span className="count">{t.threads.length}</span>
          </div>
          <T3Picker slug={t.slug} now={at} />
        </div>
        {t.threads.length ? (
          <ul className="threads">
            {t.threads.map((th) => (
              <ThreadRow key={th.id} thread={th} now={at} />
            ))}
          </ul>
        ) : (
          <p className="empty-line">No threads attached.</p>
        )}
      </section>

      {showTasks ? (
        <>
          <TasksSection
            tasks={tasks}
            links={t.links}
            picked={picked}
            onStatus={actions.onTaskStatus}
          />
          <GraphSection
            tasks={tasks}
            onPick={(key) => {
              setPicked((p) => ({ key, n: (p?.n ?? 0) + 1 }));
              onPickTask?.(key);
            }}
          />
        </>
      ) : null}

      <section className="sec" aria-labelledby="h-hist">
        <div className="sec-h">
          <div className="sec-title">
            <h2 id="h-hist">History</h2>
            <span className="count">{entries?.length ?? ""}</span>
          </div>
        </div>
        {entries ? (
          <History
            entries={entries}
            threads={t.threads}
            density={density}
            now={at}
            onDelete={actions.onDeleteEntry}
          />
        ) : (
          <p className="empty-line">Loading history.</p>
        )}
      </section>
    </article>
  );
}

function Parents({
  parents,
  ticketEpics,
}: {
  parents: readonly Parent[];
  ticketEpics: Record<string, string>;
}) {
  if (!parents.length) return <span className="meta">None</span>;
  return (
    <ul className="parents">
      {parents.map((p) => {
        const under = p.kind === "ticket" ? ticketEpics[p.slug] : undefined;
        return (
          <li key={`${p.kind}:${p.slug}`}>
            <ParentChip parent={p} detailed />
            {under ? <span className="p-under">in {under}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Provider ids can be long (T3 launch ids are ~80 chars): show the distinctive tail. */
function shortId(id: string): string {
  const tail = id.split(":").pop() ?? id;
  return tail.length > 12 ? `…${tail.slice(-8)}` : tail;
}

function ThreadRow({ thread: th, now }: { thread: Thread; now: Date }) {
  const end = th.endedAt ? stamp(th.endedAt, now) : "open";
  return (
    <li className={`thread s-${th.status}`}>
      <span className="prov">{PROVIDER_LABEL[th.provider] ?? th.provider}</span>
      <span className="th-main">
        <span className="th-head">
          <span className="th-title">
            {th.title || `Untitled ${PROVIDER_LABEL[th.provider] ?? th.provider} thread`}
          </span>
          <ThreadOpen thread={th} />
        </span>
        <span className="th-meta">
          <span title={th.providerThreadId}>{shortId(th.providerThreadId)}</span>
          {th.environmentId ? <span>{th.environmentId}</span> : null}
        </span>
      </span>
      <StatusPill status={th.status} />
      <time className="th-time">
        {stamp(th.startedAt, now)} → {end}
      </time>
    </li>
  );
}

const ExternalIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
    <path
      d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CopyIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
    <rect
      x="5.5"
      y="5.5"
      width="8"
      height="8"
      rx="1.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path
      d="M10.5 3.5v-.5a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

/**
 * A small icon beside the thread title: open the thread in the T3 app, or copy the command that
 * resumes a direct Claude Code session.
 */
function ThreadOpen({ thread: th }: { thread: Thread }) {
  const [copied, setCopied] = useState(false);
  const open = th.open;
  if (!open) return null;
  if (open.kind === "url") {
    return (
      <a
        className="th-open"
        href={open.url}
        aria-label="Open in T3"
        title="Open this thread in the T3 app"
      >
        <ExternalIcon />
      </a>
    );
  }
  return (
    <button
      type="button"
      className="th-open"
      aria-label={copied ? "Copied" : "Copy resume command"}
      title={copied ? "Copied" : `Copy: ${open.command}`}
      onClick={() => {
        void navigator.clipboard?.writeText(open.command).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          },
          () => undefined,
        );
      }}
    >
      {copied ? "✓" : <CopyIcon />}
    </button>
  );
}

/** An http(s) URL, or a GitHub "owner/repo#N" pull request, as an address; otherwise null. */
function hrefOf(l: LinkItem): string | null {
  if (/^https?:\/\//.test(l.target)) return l.target;
  const pr = l.kind === "pr" ? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(l.target) : null;
  return pr ? `https://github.com/${pr[1]}/pull/${pr[2]}` : null;
}

/** A spec, or an artifact that is a Markdown file, opens in the document viewer. */
function viewable(l: LinkItem): boolean {
  return (
    (l.kind === "spec" || l.kind === "artifact") && !hasScheme(l.target) && isMarkdownPath(l.target)
  );
}

function LinkChip({ link: l, slug }: { link: LinkItem; slug: string }) {
  const href = hrefOf(l);
  const title = l.label ? `${l.label}: ${l.target}` : l.target;
  const text = l.label ?? l.target;
  if (viewable(l)) {
    // A real link: a plain click opens the viewer here, a modified click a new tab.
    return (
      <Link className="lchip" href={hrefs.doc(slug, l.id)} title={title}>
        {text}
      </Link>
    );
  }
  return href ? (
    <a className="lchip" href={href} target="_blank" rel="noreferrer" title={title}>
      {text}
    </a>
  ) : (
    <span className="lchip" title={title}>
      {text}
    </span>
  );
}

/** One compact line per link kind present. */
function Links({ links, slug }: { links: readonly LinkItem[]; slug: string }) {
  const kinds = [...LINK_ORDER];
  for (const l of links) if (!kinds.includes(l.kind)) kinds.push(l.kind);
  return (
    <div className="lines">
      {kinds.map((k) => {
        const ls = links.filter((l) => l.kind === k);
        if (!ls.length) return null;
        return (
          <div className="lline" key={k}>
            <span className="lkind">{k}</span>
            {ls.map((l) => (
              <LinkChip key={l.id} link={l} slug={slug} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Monitors({
  targets,
  links,
  onConfirm,
}: {
  targets: readonly MonitorTarget[];
  links: readonly LinkItem[];
  onConfirm: (id: number) => void;
}) {
  return (
    <div className="lline">
      {targets.map((m) => {
        const target = links.find((l) => l.id === m.linkId)?.target ?? "no link";
        const suggested = m.state === "suggested";
        return (
          <span className="mchip-wrap" key={m.id}>
            <span
              className={`lchip mchip ${m.state}`}
              title={`${m.kind} ${target} (${suggested ? "suggested, not yet confirmed" : m.state})`}
            >
              {m.kind} {target}
              {suggested ? null : " ✓"}
            </span>
            {suggested ? (
              <button type="button" className="btn sm" onClick={() => onConfirm(m.id)}>
                Confirm
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
