import { Link } from "wouter";
import type { TopicListItem } from "../../api";
import { ParentChip, StatusPill, TaskBadge } from "../../components";
import { isPlainClick, onInteractive } from "../../lib/click";
import { PROVIDER_LABEL, VIEW_STATUSES, type ViewId } from "../../lib/domain";
import { ago, idleDays } from "../../lib/time";
import { spineStatus } from "../../lib/topics";
import { hrefs } from "../shared/routes";

interface Props {
  topic: TopicListItem;
  lane: ViewId;
  now: Date;
  onOpen: (slug: string) => void;
  onMarkStale: (slug: string) => void;
  onDismissStale: (slug: string) => void;
}

const PROV_SHORT: Record<string, string> = { t3: "T3", "claude-code": "CC" };

/** A topic card. Clicking it opens the topic sheet; a topic with no status shows in several
 *  lanes, dimming the threads that belong to other lanes. */
export function Card({ topic: t, lane, now, onOpen, onMarkStale, onDismissStale }: Props) {
  const status = spineStatus(t);
  const reason = lane === "attention" ? t.attention : null;
  const open = () => onOpen(t.slug);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the title link inside is the keyboard target
    <article
      className={`bd-card s-${status}${t.highlighted ? " is-unread" : ""}`}
      data-slug={t.slug}
      onClick={(e) => {
        if (isPlainClick(e) && !onInteractive(e)) open();
      }}
    >
      <div className="bd-card-top">
        <StatusPill status={t.status} />
        {t.muted ? <span className="bd-muted">muted</span> : null}
        <TaskBadge counts={t.taskCounts} />
        {t.highlighted ? (
          <span className="bd-unread" title="Unread">
            <span className="sr-only">Unread</span>
          </span>
        ) : null}
      </div>
      <h3 className="bd-card-title">
        <Link href={hrefs.topic(t.slug)} onClick={open}>
          {t.title}
        </Link>
      </h3>
      {reason ? (
        <div className="bd-reason">
          <span className="bd-reason-k">{reason.reason}</span>
          <p>{reason.text}</p>
        </div>
      ) : null}
      {t.statusNote ? <p className="bd-note">{t.statusNote}</p> : null}
      {t.parents.length ? (
        <div className="bd-chips">
          {t.parents.map((p) => (
            <ParentChip key={`${p.kind}:${p.slug}`} parent={p} />
          ))}
        </div>
      ) : null}
      {t.threads.length ? (
        <ul className="bd-thr-list">
          {t.threads.map((th) => {
            const dim = t.status === null && !VIEW_STATUSES[lane].includes(th.status);
            return (
              <li key={th.id} className={`bd-thr s-${th.status}${dim ? " is-dim" : ""}`}>
                <span className="bd-prov" title={PROVIDER_LABEL[th.provider] ?? th.provider}>
                  {PROV_SHORT[th.provider] ?? th.provider}
                </span>
                <span className="bd-thr-t">{th.title ?? "Untitled thread"}</span>
                <span className="bd-dot" title={th.status}>
                  <span className="sr-only">{th.status}</span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {t.stalePrompt ? (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the prompt box
        <div
          className="bd-stale"
          role="group"
          aria-label="Mark as stale?"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <p>Idle for {idleDays(t.lastWorkedAt, now)} days. Mark as stale?</p>
          <div className="bd-acts">
            <button type="button" className="btn primary sm" onClick={() => onMarkStale(t.slug)}>
              Mark stale
            </button>
            <button type="button" className="btn ghost sm" onClick={() => onDismissStale(t.slug)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      <footer className="bd-card-foot">
        <span>Last worked {ago(t.lastWorkedAt, now)}</span>
        {t.status === null ? <span>{t.threads.length} threads, no status</span> : null}
      </footer>
    </article>
  );
}
