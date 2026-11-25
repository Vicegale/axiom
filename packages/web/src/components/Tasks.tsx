import { useEffect, useId, useState } from "react";
import type { LinkItem, TaskItem } from "../api";
import { TASK_STATUS_CLASS, TASK_STATUSES, type TaskStatus } from "../lib/domain";
import { layoutGraph, NODE_H, NODE_W } from "../lib/graph";

/** Keys of the dependencies of `task` that are not done yet. */
export function waitingOn(task: TaskItem, all: readonly TaskItem[]): string[] {
  return task.dependsOn.filter((k) => all.find((t) => t.key === k)?.status !== "done");
}

/** A task status as a coloured pill (same look as a topic status). */
export function TaskPill({ status }: { status: TaskStatus }) {
  return <span className={`pill ${TASK_STATUS_CLASS[status]}`}>{status}</span>;
}

/** "5/8" badge for lists; nothing when the topic has no tasks. */
export function TaskBadge({ counts }: { counts: { total: number; done: number } | undefined }) {
  if (!counts || counts.total === 0) return null;
  return (
    <span
      className="task-badge"
      title={`${counts.done} of ${counts.total} tasks done`}
      data-testid="task-badge"
    >
      {counts.done}/{counts.total}
      <span className="sr-only"> tasks done</span>
    </span>
  );
}

interface Group {
  id: number | null;
  heading: string;
  tasks: TaskItem[];
}

function groupBySpec(tasks: readonly TaskItem[], links: readonly LinkItem[]): Group[] {
  const groups: Group[] = [];
  for (const l of links) {
    if (l.kind !== "spec") continue;
    const own = tasks.filter((t) => t.specLinkId === l.id);
    if (own.length) groups.push({ id: l.id, heading: l.label ?? l.target, tasks: own });
  }
  const loose = tasks.filter((t) => !groups.some((g) => g.id === t.specLinkId));
  if (loose.length) groups.push({ id: null, heading: "No spec", tasks: loose });
  return groups;
}

const progress = (tasks: readonly TaskItem[]) =>
  `${tasks.filter((t) => t.status === "done").length}/${tasks.length} done`;

interface TasksProps {
  tasks: readonly TaskItem[];
  links: readonly LinkItem[];
  /** The task picked in the graph: its row is highlighted and scrolled into view. */
  picked: { key: string; n: number } | null;
  onStatus: (key: string, status: TaskStatus) => void;
}

export function TasksSection({ tasks, links, picked, onStatus }: TasksProps) {
  const groups = groupBySpec(tasks, links);
  return (
    <section className="sec" aria-labelledby="h-tasks">
      <div className="sec-h">
        <div className="sec-title">
          <h2 id="h-tasks">Tasks</h2>
          <span className="count">{tasks.length ? progress(tasks) : ""}</span>
        </div>
      </div>
      {tasks.length ? (
        groups.map((g) => (
          <div className="task-group" key={g.id ?? "none"}>
            <h3>
              <span className="tg-name">{g.heading}</span>
              <span className="count">{progress(g.tasks)}</span>
            </h3>
            <ul>
              {g.tasks.map((t) => (
                <TaskRow
                  key={t.key}
                  task={t}
                  all={tasks}
                  picked={picked?.key === t.key ? picked : null}
                  onStatus={onStatus}
                />
              ))}
            </ul>
          </div>
        ))
      ) : (
        <p className="empty-line">No tasks yet. Agents add them with `axiom task add`.</p>
      )}
    </section>
  );
}

function TaskRow({
  task: t,
  all,
  picked,
  onStatus,
}: {
  task: TaskItem;
  all: readonly TaskItem[];
  picked: { key: string; n: number } | null;
  onStatus: (key: string, status: TaskStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const waits = waitingOn(t, all);
  const pickedN = picked?.n;
  useEffect(() => {
    if (pickedN === undefined) return;
    document.getElementById(`task-${t.key}`)?.scrollIntoView?.({ block: "nearest" });
  }, [pickedN, t.key]);
  return (
    <li
      id={`task-${t.key}`}
      className={`task ${TASK_STATUS_CLASS[t.status]}${t.waiting ? " is-waiting" : ""}${picked ? " is-picked" : ""}`}
      data-task-key={t.key}
      title={t.doneWhen ? `Done when: ${t.doneWhen}` : undefined}
    >
      <div className="task-line">
        <span className="task-key">{t.key}</span>
        {t.doneWhen ? (
          <button
            type="button"
            className="task-title as-button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {t.title}
          </button>
        ) : (
          <span className="task-title">{t.title}</span>
        )}
        {t.waiting && waits.length ? (
          <span className="task-waits">waits on {waits.join(", ")}</span>
        ) : null}
        <label className={`pill task-st ${TASK_STATUS_CLASS[t.status]}`}>
          <select
            value={t.status}
            onChange={(e) => onStatus(t.key, e.target.value as TaskStatus)}
            aria-label={`Status of ${t.key}`}
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      {open && t.doneWhen ? (
        <p className="task-done-when">
          <span className="k">Done when</span> {t.doneWhen}
        </p>
      ) : null}
    </li>
  );
}

const MAX_TITLE = 22;
const clip = (s: string) => (s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1)}…` : s);

interface GraphProps {
  tasks: readonly TaskItem[];
  onPick: (key: string) => void;
}

/** The dependency graph: tasks as nodes on the dotted grid, arrows from prerequisite to waiter. */
export function GraphSection({ tasks, onPick }: GraphProps) {
  const [hover, setHover] = useState<string | null>(null);
  const uid = useId().replace(/:/g, "");
  const layout = layoutGraph(tasks);
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const near = new Set<string>();
  if (hover) {
    near.add(hover);
    const h = byKey.get(hover);
    for (const k of [...(h?.dependsOn ?? []), ...(h?.dependents ?? [])]) near.add(k);
  }
  const edgeLit = (from: string, to: string) => hover !== null && (from === hover || to === hover);
  return (
    <section className="sec" aria-labelledby="h-graph">
      <div className="sec-h">
        <div className="sec-title">
          <h2 id="h-graph">Dependency graph</h2>
          <span className="count">{tasks.length ? `${layout.edges.length} links` : ""}</span>
        </div>
        {tasks.length ? (
          <ul className="g-legend" aria-label="Legend">
            {TASK_STATUSES.map((s) => (
              <li key={s} className={TASK_STATUS_CLASS[s]}>
                <i className="sdot" aria-hidden="true" />
                {s}
              </li>
            ))}
            <li className="g-wait">dimmed: waiting</li>
          </ul>
        ) : null}
      </div>
      {tasks.length ? (
        <div className="graph-scroll">
          {/* biome-ignore lint/a11y/useSemanticElements: an SVG cannot be a <fieldset> */}
          <svg
            className="graph"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="group"
            aria-label="Task dependency graph"
          >
            <defs>
              <marker
                id={`${uid}-arrow`}
                className="g-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L10 5 L0 10 z" />
              </marker>
              <marker
                id={`${uid}-arrow-hi`}
                className="g-arrow hi"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L10 5 L0 10 z" />
              </marker>
            </defs>
            {layout.edges.map((e) => {
              const lit = edgeLit(e.from, e.to);
              return (
                <path
                  key={`${e.from}>${e.to}`}
                  className={`g-edge${lit ? " is-lit" : hover ? " is-faded" : ""}`}
                  data-from={e.from}
                  data-to={e.to}
                  d={e.d}
                  markerEnd={`url(#${uid}-arrow${lit ? "-hi" : ""})`}
                />
              );
            })}
            {layout.nodes.map((n) => {
              const t = byKey.get(n.key) as TaskItem;
              const waits = waitingOn(t, tasks);
              const cls = [
                "g-node",
                TASK_STATUS_CLASS[t.status],
                t.waiting ? "is-waiting" : "",
                hover && near.has(n.key) ? "is-lit" : "",
                hover && !near.has(n.key) ? "is-faded" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
                <g
                  key={n.key}
                  className={cls}
                  data-task-key={n.key}
                  transform={`translate(${n.x} ${n.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${t.key}: ${t.title}, ${t.status}${waits.length ? `, waits on ${waits.join(", ")}` : ""}`}
                  onMouseEnter={() => setHover(n.key)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(n.key)}
                  onBlur={() => setHover(null)}
                  onClick={() => onPick(n.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onPick(n.key);
                    }
                  }}
                >
                  <title>{`${t.key}: ${t.title} (${t.status})`}</title>
                  <rect className="g-box" width={NODE_W} height={NODE_H} rx="4" />
                  <rect className="g-bar" width="4" height={NODE_H} rx="1" />
                  <text className="g-key" x="14" y="19">
                    {t.key}
                  </text>
                  <text className="g-title" x="14" y="35">
                    {clip(t.title)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      ) : (
        <p className="empty-line">No tasks yet, so nothing to draw.</p>
      )}
    </section>
  );
}
