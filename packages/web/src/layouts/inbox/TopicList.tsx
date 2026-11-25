import { useState } from "react";
import { Link } from "wouter";
import type { Attention, TopicListItem } from "../../api";
import { ParentChip, TaskBadge } from "../../components";
import { StatusPill } from "../../components/StatusPill";
import {
  PILES,
  PROVIDER_LABEL,
  VIEW_DOT,
  VIEW_IDS,
  VIEW_LABEL,
  type ViewId,
} from "../../lib/domain";
import { ago } from "../../lib/time";
import { inView, matchesQuery, sectionOf, spineStatus } from "../../lib/topics";
import { hrefs } from "../shared/routes";

interface Props {
  view: "all" | ViewId;
  topics: readonly TopicListItem[];
  selected: string | undefined;
  query: string;
  now: Date;
  onOpen: (slug: string) => void;
}

function byRecent(a: TopicListItem, b: TopicListItem): number {
  return a.lastWorkedAt < b.lastWorkedAt ? 1 : a.lastWorkedAt > b.lastWorkedAt ? -1 : 0;
}

/** The topics a list route shows, in display order (the arrow keys walk this). */
export function visibleTopics(
  topics: readonly TopicListItem[],
  view: "all" | ViewId,
  query: string,
): TopicListItem[] {
  const items = topics
    .filter((t) => view === "all" || inView(t, view))
    .filter((t) => matchesQuery(t, query))
    .sort(byRecent);
  if (view !== "all") return items;
  return VIEW_IDS.flatMap((v) => items.filter((t) => sectionOf(t) === v));
}

export function TopicRow({
  topic: t,
  attention,
  selected,
  now,
  onOpen,
}: {
  topic: TopicListItem;
  attention: Attention | null;
  selected: boolean;
  now: Date;
  onOpen: (slug: string) => void;
}) {
  const provs = [...new Set(t.threads.map((th) => PROVIDER_LABEL[th.provider] ?? th.provider))];
  const n = t.threads.length;
  const threadTxt =
    n === 0
      ? "No threads"
      : `${n} ${n === 1 ? "thread" : "threads"}${provs.length ? `, ${provs.join(", ")}` : ""}`;
  return (
    <li>
      <Link
        href={hrefs.topic(t.slug)}
        className={`row s-${spineStatus(t)}${t.highlighted ? " is-unread" : ""}`}
        aria-current={selected ? "true" : undefined}
        data-slug={t.slug}
        onClick={() => onOpen(t.slug)}
      >
        <span className="row-head">
          <StatusPill status={t.status} />
          <span className="row-title">{t.title}</span>
          {t.highlighted ? (
            <>
              <i className="udot" aria-hidden="true" />
              <span className="sr-only">Unread. </span>
            </>
          ) : null}
          <TaskBadge counts={t.taskCounts} />
          <time className="row-when" dateTime={t.lastWorkedAt}>
            {ago(t.lastWorkedAt, now, true)}
          </time>
        </span>
        {attention ? (
          <span className="row-reason">
            <b>{attention.reason}:</b> {attention.text}
          </span>
        ) : null}
        {t.statusNote ? <span className="row-note">{t.statusNote}</span> : null}
        <span className="row-meta">
          {t.parents.map((p) => (
            <ParentChip key={`${p.kind}:${p.slug}`} parent={p} />
          ))}
          <span className="tdots" aria-hidden="true">
            {t.threads.map((th) => (
              <i
                key={th.id}
                className={`s-${th.status}`}
                title={`${th.title ?? ""}: ${th.status}`}
              />
            ))}
          </span>
          <span className="row-threads">{threadTxt}</span>
        </span>
      </Link>
    </li>
  );
}

export function TopicList({ view, topics, selected, query, now, onOpen }: Props) {
  const [piles, setPiles] = useState<Record<string, boolean>>({});
  const items = visibleTopics(topics, view, query);
  if (!items.length) {
    return (
      <p className="empty">{query ? "No topics match the filter." : "Nothing in this view."}</p>
    );
  }
  const row = (t: TopicListItem) => (
    <TopicRow
      key={t.slug}
      topic={t}
      attention={t.attention}
      selected={t.slug === selected}
      now={now}
      onOpen={onOpen}
    />
  );
  if (view !== "all") return <ol>{items.map(row)}</ol>;
  return (
    <>
      {VIEW_IDS.map((sec) => {
        const group = items.filter((t) => sectionOf(t) === sec);
        if (!group.length) return null;
        if (!PILES.includes(sec)) {
          return (
            <div key={sec}>
              <div className="sect-h">
                <i className={`sdot ${VIEW_DOT[sec]}`} aria-hidden="true" />
                {VIEW_LABEL[sec]}
                <span className="count">{group.length}</span>
              </div>
              <ol>{group.map(row)}</ol>
            </div>
          );
        }
        const holdsSelected = group.some((t) => t.slug === selected);
        const open = piles[sec] ?? (query.trim() !== "" || holdsSelected);
        return (
          <details
            key={sec}
            className="pile"
            data-pile={sec}
            open={open}
            onToggle={(e) => {
              const isOpen = e.currentTarget.open;
              if (isOpen !== open) setPiles((p) => ({ ...p, [sec]: isOpen }));
            }}
          >
            <summary>
              <i className={`sdot ${VIEW_DOT[sec]}`} aria-hidden="true" />
              {VIEW_LABEL[sec]}
              <span className="count">{group.length}</span>
            </summary>
            <ol>{group.map(row)}</ol>
          </details>
        );
      })}
    </>
  );
}
