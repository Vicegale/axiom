import { useState } from "react";
import type { Entry, Thread } from "../api";
import type { TaskStatus } from "../lib/domain";
import { dayKey, dayLabel, hm } from "../lib/time";
import { KindLabel, kindClass } from "./KindLabel";
import { Modal } from "./Modal";
import { StatusPill } from "./StatusPill";
import { TaskPill } from "./Tasks";

export type Density = "dense" | "roomy";

interface Props {
  /** Any order; shown newest first. */
  entries: readonly Entry[];
  threads?: readonly Thread[];
  density?: Density;
  now?: Date;
  /** Owner-only delete (for leaked secrets). Omit to hide the control. */
  onDelete?: (id: number) => void;
}

interface Data {
  result?: string;
  from?: string | null;
  to?: string | null;
  reason?: string;
  why?: string;
  scope?: string;
  standing?: boolean;
  evidence?: string[];
  /** Set on a task status change (key). */
  task?: string;
}

function newestFirst(a: Entry, b: Entry): number {
  return a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id;
}

/** History grouped by day. One component, two densities, for every layout. */
export function History({ entries, threads = [], density = "roomy", now, onDelete }: Props) {
  const at = now ?? new Date();
  if (entries.length === 0) return <p className="empty-line">No history yet.</p>;
  const groups: { key: string; label: string; items: Entry[] }[] = [];
  for (const e of [...entries].sort(newestFirst)) {
    const key = dayKey(e.at);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, label: dayLabel(e.at, at), items: [] };
      groups.push(g);
    }
    g.items.push(e);
  }
  return (
    <>
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label}>
          <h3 className="day">{g.label}</h3>
          <ol className={`hist ${density}`}>
            {g.items.map((e) => (
              <EntryItem key={e.id} entry={e} threads={threads} onDelete={onDelete} />
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}

function EntryItem({
  entry: e,
  threads,
  onDelete,
}: {
  entry: Entry;
  threads: readonly Thread[];
  onDelete?: (id: number) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const d = (e.data ?? {}) as Data;
  const thread = e.threadId === null ? undefined : threads.find((t) => t.id === e.threadId);
  const threadName = thread ? (thread.title ?? thread.providerThreadId) : null;
  return (
    <li className={`entry ${kindClass(e.kind)}`} data-entry-id={e.id}>
      <div className="e-meta">
        <KindLabel author={e.author} kind={e.kind} />
        {e.kind === "verification" && d.result ? (
          <span className={`badge r-${d.result}`}>{d.result}</span>
        ) : null}
        <time dateTime={e.at}>{hm(e.at)}</time>
        {threadName ? <span className="e-thread">{threadName}</span> : null}
        {onDelete ? (
          <>
            <button
              type="button"
              className="e-del"
              title="Delete this entry (for example a leaked secret)"
              aria-label={`Delete entry ${e.id}`}
              onClick={() => setConfirming(true)}
            >
              Delete
            </button>
            {confirming ? (
              <Modal
                role="alertdialog"
                className="confirm"
                labelledBy={`confirm-${e.id}`}
                onClose={() => setConfirming(false)}
              >
                <div className="confirm-body">
                  <p id={`confirm-${e.id}`}>Delete this entry for good?</p>
                  <div className="confirm-actions">
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn danger sm"
                      onClick={() => {
                        setConfirming(false);
                        onDelete(e.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </Modal>
            ) : null}
          </>
        ) : null}
      </div>
      {e.kind === "status change" && typeof d.task === "string" ? (
        <p className="e-body">
          Task <b className="mono">{d.task}</b>{" "}
          <span className="status-move">
            <TaskPill status={d.from as TaskStatus} />
            <span className="arrow" aria-hidden="true">
              →
            </span>
            <TaskPill status={d.to as TaskStatus} />
          </span>
        </p>
      ) : e.kind === "status change" ? (
        <p className="e-body">
          <span className="status-move">
            <StatusPill status={(d.from as never) ?? null} />
            <span className="arrow" aria-hidden="true">
              →
            </span>
            <StatusPill status={(d.to as never) ?? null} />
          </span>
        </p>
      ) : e.body ? (
        <p className="e-body">{e.body}</p>
      ) : null}
      {d.reason ? <p className="e-data">{d.reason}</p> : null}
      {d.why ? (
        <p className="e-data">
          <span className="k">Why</span> {d.why}
        </p>
      ) : null}
      {d.scope ? (
        <p className="e-data">
          <span className="k">Scope</span> {d.scope}
          {typeof d.standing === "boolean" ? (
            <>
              {" "}
              <span className="badge">{d.standing ? "standing" : "one-off"}</span>
            </>
          ) : null}
        </p>
      ) : null}
      {d.evidence?.length ? (
        <p className="e-data">
          <span className="k">Evidence</span> {d.evidence.join(", ")}
        </p>
      ) : null}
      {e.refs.length ? (
        <ul className="refs">
          {e.refs.map((r) => (
            <li key={`${r.type}:${r.value}`} title={r.type}>
              {r.value}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
