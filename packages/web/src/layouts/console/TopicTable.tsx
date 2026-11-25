import { Link } from "wouter";
import type { TopicListItem } from "../../api";
import { ParentChip, TaskBadge } from "../../components";
import { isPlainClick, onInteractive } from "../../lib/click";
import { PROVIDER_LABEL, VIEW_LABEL, type ViewId } from "../../lib/domain";
import { ago } from "../../lib/time";
import type { SortKey } from "../../lib/topics";
import { hrefs } from "../shared/routes";
import { Glyph } from "./Glyph";

export interface Group {
  view: ViewId;
  topics: readonly TopicListItem[];
}

interface Props {
  groups: readonly Group[];
  selected: string | undefined;
  sort: SortKey;
  dir: 1 | -1;
  now: Date;
  onSort: (key: SortKey) => void;
  onOpen: (slug: string) => void;
  /** Open the topic and show it (a click on the row). */
  onGo: (slug: string) => void;
}

const HEADERS: { key: SortKey | null; label: string; cls: string }[] = [
  { key: "status", label: "St", cls: "c-st" },
  { key: "slug", label: "Slug", cls: "c-slug" },
  { key: "title", label: "Title", cls: "c-title" },
  { key: null, label: "Status note", cls: "c-note" },
  { key: null, label: "Parents", cls: "c-par" },
  { key: null, label: "Threads", cls: "c-thr" },
  { key: "last", label: "Last worked", cls: "c-last" },
];

/** "T3×2 Claude Code×1", or a dash. */
export function providerSummary(t: Pick<TopicListItem, "threads">): string {
  const counts = new Map<string, number>();
  for (const th of t.threads) counts.set(th.provider, (counts.get(th.provider) ?? 0) + 1);
  if (!counts.size) return "—";
  return [...counts].map(([p, n]) => `${PROVIDER_LABEL[p] ?? p}×${n}`).join(" ");
}

/** The dense table, grouped by view. A topic with no status repeats in each view one of its
 *  open threads belongs to. */
export function TopicTable({ groups, selected, sort, dir, now, onSort, onGo, onOpen }: Props) {
  return (
    <table className="cs-table" aria-label="Topics grouped by view">
      <colgroup>
        {HEADERS.map((h) => (
          <col key={h.cls} className={h.cls} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {HEADERS.map((h) => (
            <th
              key={h.cls}
              scope="col"
              className={h.cls}
              aria-sort={
                h.key && h.key === sort ? (dir > 0 ? "ascending" : "descending") : undefined
              }
            >
              {h.key ? (
                <button type="button" onClick={() => onSort(h.key as SortKey)}>
                  {h.label}
                </button>
              ) : (
                h.label
              )}
            </th>
          ))}
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.view} data-group={g.view}>
          <tr className="cs-grp">
            <th colSpan={HEADERS.length} scope="colgroup">
              {VIEW_LABEL[g.view]}
              <span className="count">{g.topics.length}</span>
            </th>
          </tr>
          {g.topics.length ? (
            g.topics.map((t) => (
              <tr
                key={t.slug}
                className={`cs-row${t.highlighted ? " unread" : ""}${t.muted ? " muted" : ""}${t.status === "done" ? " faded" : ""}`}
                data-slug={t.slug}
                aria-selected={selected === t.slug}
                tabIndex={-1}
                onClick={(e) => {
                  if (isPlainClick(e) && !onInteractive(e)) onGo(t.slug);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.target === e.currentTarget) onGo(t.slug);
                }}
              >
                <td className="c-st">
                  <Glyph status={t.status} />
                </td>
                <td className="c-slug">
                  <span className={`cs-udot${t.highlighted ? "" : " off"}`} aria-hidden="true" />
                  <Link href={hrefs.topic(t.slug)} onClick={() => onOpen(t.slug)}>
                    {t.slug}
                  </Link>
                  {t.highlighted ? <span className="sr-only"> (unread)</span> : null}
                  {t.muted ? <span className="cs-tag">muted</span> : null}
                  {t.stalePrompt ? <span className="cs-tag warn">stale?</span> : null}
                </td>
                <td className="c-title" title={t.title}>
                  {t.title}
                  <TaskBadge counts={t.taskCounts} />
                </td>
                <td className="c-note" title={t.statusNote ?? undefined}>
                  {t.statusNote ?? ""}
                </td>
                <td className="c-par">
                  {t.parents.length ? (
                    t.parents.map((p) => <ParentChip key={`${p.kind}:${p.slug}`} parent={p} />)
                  ) : (
                    <span className="cs-dim">unfiled</span>
                  )}
                </td>
                <td className="c-thr">{providerSummary(t)}</td>
                <td className="c-last" title={t.lastWorkedAt}>
                  {ago(t.lastWorkedAt, now, true)}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={HEADERS.length} className="cs-none">
                Nothing here.
              </td>
            </tr>
          )}
        </tbody>
      ))}
    </table>
  );
}
