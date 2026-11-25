import { useEffect, useState } from "react";
import type { TopicListItem } from "../../api";
import { Modal, Splitter, StatusPill } from "../../components";
import { usePaneSize } from "../../lib/panes";
import { tabListKeys } from "../../lib/tabs";
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

/**
 * The topic sheet that slides over the board from the right: a native modal `<dialog>`, so focus
 * is trapped, the board behind is inert, Escape closes it and focus returns to the card that
 * opened it. Its width is resizable.
 */
export function Sheet({ slug, listItem, now, onClose }: Props) {
  const [tab, setTab] = useState<TabId>("overview");
  const width = usePaneSize("board-sheet", {
    default: () => Math.round(window.innerWidth * 0.62),
    min: 420,
    max: () => Math.max(420, window.innerWidth - 120),
  });

  // A different topic starts on Overview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `slug` is the trigger.
  useEffect(() => setTab("overview"), [slug]);

  const status = listItem ? spineStatus(listItem) : "idle";
  const current = SHEET_TABS.find((t) => t.id === tab) ?? SHEET_TABS[0];
  return (
    <Modal className={`bd-sheet s-${status}`} labelledBy="bd-sheet-title" onClose={onClose}>
      <Splitter pane={width} axis="col" after edge="start" label="Resize topic sheet" />
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
        <div
          className="bd-tabs"
          role="tablist"
          aria-label="Topic sections"
          onKeyDown={tabListKeys(
            SHEET_TABS.map((t) => t.id),
            tab,
            setTab,
            "bd-tab",
          )}
        >
          {SHEET_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`bd-tab-${t.id}`}
              aria-selected={t.id === tab}
              tabIndex={t.id === tab ? 0 : -1}
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
    </Modal>
  );
}
