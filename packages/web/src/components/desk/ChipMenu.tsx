import { type KeyboardEvent, type ReactNode, type Ref, useId, useRef } from "react";

export interface ChipOption {
  value: string;
  label: string;
  /** A second, muted line. */
  hint?: string;
  /** A divider is drawn above this option. */
  separated?: boolean;
}

interface Props {
  /** What the chip is for, e.g. "Model": the start of its accessible name. */
  name: string;
  /** The current value as the chip shows it; a muted `name` when it is the default. */
  display: string;
  /** The current value as announced, e.g. "default". */
  valueText: string;
  value: string;
  options: ChipOption[];
  onChange: (value: string) => void;
  icon?: ReactNode;
  /** Set when the chip cannot be changed: it stays visible and explains itself. */
  disabledReason?: string;
  muted?: boolean;
  /** The pill, for focusing it (e.g. on a validation error). */
  buttonRef?: Ref<HTMLButtonElement>;
}

const MENU_WIDTH = 240;
const EDGE = 8;

/**
 * A pill-shaped control that opens a small menu (native popover, so no scroll container clips it).
 * Same behaviour as the Artifacts menu: arrow keys move, Escape closes and returns focus to the
 * pill, a click outside closes. The menu opens upward when there is no room below.
 */
export function ChipMenu({
  name,
  display,
  valueText,
  value,
  options,
  onChange,
  icon,
  disabledReason,
  muted,
  buttonRef,
}: Props) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = () => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
  ];

  function place() {
    const el = menu.current;
    const anchor = button.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH, window.innerWidth - 2 * EDGE);
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE));
    const below = window.innerHeight - r.bottom - EDGE - 4;
    const flip = below < 220 && r.top > below;
    const room = flip ? r.top - EDGE - 4 : below;
    el.style.left = `${left}px`;
    el.style.width = `${width}px`;
    el.style.maxHeight = `${Math.max(120, Math.min(320, room))}px`;
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
      const list = items();
      (list.find((i) => i.getAttribute("aria-checked") === "true") ?? list[0])?.focus();
    } else {
      const active = document.activeElement;
      if (!active || active === document.body || menu.current?.contains(active)) {
        button.current?.focus();
      }
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    // The composer collapses on Escape and the layouts bind keys on the window: keep this ours.
    if (e.key === "Escape") e.stopPropagation();
    const list = items();
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

  const disabled = disabledReason !== undefined;
  const label = `${name}: ${valueText}`;
  const reasonId = `${id}-why`;

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
        aria-haspopup="menu"
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? reasonId : undefined}
        title={disabled ? disabledReason : label}
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
          className="rc-menu"
          role="menu"
          aria-label={name}
          tabIndex={-1}
          onToggle={onToggle}
          onKeyDown={onKeyDown}
          onClick={(e) => {
            if ((e.target as Element).closest('[role="menuitemradio"]'))
              menu.current?.hidePopover();
          }}
        >
          {options.map((o) => (
            <div
              key={o.value}
              className="rc-opt-wrap"
              data-separated={o.separated ? "true" : undefined}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={o.value === value}
                className="rc-opt"
                tabIndex={-1}
                onClick={() => onChange(o.value)}
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
                <span className="rc-opt-body">
                  <span className="rc-opt-label">{o.label}</span>
                  {o.hint ? <span className="rc-opt-hint">{o.hint}</span> : null}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
