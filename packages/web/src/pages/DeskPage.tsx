import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "wouter";
import { api, type DeskTopic, type Health } from "../api";
import { SkipLink } from "../components";
import { DeskCard } from "../components/desk/DeskCard";
import { NewTopicDialog } from "../components/desk/NewTopicDialog";
import { PageSwitch } from "../components/PageSwitch";
import { StewardToggle } from "../components/steward/StewardToggle";
import { useResource } from "../data/useResource";
import { hrefs } from "../layouts/shared/routes";
import { useShell } from "../layouts/shared/useShell";
import { type DeskSort, moveTo, PER_ROWS, type PerRow, sortDesk } from "../lib/desk";
import { readStored, writeStored } from "../lib/storage";
import { effectiveTheme } from "../lib/theme";
import "../styles/desk.css";

const SORT_KEY = "axiom.desk.sort";
const PER_ROW_KEY = "axiom.desk.perRow";

function storedSort(): DeskSort {
  return readStored(SORT_KEY) === "fixed" ? "fixed" : "ready";
}

function storedPerRow(): PerRow {
  const v = readStored(PER_ROW_KEY);
  return PER_ROWS.find((p) => String(p) === v) ?? 3;
}

/** "T3 ready" style: one dot and a word per provider. */
function providerHealth(
  h: Health | undefined,
): { name: string; state: "ok" | "warn"; text: string }[] {
  if (!h) return [];
  const t3 = h.t3.state;
  return [
    {
      name: "T3",
      state: t3 === "ok" ? "ok" : "warn",
      text: t3 === "ok" ? "T3 ready" : t3 === "untested-version" ? "T3 untested" : "T3 unavailable",
    },
    {
      name: "Claude Code",
      state: h.claudeCode.lastEventAt ? "ok" : "warn",
      text: h.claudeCode.lastEventAt ? "Claude Code ready" : "Claude Code silent",
    },
  ];
}

interface Drag {
  slug: string;
  /** The order being previewed. */
  order: string[];
  /** The order the drag started from; nothing is saved when they match. */
  base: string[];
  by: "pointer" | "key";
}

function Seg<T extends string | number>({
  label,
  value,
  options,
  show,
  onPick,
  className,
}: {
  label: string;
  value: T;
  options: readonly T[];
  show: (v: T) => string;
  onPick: (v: T) => void;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the segmented control
    <div className={`seg ${className ?? ""}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o)} type="button" aria-pressed={o === value} onClick={() => onPick(o)}>
          {show(o)}
        </button>
      ))}
    </div>
  );
}

/** The topics hidden from the Desk, with a way back. */
function HiddenMenu({
  hidden,
  onUnhide,
}: {
  hidden: DeskTopic[];
  onUnhide: (slug: string) => void;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  function onToggle(e: { nativeEvent: Event }) {
    const el = menu.current;
    const anchor = button.current;
    if ((e.nativeEvent as Event & { newState?: string }).newState === "open") {
      if (!el || !anchor) return;
      const r = anchor.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 16);
      el.style.width = `${width}px`;
      el.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
      el.style.top = `${r.bottom + 4}px`;
    } else if (!document.activeElement || document.activeElement === document.body) {
      anchor?.focus();
    }
  }

  return (
    <>
      <button
        type="button"
        ref={button}
        className="btn ghost dk-hidden-btn"
        popoverTarget={id}
        disabled={hidden.length === 0}
        title="Topics hidden from the Desk"
      >
        {hidden.length} hidden
      </button>
      <div
        id={id}
        ref={menu}
        popover="auto"
        className="dk-pop"
        role="dialog"
        aria-label="Hidden topics"
        onToggle={onToggle}
      >
        <p className="dk-label">Hidden from the Desk</p>
        <ul>
          {hidden.map((t) => (
            <li key={t.slug}>
              <span>{t.title}</span>
              <button
                type="button"
                className="btn ghost"
                aria-label={`Unhide ${t.title}`}
                onClick={() => onUnhide(t.slug)}
              >
                Unhide
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export function DeskPage() {
  const { data, actions, now, notifications } = useShell();
  const desk = useResource("desk", api.desk, data.tick);
  const [sort, setSortState] = useState<DeskSort>(storedSort);
  const [perRow, setPerRowState] = useState<PerRow>(storedPerRow);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  /** The order just saved, shown until the refetch carries it. */
  const [pending, setPending] = useState<string[] | null>(null);
  const settled = useRef(false);
  const [said, setSaid] = useState("");
  const main = useRef<HTMLElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState(false);
  /** The slug of a topic just created, until its card has been shown. */
  const [fresh, setFresh] = useState<string | null>(null);
  const theme = effectiveTheme(data.settings?.theme);

  const setSort = (s: DeskSort) => {
    setSortState(s);
    writeStored(SORT_KEY, s);
  };
  const setPerRow = (p: PerRow) => {
    setPerRowState(p);
    writeStored(PER_ROW_KEY, String(p));
  };

  const all = desk.data?.topics;
  const visible = useMemo(() => (all ?? []).filter((t) => !t.deskHidden), [all]);
  const hidden = useMemo(() => (all ?? []).filter((t) => t.deskHidden), [all]);
  const computed = useMemo(() => sortDesk(visible, sort).map((t) => t.slug), [visible, sort]);

  // A refetch after saving carries the new order: stop showing the local copy.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when fresh data arrives.
  useEffect(() => {
    if (settled.current) {
      settled.current = false;
      setPending(null);
    }
  }, [all]);

  const bySlug = useMemo(() => new Map(visible.map((t) => [t.slug, t])), [visible]);
  const shownOrder = useMemo(() => {
    const base = drag?.order ?? (sort === "fixed" ? pending : null) ?? computed;
    return base.filter((s) => bySlug.has(s));
  }, [drag, pending, sort, computed, bySlug]);
  const shown = shownOrder.map((s) => bySlug.get(s)).filter((t): t is DeskTopic => !!t);
  const active = visible.filter((t) => t.status !== "done" && t.status !== "stale").length;

  const startDrag = useCallback(
    (slug: string, by: Drag["by"]) => {
      const base = shownOrder;
      const d: Drag = { slug, order: base, base, by };
      dragRef.current = d;
      setDrag(d);
      return d;
    },
    [shownOrder],
  );

  const preview = useCallback(
    (d: Drag, index: number) => {
      const order = moveTo(d.order, d.slug, index);
      if (order.join("\n") === d.order.join("\n")) return;
      const next = { ...d, order };
      dragRef.current = next;
      setDrag(next);
      const t = bySlug.get(d.slug);
      setSaid(
        `Moved ${t?.title ?? d.slug} to position ${order.indexOf(d.slug) + 1} of ${order.length}`,
      );
    },
    [bySlug],
  );

  const commit = useCallback(async () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d || d.order.join("\n") === d.base.join("\n")) return;
    // Dragging from Ready first starts the owner's own order.
    setSortState("fixed");
    writeStored(SORT_KEY, "fixed");
    setPending(d.order);
    const ok = await actions.setDeskOrder(d.order);
    if (ok) settled.current = true;
    else setPending(null);
  }, [actions]);

  const cancel = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
  }, []);

  // Pointer drag: the card under the pointer takes the dragged card's place.
  const onPointerDown = (slug: string) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    startDrag(slug, "pointer");
    const onMove = (ev: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (d?.by !== "pointer") return;
      const cards = [...(main.current?.querySelectorAll<HTMLElement>("[data-slug]") ?? [])];
      const over = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return (
          ev.clientX >= r.left &&
          ev.clientX <= r.right &&
          ev.clientY >= r.top &&
          ev.clientY <= r.bottom
        );
      });
      const target = over?.dataset.slug;
      if (target && target !== d.slug) preview(d, d.order.indexOf(target));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      void commit();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // Keyboard: arrows move the card, Enter drops it, Escape puts it back.
  const onKeyDown = (slug: string) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const step =
      e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? -1
        : e.key === "ArrowRight" || e.key === "ArrowDown"
          ? 1
          : 0;
    if (step) {
      e.preventDefault();
      const d = dragRef.current?.slug === slug ? dragRef.current : startDrag(slug, "key");
      preview(d, d.order.indexOf(slug) + step);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (dragRef.current?.slug === slug) void commit();
    } else if (e.key === "Escape" && dragRef.current?.slug === slug) {
      e.preventDefault();
      cancel();
      setSaid("Move cancelled");
    }
  };
  // Leaving the handle puts the card back. Reordering can blur it for a moment (the element
  // moves, then the effect below refocuses it), so look again after a beat.
  const onBlur = (slug: string) => () => {
    if (dragRef.current?.by !== "key") return;
    setTimeout(() => {
      const on = document.activeElement?.closest("[data-slug]")?.getAttribute("data-slug");
      if (dragRef.current?.by === "key" && dragRef.current.slug === slug && on !== slug) cancel();
    }, 150);
  };

  // React moves the card's element when the order changes, which drops focus: put it back.
  const movingSlug = drag?.by === "key" ? drag.slug : null;
  const movingAt = drag?.order.indexOf(drag.slug);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus after each step.
  useEffect(() => {
    if (!movingSlug) return;
    const btn = main.current?.querySelector<HTMLElement>(
      `[data-slug="${CSS.escape(movingSlug)}"] .dk-move`,
    );
    if (btn && document.activeElement !== btn) btn.focus();
  }, [movingSlug, movingAt]);

  const health = providerHealth(data.health);

  // `n` opens the New topic dialog unless the owner is typing or another dialog is open.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "n" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) {
        return;
      }
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      ) {
        return;
      }
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      setCreating(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus goes back to the button when the dialog closes (also after the `n` key).
  const wasCreating = useRef(false);
  useEffect(() => {
    if (wasCreating.current && !creating) newButton.current?.focus();
    wasCreating.current = creating;
  }, [creating]);

  // The topic just created: scroll its card into view and flash it once it has arrived.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the cards change.
  useEffect(() => {
    if (!fresh) return;
    const el = main.current?.querySelector<HTMLElement>(`[data-slug="${CSS.escape(fresh)}"]`);
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
    el.classList.add("nt-flash");
    setTimeout(() => el.classList.remove("nt-flash"), 2400);
    setFresh(null);
  }, [fresh, shown]);

  return (
    <div className={`dk-app${data.error ? " has-banner" : ""}`} data-per-row={String(perRow)}>
      <SkipLink />
      <header className="dk-bar">
        <div className="dk-bar-start">
          <span className="brand-mark" aria-hidden="true" />
          <h1>Desk</h1>
          <PageSwitch />
          <span className="dk-count">{active} active</span>
        </div>
        <div className="dk-bar-end">
          <Link
            href={hrefs.notifications}
            className="icon-btn dk-bell"
            aria-label={`Notifications, ${notifications.length}`}
            title="Notifications"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3.5 11.5h9l-1.2-1.6V7a3.3 3.3 0 0 0-6.6 0v2.9zM6.5 13.3h3" />
            </svg>
            {notifications.length ? <b className="dk-badge">{notifications.length}</b> : null}
          </Link>
          <ul className="dk-health" aria-label="Provider health">
            {health.map((h) => (
              <li key={h.name} data-state={h.state}>
                <i className="hd" aria-hidden="true" />
                {h.text}
              </li>
            ))}
          </ul>
          <StewardToggle />
          <button
            type="button"
            ref={newButton}
            className="btn dk-new"
            title="New topic (n)"
            onClick={() => setCreating(true)}
          >
            + New topic
          </button>
          <HiddenMenu hidden={hidden} onUnhide={(s) => void actions.setDeskHidden(s, false)} />
          <Seg
            label="Sort"
            value={sort}
            options={["ready", "fixed"] as const}
            show={(v) => (v === "ready" ? "Ready first" : "Fixed")}
            onPick={setSort}
          />
          <Seg
            label="Cards per row"
            className="dk-perrow"
            value={perRow}
            options={PER_ROWS}
            show={(v) => (v === "n" ? "N" : String(v))}
            onPick={setPerRow}
          />
        </div>
      </header>
      {data.error ? (
        <div className="banner" role="alert">
          <span>{data.error.message}</span>
          <button type="button" className="btn ghost sm" onClick={data.clearError}>
            Dismiss
          </button>
        </div>
      ) : null}
      <main className="dk-main" id="main" tabIndex={-1} ref={main} aria-label="Topics on the Desk">
        {!all ? (
          <p className="empty">Loading.</p>
        ) : shown.length === 0 ? (
          <p className="empty">
            Nothing on the Desk{hidden.length ? " (everything is hidden)" : ""}.
          </p>
        ) : (
          <div className="dk-grid" data-sorting={drag ? "true" : undefined}>
            {shown.map((t) => (
              <DeskCard
                key={t.slug}
                topic={t}
                now={now}
                theme={theme}
                move={{
                  moving: drag?.slug === t.slug,
                  onPointerDown: onPointerDown(t.slug),
                  onKeyDown: onKeyDown(t.slug),
                  onBlur: onBlur(t.slug),
                }}
                onFavorite={(on) => void actions.setFavorite(t.slug, on)}
                onHide={() => void actions.setDeskHidden(t.slug, true)}
                onOpen={() => void actions.open(t.slug)}
                onSent={data.refresh}
                onStewardEnabled={(on) => void actions.setStewardEnabled(t.slug, on)}
                onAdoptSteward={actions.adoptSteward}
                onDismissSteward={actions.dismissSteward}
              />
            ))}
          </div>
        )}
      </main>
      {creating ? (
        <NewTopicDialog
          onClose={() => setCreating(false)}
          onTopic={data.refresh}
          onDone={(slug) => {
            setCreating(false);
            setFresh(slug);
            data.refresh();
          }}
        />
      ) : null}
      <div className="sr-only" aria-live="polite">
        {said}
      </div>
    </div>
  );
}
