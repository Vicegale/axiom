import { api } from "../../api";
import { useAxiom } from "../../data/DataProvider";
import { useActions } from "../../data/useActions";
import { useResource } from "../../data/useResource";
import { hm } from "../../lib/time";
import { Facet } from "../Icons";
import "../../styles/steward.css";

/**
 * Steward's on/off switch with the next wake ("next 14:30") or "running": in the top bar of the
 * Steward page and of the Desk. Off stops new wakes; a wake already running finishes.
 */
export function StewardToggle() {
  const { tick, settings } = useAxiom();
  const actions = useActions();
  const view = useResource("steward", api.steward, tick).data;
  const st = settings?.steward;
  const on = view?.enabled ?? st?.enabled ?? false;
  const next = view?.nextWakeAt ? hm(view.nextWakeAt) : null;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`st-toggle${on ? " on" : ""}`}
      disabled={!st}
      onClick={() => {
        if (st) void actions.saveSettings({ steward: { ...st, enabled: !on } });
      }}
    >
      <span className="st-sw" aria-hidden="true" />
      <span className="st-ic">
        <Facet size={14} />
      </span>
      <span>Steward {on ? "on" : "off"}</span>
      {on && view?.running ? <span className="st-meta">running</span> : null}
      {on && !view?.running && next ? <span className="st-meta">next {next}</span> : null}
    </button>
  );
}
