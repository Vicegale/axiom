import { tokens } from "../../lib/steward";

/** The core's size against its budget, in tokens (about four characters each). */
export function MemoryMeter({ used, cap }: { used: number; cap: number }) {
  const pct = Math.min(100, Math.round((used / cap) * 100));
  const over = used > cap;
  return (
    <div className="st-core-meter">
      <span
        className={`st-meter${over ? " over" : ""}`}
        role="progressbar"
        aria-label="Memory core size"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(used, cap)}
        aria-valuetext={`about ${tokens(used)} of ${tokens(cap)} tokens${over ? ", over the budget" : ""}`}
      >
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="st-meta st-num">
        {tokens(used)} / {tokens(cap)}
        {over ? <span className="sr-only"> (over the budget)</span> : null}
      </span>
    </div>
  );
}
