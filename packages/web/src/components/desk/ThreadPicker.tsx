import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react";
import type { DeskThread } from "../../api";
import { runLine, threadLabel } from "../../lib/desk";
import { PROVIDER_LABEL } from "../../lib/domain";

interface Props {
  threads: DeskThread[];
  selected: DeskThread;
  now: Date;
  onPick: (id: number) => void;
}

const EDGE = 8;
const MIN_WIDTH = 240;

/** The menu's rows, in order. */
function rows(el: HTMLElement | null): HTMLElement[] {
  return [...(el?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
}

/** Puts the menu under the button (over it when there is no room below), at least MIN_WIDTH wide. */
function place(el: HTMLElement | null, anchor: HTMLElement | null) {
  if (!el || !anchor) return;
  const r = anchor.getBoundingClientRect();
  const width = Math.min(Math.max(MIN_WIDTH, r.width), window.innerWidth - 2 * EDGE);
  const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE));
  const below = window.innerHeight - r.bottom - EDGE - 4;
  const flip = below < 220 && r.top > below;
  const room = flip ? r.top - EDGE - 4 : below;
  el.style.left = `${left}px`;
  el.style.width = `${width}px`;
  el.style.maxHeight = `${Math.max(120, Math.min(360, room))}px`;
  if (flip) {
    el.style.top = "auto";
    el.style.bottom = `${window.innerHeight - r.top + 4}px`;
  } else {
    el.style.bottom = "auto";
    el.style.top = `${r.bottom + 4}px`;
  }
}

function Chevron() {
  return (
    <svg
      className="dk-tp-chev"
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
  );
}

/**
 * The card's thread selector: a button showing the selected thread (status dot and title) that
 * opens a menu of the threads, each with its status dot, title, run state and provider, the
 * selected one ticked.
 * Native popover, so the card never clips it; arrow keys, Home and End move, Escape closes and
 * returns focus to the button, a click outside closes. Opens upward when there is no room below.
 */
export function ThreadPicker({ threads, selected, now, onPick }: Props) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // The rows exist only while the menu is open: a card stays light, and a closed menu says nothing.
  const [open, setOpen] = useState(false);
  // Once the rows are there: place the menu and focus the selected thread.
  useLayoutEffect(() => {
    if (!open) return;
    place(menu.current, button.current);
    const list = rows(menu.current);
    (list.find((i) => i.getAttribute("aria-checked") === "true") ?? list[0])?.focus();
  }, [open]);

  function onToggle(e: { nativeEvent: Event }) {
    const opened = (e.nativeEvent as Event & { newState?: string }).newState === "open";
    if (!opened) {
      const active = document.activeElement;
      if (!active || active === document.body || menu.current?.contains(active)) {
        button.current?.focus();
      }
    }
    setOpen(opened);
  }

  function onKeyDown(e: KeyboardEvent) {
    // The layouts bind keys on the window: keep Escape ours.
    if (e.key === "Escape") e.stopPropagation();
    const list = rows(menu.current);
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % list.length;
    else if (e.key === "ArrowUp") next = at <= 0 ? list.length - 1 : at - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    list[next]?.focus();
  }

  const label = threadLabel(selected);

  return (
    <>
      <button
        type="button"
        ref={button}
        className="dk-tp"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={`Thread: ${label}`}
        title={label}
        data-thread={selected.id}
      >
        <span className={`dk-tp-dot s-${selected.status}`} aria-hidden="true" />
        <span className="dk-tp-text">{label}</span>
        <Chevron />
      </button>
      <div
        id={id}
        ref={menu}
        popover="auto"
        className="dk-tp-menu"
        role="menu"
        aria-label="Threads"
        tabIndex={-1}
        onToggle={onToggle}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if ((e.target as Element).closest('[role="menuitemradio"]')) menu.current?.hidePopover();
        }}
      >
        {(open ? threads : []).map((t) => {
          const name = threadLabel(t);
          return (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={t.id === selected.id}
              className="dk-tp-opt"
              tabIndex={-1}
              title={name}
              onClick={() => onPick(t.id)}
            >
              <span className={`dk-tp-dot s-${t.status}`} aria-hidden="true" />
              <span className="dk-tp-body">
                <span className="dk-tp-name">{name}</span>
                <span className="dk-tp-hint">
                  {runLine(t, now)} · {PROVIDER_LABEL[t.provider] ?? t.provider}
                </span>
              </span>
              <svg
                className="dk-tp-tick"
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
            </button>
          );
        })}
      </div>
    </>
  );
}
