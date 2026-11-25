import type { TopicListItem } from "../../api";
import { dateShort, hm } from "../../lib/time";
import { inView } from "../../lib/topics";

export function StatusBar({
  topics,
  live,
  now,
}: {
  topics: readonly TopicListItem[];
  live: boolean;
  now: Date;
}) {
  const need = topics.filter((t) => inView(t, "attention")).length;
  const running = topics.filter((t) => inView(t, "ongoing")).length;
  const unread = topics.filter((t) => t.highlighted).length;
  const iso = now.toISOString();
  return (
    <footer className="status">
      <span className="sb">
        <i className="sdot s-hitl" aria-hidden="true" />
        {need} need you
      </span>
      <span className="sb">
        <i className="sdot s-wip" aria-hidden="true" />
        {running} running
      </span>
      <span className="sb">{unread} unread</span>
      <span className="sb sb-live" data-state={live ? "on" : "off"}>
        <i className="sdot" aria-hidden="true" />
        {live ? "live" : "offline"}
      </span>
      <span className="sb sb-end">
        Now {dateShort(iso)} {hm(iso)}
      </span>
      <span className="sb sb-keys">
        <kbd>↑</kbd> <kbd>↓</kbd> move between topics
      </span>
      <span className="sb sb-keys">
        <kbd>[</kbd> sidebar
      </span>
    </footer>
  );
}
