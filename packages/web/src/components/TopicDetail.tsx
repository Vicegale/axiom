import type { Entry, LinkItem, MonitorTarget, Parent, Thread, TopicDetailData } from "../api";
import { LINK_LABEL, LINK_ORDER, PROVIDER_LABEL } from "../lib/domain";
import { ago, fullStamp, idleDays, stamp } from "../lib/time";
import { type Density, History } from "./History";
import { Lock } from "./Icons";
import { StatusPill } from "./StatusPill";
import { T3Picker } from "./T3Picker";

export interface TopicDetailActions {
  onToggleMute: (muted: boolean) => void;
  onMarkStale: () => void;
  onDismissStale: () => void;
  onConfirmMonitor: (id: number) => void;
  onDeleteEntry: (id: number) => void;
}

interface Props {
  topic: TopicDetailData;
  /** undefined while the history is still loading. */
  entries: readonly Entry[] | undefined;
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
  ticketEpics = {},
  density = "roomy",
  now,
  actions,
}: Props) {
  const at = now ?? new Date();
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

      <div className="two">
        <section className="sec" aria-labelledby="h-links">
          <div className="sec-h">
            <div className="sec-title">
              <h2 id="h-links">Links</h2>
            </div>
          </div>
          <Links links={t.links} />
        </section>
        <section className="sec" aria-labelledby="h-mons">
          <div className="sec-h">
            <div className="sec-title">
              <h2 id="h-mons">Monitoring targets</h2>
            </div>
          </div>
          <Monitors
            targets={t.monitorTargets}
            links={t.links}
            onConfirm={actions.onConfirmMonitor}
          />
        </section>
      </div>

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
            <span className="p-kind">{p.kind === "ticket" ? "Ticket" : "Epic"}</span>
            <span className="p-title">{p.title}</span>
            {p.jiraKey ? (
              <span className="p-st">
                {p.jiraKey} {p.jiraStatus ?? ""}
                {p.locked ? <Lock /> : null}
              </span>
            ) : (
              <span className="p-st">{p.status}</span>
            )}
            {under ? <span className="p-under">in {under}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function ThreadRow({ thread: th, now }: { thread: Thread; now: Date }) {
  const end = th.endedAt ? stamp(th.endedAt, now) : "open";
  return (
    <li className={`thread s-${th.status}`}>
      <span className="prov">{PROVIDER_LABEL[th.provider] ?? th.provider}</span>
      <span className="th-main">
        <span className="th-title">{th.title ?? th.providerThreadId}</span>
        <span className="th-meta">
          <span>{th.providerThreadId}</span>
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

function Links({ links }: { links: readonly LinkItem[] }) {
  if (!links.length) return <p className="empty-line">No links.</p>;
  const kinds = [...LINK_ORDER];
  for (const l of links) if (!kinds.includes(l.kind)) kinds.push(l.kind);
  return (
    <>
      {kinds.map((k) => {
        const ls = links.filter((l) => l.kind === k);
        if (!ls.length) return null;
        return (
          <div className="lgroup" key={k}>
            <h3>{LINK_LABEL[k] ?? k}</h3>
            {ls.map((l) => (
              <div className="lnk" key={l.id}>
                {l.label ? <span className="l-label">{l.label}</span> : null}
                <span className="l-target">{l.target}</span>
              </div>
            ))}
          </div>
        );
      })}
    </>
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
  if (!targets.length) {
    return (
      <p className="empty-line">
        None yet. Axiom suggests targets from links, such as an open PR or a Jira item.
      </p>
    );
  }
  return (
    <>
      <ul>
        {targets.map((m) => {
          const link = links.find((l) => l.id === m.linkId);
          return (
            <li className="mon" key={m.id}>
              <span className="mon-kind">{m.kind}</span>
              <span className="mon-target">{link?.target ?? "no link"}</span>
              <span className="mon-end">
                <span className={`mon-state ${m.state}`}>{m.state}</span>
                {m.state === "suggested" ? (
                  <button type="button" className="btn sm" onClick={() => onConfirm(m.id)}>
                    Confirm
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="hint">Suggested targets come from links. An agent or you confirm them.</p>
    </>
  );
}
