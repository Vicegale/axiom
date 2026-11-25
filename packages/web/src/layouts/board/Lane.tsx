import { useState } from "react";
import type { TopicListItem } from "../../api";
import { STATUS_MEANING, VIEW_DOT, VIEW_LABEL, VIEW_STATUSES, type ViewId } from "../../lib/domain";
import { Card } from "./Card";

export type Zone = "wide" | "pile" | "done";

export interface LaneProps {
  view: ViewId;
  zone: Zone;
  topics: readonly TopicListItem[];
  now: Date;
  focused: boolean;
  onOpen: (slug: string) => void;
  onMarkStale: (slug: string) => void;
  onDismissStale: (slug: string) => void;
}

export function Lane({ view, zone, topics, focused, ...card }: LaneProps) {
  const [doneOpen, setDoneOpen] = useState(false);
  const cards = topics.map((t) => <Card key={t.slug} topic={t} lane={view} {...card} />);

  if (zone === "done") {
    return (
      <section
        className={`bd-lane bd-lane--done ${VIEW_DOT[view]}${doneOpen ? " is-open" : ""}`}
        data-view={view}
        aria-label="Done topics"
      >
        <button
          type="button"
          className="bd-done-btn"
          aria-expanded={doneOpen}
          aria-controls="bd-done-body"
          onClick={() => setDoneOpen((o) => !o)}
        >
          <span className="bd-count">{topics.length}</span>
          <span className="bd-done-name">Done</span>
        </button>
        <div className="bd-lane-body" id="bd-done-body" hidden={!doneOpen}>
          {cards.length ? cards : <p className="bd-empty">None.</p>}
        </div>
      </section>
    );
  }

  const sub =
    zone === "pile"
      ? (VIEW_STATUSES[view].map((s) => STATUS_MEANING[s])[0] ?? "")
      : VIEW_STATUSES[view].join(", ");
  return (
    <section
      className={`bd-lane bd-lane--${zone} ${VIEW_DOT[view]}${focused ? " is-focused" : ""}`}
      data-view={view}
      aria-labelledby={`bd-h-${view}`}
    >
      <header className="bd-lane-head">
        <div className="bd-lane-title">
          <h2 id={`bd-h-${view}`}>{VIEW_LABEL[view]}</h2>
          <span className="bd-count">{topics.length}</span>
        </div>
        <p className="bd-lane-sub">{sub}</p>
      </header>
      <div className="bd-lane-body">
        {cards.length ? cards : <p className="bd-empty">Nothing here.</p>}
      </div>
    </section>
  );
}
