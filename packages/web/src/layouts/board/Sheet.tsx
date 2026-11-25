import { useEffect, useRef, useState } from "react";
import type { TopicListItem } from "../../api";
import { StatusPill } from "../../components";
import { spineStatus } from "../../lib/topics";
import { type DetailPart, TopicLoader, TopicSlice } from "../shared/TopicPane";

export const SHEET_TABS = [
  { id: "overview", label: "Overview", show: ["top", "monitors"] },
  { id: "history", label: "History", show: ["history"] },
  { id: "threads", label: "Threads", show: ["threads"] },
  { id: "tasks", label: "Tasks", show: ["tasks"] },
  { id: "graph", label: "Graph", show: ["graph"] },
  { id: "links", label: "Links", show: ["links"] },
] as const satisfies readonly { id: string; label: string; show: readonly DetailPart[] }[];

type TabId = (typeof SHEET_TABS)[number]["id"];

interface Props {
  slug: string;
  /** From the list, so the header is there before the detail loads. */
  listItem: TopicListItem | undefined;
  now: Date;
  onClose: () => void;
}

/** The topic sheet that slides over the board from the right. */
export function Sheet({ slug, listItem, now, onClose }: Props) {
  const [tab, setTab] = useState<TabId>("overview");
  const ref = useRef<HTMLElement>(null);

  // A different topic starts on Overview, focus moves into the sheet, Escape closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `slug` is the trigger.
  useEffect(() => {
    setTab("overview");
    ref.current?.focus();
  }, [slug]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const status = listItem ? spineStatus(listItem) : "idle";
  const current = SHEET_TABS.find((t) => t.id === tab) ?? SHEET_TABS[0];
  return (
    <>
      <button type="button" className="bd-scrim" aria-label="Close topic" onClick={onClose} />
      <aside
        ref={ref}
        className={`bd-sheet s-${status}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bd-sheet-title"
        tabIndex={-1}
      >
        <header className="bd-sheet-head">
          <div className="bd-sh-row">
            <StatusPill status={listItem?.status} />
            <span className="slug">{slug}</span>
            <button type="button" className="bd-x" aria-label="Close topic" onClick={onClose}>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            </button>
          </div>
          <h2 id="bd-sheet-title">{listItem?.title ?? slug}</h2>
          <div className="bd-tabs" role="tablist" aria-label="Topic sections">
            {SHEET_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`bd-tab-${t.id}`}
                aria-selected={t.id === tab}
                aria-controls="bd-sheet-panel"
                className="bd-tab"
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === "threads" && listItem ? (
                  <span className="bd-tab-n">{listItem.threads.length}</span>
                ) : null}
              </button>
            ))}
          </div>
        </header>
        <div
          className="bd-sheet-body"
          id="bd-sheet-panel"
          role="tabpanel"
          aria-labelledby={`bd-tab-${tab}`}
        >
          <TopicLoader slug={slug} emptyClass="bd-empty">
            {(bundle) => (
              <TopicSlice
                bundle={bundle}
                show={current.show}
                now={now}
                onPickTask={() => setTab("tasks")}
              />
            )}
          </TopicLoader>
        </div>
      </aside>
    </>
  );
}
