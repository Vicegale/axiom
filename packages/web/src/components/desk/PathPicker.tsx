import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

/** One choice: a T3 project or a folder. `value` is what `onChange` gets (an id or a path). */
export interface PickItem {
  value: string;
  title: string;
  /** The absolute path, shown shortened and in full as the tooltip. */
  path: string;
}

export interface PickGroup {
  id: string;
  label: string;
  items: PickItem[];
}

interface Props {
  /** What the chip is for, e.g. "Project": the start of its accessible name. */
  name: string;
  display: string;
  valueText: string;
  /** The chip's tooltip: the full path when there is one. */
  tooltip?: string;
  value: string;
  groups: PickGroup[];
  onChange: (value: string) => void;
  icon?: ReactNode;
  muted?: boolean;
  disabledReason?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  home: string | null;
  /** A query that looks like a path is offered as "Use <path>". */
  allowPath?: boolean;
  /** An action pinned at the bottom of the list, e.g. "Type a path…". */
  action?: { value: string; label: string };
  /** Called with `action.value` when it is picked. */
  onAction?: () => void;
}

const WIDTH = 480;
const MIN_WIDTH = 384;
const MAX_HEIGHT = 352;
const EDGE = 8;
export const MAX_PATH = 36;

/** `/home/u/x` as `~/x`, and a long path as `~/Documents/notes/…/GPTCommandCenter`. */
export function shortPath(path: string, home: string | null, max = MAX_PATH): string {
  let p = path;
  if (home && (p === home || p.startsWith(`${home}/`))) p = `~${p.slice(home.length)}`;
  if (p.length <= max) return p;
  const parts = p.split("/");
  if (parts.length <= 4) return p;
  const head = parts.slice(0, 3).join("/");
  return `${head}/…/${parts[parts.length - 1]}`;
}

/** The home directory, from a workspace label (`~/x` of `/home/u/x`) or a `/home/u` style path. */
export function detectHome(
  workspaces: { path: string; label: string }[],
  paths: string[] = [],
): string | null {
  for (const w of workspaces) {
    if (w.label.startsWith("~/") && w.path.endsWith(w.label.slice(1)))
      return w.path.slice(0, w.path.length - w.label.length + 1);
  }
  for (const p of [...workspaces.map((w) => w.path), ...paths]) {
    const m = /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(\/|$)/.exec(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

const trimSlash = (p: string) => p.trim().replace(/(.)\/+$/, "$1");
const lastSegment = (p: string) => trimSlash(p).split("/").filter(Boolean).pop() ?? p;
const byTitle = (a: PickItem, b: PickItem) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

interface ProjectLike {
  id: string;
  title: string;
  workspaceRoot: string;
  pinned: boolean;
}
interface WorkspaceLike {
  path: string;
  label: string;
  source: "axiom" | "projects";
}

/** Recent (folders Axiom topics use, newest first), Pinned, then the rest: each project once. */
export function projectGroups(projects: ProjectLike[], workspaces: WorkspaceLike[]): PickGroup[] {
  const item = (p: ProjectLike): PickItem => ({
    value: p.id,
    title: p.title,
    path: p.workspaceRoot,
  });
  const used = new Set<string>();
  const take = (list: ProjectLike[]) => {
    const out = list.filter((p) => !used.has(p.id));
    for (const p of out) used.add(p.id);
    return out.map(item);
  };
  const recent: ProjectLike[] = [];
  for (const w of workspaces) {
    if (w.source !== "axiom") continue;
    const p = projects.find((x) => trimSlash(x.workspaceRoot) === trimSlash(w.path));
    if (p && !recent.includes(p)) recent.push(p);
  }
  const groups: PickGroup[] = [
    { id: "recent", label: "Recent", items: take(recent) },
    { id: "pinned", label: "Pinned", items: take(projects.filter((p) => p.pinned)).sort(byTitle) },
    { id: "all", label: "All projects", items: take(projects).sort(byTitle) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** Recent, T3 projects, ~/projects: each folder once; the title is the project or the last segment. */
export function folderGroups(
  projects: ProjectLike[] | null,
  workspaces: WorkspaceLike[],
): PickGroup[] {
  const used = new Set<string>();
  const title = (path: string) =>
    projects?.find((p) => trimSlash(p.workspaceRoot) === trimSlash(path))?.title ??
    lastSegment(path);
  const take = (paths: string[]): PickItem[] => {
    const out: PickItem[] = [];
    for (const path of paths) {
      if (used.has(path)) continue;
      used.add(path);
      out.push({ value: path, title: title(path), path });
    }
    return out;
  };
  const groups: PickGroup[] = [
    {
      id: "recent",
      label: "Recent",
      items: take(workspaces.filter((w) => w.source === "axiom").map((w) => w.path)),
    },
    {
      id: "t3",
      label: "T3 projects",
      items: take((projects ?? []).map((p) => p.workspaceRoot)).sort(byTitle),
    },
    {
      id: "projects",
      label: "~/projects",
      items: take(workspaces.filter((w) => w.source === "projects").map((w) => w.path)).sort(
        byTitle,
      ),
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

const looksLikePath = (q: string) => /^(~|\.{0,2}\/)/.test(q.trim());

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="pp-mark">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

interface Row {
  key: string;
  value: string;
  title: string;
  path: string;
  kind: "item" | "use" | "action";
}

/**
 * The Project / Folder chip: a pill that opens a searchable list in the top layer (native popover).
 * A combobox: the search field keeps focus, arrow keys move through the options, Enter picks,
 * Escape clears the query and then closes.
 */
export function PathPicker({
  name,
  display,
  valueText,
  tooltip,
  value,
  groups,
  onChange,
  icon,
  muted,
  disabledReason,
  buttonRef,
  home,
  allowPath,
  action,
  onAction,
}: Props) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const q = query.trim().toLowerCase();

  const view = useMemo(() => {
    const shown = groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (i) => !q || i.title.toLowerCase().includes(q) || i.path.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length > 0);
    const rows: Row[] = [];
    if (allowPath && looksLikePath(query)) {
      const p = query.trim();
      rows.push({ key: "use", value: p, title: `Use ${p}`, path: "", kind: "use" });
    }
    const byGroup = new Map<string, Row[]>();
    for (const g of shown) {
      const list = g.items.map((i): Row => ({ key: `${g.id}:${i.value}`, ...i, kind: "item" }));
      byGroup.set(g.id, list);
      rows.push(...list);
    }
    const actionRow: Row | null = action
      ? { key: "action", value: action.value, title: action.label, path: "", kind: "action" }
      : null;
    if (actionRow) rows.push(actionRow);
    return { shown, rows, byGroup, actionRow };
  }, [groups, q, query, allowPath, action]);

  const optionId = (r: Row) => `${id}-o-${r.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const rowAt = Math.min(active, view.rows.length - 1);
  const activeRow = view.rows[rowAt];
  const hasMatches = view.rows.some((r) => r.kind === "item" || r.kind === "use");

  function place() {
    const el = menu.current;
    const anchor = button.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const width = Math.min(Math.max(WIDTH, MIN_WIDTH), window.innerWidth - 2 * EDGE);
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE));
    const below = window.innerHeight - r.bottom - EDGE - 4;
    const above = r.top - EDGE - 4;
    const flip = below < MAX_HEIGHT && above > below;
    const room = flip ? above : below;
    el.style.left = `${left}px`;
    el.style.width = `${width}px`;
    el.style.maxHeight = `${Math.max(160, Math.min(MAX_HEIGHT, room))}px`;
    el.dataset.side = flip ? "up" : "down";
    if (flip) {
      el.style.top = "auto";
      el.style.bottom = `${window.innerHeight - r.top + 4}px`;
    } else {
      el.style.bottom = "auto";
      el.style.top = `${r.bottom + 4}px`;
    }
  }

  function onToggle(e: { nativeEvent: Event }) {
    if ((e.nativeEvent as Event & { newState?: string }).newState === "open") {
      place();
      setQuery("");
      const first = groups.flatMap((g) => g.items).findIndex((i) => i.value === value);
      setActive(Math.max(0, first));
      input.current?.focus();
      requestAnimationFrame(() => scrollToActive());
    } else {
      const el = document.activeElement;
      if (!el || el === document.body || menu.current?.contains(el)) button.current?.focus();
    }
  }

  function scrollToActive() {
    menu.current?.querySelector("[data-active='true']")?.scrollIntoView?.({ block: "nearest" });
  }

  function move(next: number) {
    setActive(next);
    requestAnimationFrame(() => scrollToActive());
  }

  function choose(r: Row | undefined) {
    if (!r) return;
    menu.current?.hidePopover?.();
    if (r.kind === "action") onAction?.();
    else onChange(r.value);
  }

  function onKeyDown(e: KeyboardEvent) {
    const n = view.rows.length;
    if (e.key === "Escape") {
      // Ours: the browser would close the popover, the composer would collapse.
      e.stopPropagation();
      e.preventDefault();
      if (query) {
        setQuery("");
        setActive(0);
      } else menu.current?.hidePopover?.();
      return;
    }
    if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      move((rowAt + 1) % n);
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      move(rowAt <= 0 ? n - 1 : rowAt - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      choose(activeRow);
    }
  }

  const disabled = disabledReason !== undefined;
  const label = `${name}: ${valueText}`;
  const reasonId = `${id}-why`;
  const renderRow = (r: Row) => {
    const index = view.rows.indexOf(r);
    const isActive = index === rowAt;
    const selected = r.kind === "item" && r.value === value;
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the search field owns the keyboard (aria-activedescendant)
      <div
        key={r.key}
        id={optionId(r)}
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        data-active={isActive || undefined}
        data-kind={r.kind}
        className="pp-row"
        title={r.path || undefined}
        onMouseMove={() => !isActive && setActive(index)}
        onClick={() => choose(r)}
      >
        <svg
          className="rc-tick"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m2.5 6.2 2.2 2.2 4.8-5" />
        </svg>
        <span className="pp-title">
          {r.kind === "item" ? <Highlight text={r.title} query={query} /> : r.title}
        </span>
        {r.path ? <span className="pp-path">{shortPath(r.path, home)}</span> : null}
      </div>
    );
  };

  return (
    <>
      <button
        type="button"
        ref={(el) => {
          button.current = el;
          if (typeof buttonRef === "function") buttonRef(el);
          else if (buttonRef) buttonRef.current = el;
        }}
        className={`rc-chip${muted ? " muted" : ""}`}
        popoverTarget={disabled ? undefined : id}
        aria-haspopup="listbox"
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? reasonId : undefined}
        title={disabled ? disabledReason : (tooltip ?? label)}
      >
        {icon}
        <span className="rc-chip-text">{display}</span>
        <svg
          className="rc-chev"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m2.5 3.75 2.5 2.5 2.5-2.5" />
        </svg>
      </button>
      {disabled ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : (
        <div
          id={id}
          ref={menu}
          popover="auto"
          className="rc-menu pp-menu"
          role="dialog"
          aria-label={name}
          onToggle={onToggle}
          onKeyDown={onKeyDown}
        >
          <div className="pp-search">
            <svg
              width="13"
              height="13"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="6" cy="6" r="3.8" />
              <path d="m9 9 3 3" />
            </svg>
            <input
              ref={input}
              type="text"
              role="combobox"
              className="pp-input"
              aria-label={`Search ${name.toLowerCase()}s`}
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-activedescendant={activeRow ? optionId(activeRow) : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
              placeholder={allowPath ? "Search or type a path" : "Search by name or path"}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
            />
          </div>
          <div id={`${id}-list`} role="listbox" aria-label={name} className="pp-list">
            {view.rows[0]?.kind === "use" ? renderRow(view.rows[0]) : null}
            {view.shown.map((g) => (
              // biome-ignore lint/a11y/useSemanticElements: a fieldset inside a listbox is not valid
              <div key={g.id} role="group" aria-labelledby={`${id}-g-${g.id}`}>
                <div id={`${id}-g-${g.id}`} className="pp-heading">
                  {g.label}
                </div>
                {view.byGroup.get(g.id)?.map(renderRow)}
              </div>
            ))}
            {!hasMatches ? (
              <p className="pp-empty" aria-hidden="true">
                No matches
              </p>
            ) : null}
            {view.actionRow ? renderRow(view.actionRow) : null}
          </div>
          <span className="sr-only" role="status">
            {hasMatches ? "" : "No matches"}
          </span>
        </div>
      )}
    </>
  );
}
