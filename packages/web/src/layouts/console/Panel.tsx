import { useEffect, useRef, useState } from "react";
import type { TopicListItem } from "../../api";
import { History, kindClass } from "../../components";
import type { TopicBundle } from "../../data/useTopicDetail";
import type { EntryKind } from "../../lib/domain";
import { ENTRY_KINDS } from "../../lib/domain";
import { tabListKeys } from "../../lib/tabs";
import { type DetailPart, TopicLoader, TopicSlice, useTopicActions } from "../shared/TopicPane";
import { Glyph } from "./Glyph";

export const PANEL_TABS = [
  { id: "history", label: "History", show: [] },
  { id: "threads", label: "Threads", show: ["threads"] },
  { id: "tasks", label: "Tasks", show: ["tasks"] },
  { id: "graph", label: "Graph", show: ["graph"] },
  { id: "links", label: "Links", show: ["links"] },
  { id: "monitors", label: "Monitors", show: ["monitors"] },
  { id: "overview", label: "Overview", show: ["top"] },
] as const satisfies readonly { id: string; label: string; show: readonly DetailPart[] }[];

type TabId = (typeof PANEL_TABS)[number]["id"];

interface Props {
  slug: string | undefined;
  listItem: TopicListItem | undefined;
  now: Date;
}

/** The selected topic in the bottom panel. */
export function Panel({ slug, listItem, now }: Props) {
  const [tab, setTab] = useState<TabId>("history");
  const [hidden, setHidden] = useState<ReadonlySet<EntryKind>>(new Set());
  const last = useRef(slug);
  useEffect(() => {
    if (last.current !== slug) {
      last.current = slug;
      setHidden(new Set());
    }
  }, [slug]);

  const current = PANEL_TABS.find((t) => t.id === tab) ?? PANEL_TABS[0];
  return (
    <section className="cs-panel" aria-label="Selected topic">
      <div className="cs-phead">
        <h2 className="sr-only">{listItem?.title ?? slug ?? "Topic panel"}</h2>
        {listItem ? <Glyph status={listItem.status} /> : null}
        <span className="cs-pslug">{slug ?? "No topic selected"}</span>
        <span className="cs-ptitle">{listItem?.title ?? ""}</span>
        <div
          className="cs-tabs"
          role="tablist"
          aria-label="Topic panels"
          onKeyDown={tabListKeys(
            PANEL_TABS.map((t) => t.id),
            tab,
            setTab,
            "cs-tab",
          )}
        >
          {PANEL_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`cs-tab-${t.id}`}
              className="cs-tab"
              tabIndex={t.id === tab ? 0 : -1}
              aria-selected={t.id === tab}
              aria-controls="cs-pbody"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="cs-pbody" id="cs-pbody" role="tabpanel" aria-labelledby={`cs-tab-${tab}`}>
        {slug ? (
          <TopicLoader slug={slug} emptyClass="cs-empty">
            {(bundle) => (
              <>
                <TopicSlice
                  bundle={bundle}
                  show={current.show}
                  now={now}
                  withHistory={tab !== "history"}
                  onPickTask={() => setTab("tasks")}
                />
                {tab === "history" ? (
                  <ConsoleHistory
                    bundle={bundle}
                    now={now}
                    hidden={hidden}
                    onToggle={(k) =>
                      setHidden((h) => {
                        const next = new Set(h);
                        if (next.has(k)) next.delete(k);
                        else next.add(k);
                        return next;
                      })
                    }
                  />
                ) : null}
              </>
            )}
          </TopicLoader>
        ) : (
          <p className="cs-empty">Select a topic (j / k to move, enter to open).</p>
        )}
      </div>
    </section>
  );
}

function ConsoleHistory({
  bundle,
  now,
  hidden,
  onToggle,
}: {
  bundle: TopicBundle;
  now: Date;
  hidden: ReadonlySet<EntryKind>;
  onToggle: (k: EntryKind) => void;
}) {
  const actions = useTopicActions(bundle.topic.slug);
  const { entries, topic } = bundle;
  const counts = new Map<EntryKind, number>();
  for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const shown = entries.filter((e) => !hidden.has(e.kind));
  return (
    <div className="cs-history">
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the chips */}
      <div className="cs-chips" role="group" aria-label="Filter history by kind">
        {ENTRY_KINDS.filter((k) => counts.has(k)).map((k) => (
          <button
            key={k}
            type="button"
            className={`cs-chip ${kindClass(k)}`}
            aria-pressed={!hidden.has(k)}
            onClick={() => onToggle(k)}
          >
            {k}
            <span className="n">{counts.get(k)}</span>
          </button>
        ))}
      </div>
      {entries.length > 0 && shown.length === 0 ? (
        <p className="cs-empty">All kinds hidden.</p>
      ) : (
        <History
          entries={shown}
          threads={topic.threads}
          density="dense"
          now={now}
          onDelete={actions.onDeleteEntry}
        />
      )}
    </div>
  );
}
