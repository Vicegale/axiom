import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Link } from "wouter";

interface Props {
  title: string;
  href: string;
  favorite: boolean;
  stewardEnabled: boolean;
  onFavorite: () => void;
  onHide: () => void;
  /** A plain click on "Open topic" (the card's own open handler). */
  onOpen: (e: React.MouseEvent) => void;
  onStewardEnabled: (on: boolean) => void;
}

const DOTS = "M3 7v.01M7 7v.01M11 7v.01";

/**
 * The card's `⋯` menu: Favourite, Hide from the Desk, Open topic, and the "Steward watches this
 * topic" switch. A menu button pattern: Enter, Space or the arrows open it on the first (or
 * last) item; arrows, Home and End move; Escape closes and returns focus; Tab or a click outside
 * closes it.
 */
export function CardMenu({
  title,
  href,
  favorite,
  stewardEnabled,
  onFavorite,
  onHide,
  onOpen,
  onStewardEnabled,
}: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const first = useRef<"first" | "last">("first");

  const items = () => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []),
  ];
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  // Focus the first (or last) item as the menu opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when it opens.
  useEffect(() => {
    if (!open) return;
    const all = items();
    (first.current === "last" ? all.at(-1) : all[0])?.focus();
  }, [open]);

  // A click outside closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      first.current = e.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    }
  };
  const onMenuKey = (e: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      all[(i + all.length) % all.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(all.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") setOpen(false);
    else if (e.key === " " && (document.activeElement as HTMLElement)?.tagName === "A") {
      e.preventDefault();
      (document.activeElement as HTMLElement).click();
    }
  };

  return (
    <span className="dk-menu-root" ref={root}>
      <button
        type="button"
        ref={button}
        className="icon-btn"
        aria-label={`More actions for ${title}`}
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          first.current = "first";
          setOpen(!open);
        }}
        onKeyDown={onButtonKey}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d={DOTS} />
        </svg>
      </button>
      {open ? (
        <div
          id={id}
          ref={menu}
          role="menu"
          aria-label={`${title} menu`}
          className="dk-menu"
          onKeyDown={onMenuKey}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              onFavorite();
              close(true);
            }}
          >
            {favorite ? "Remove from favourites" : "Favourite"}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              close(false);
              onHide();
            }}
          >
            Hide from the Desk
          </button>
          <Link
            href={href}
            role="menuitem"
            tabIndex={-1}
            onClick={(e) => {
              onOpen(e);
              setOpen(false);
            }}
          >
            Open topic
          </Link>
          <hr />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={stewardEnabled}
            tabIndex={-1}
            onClick={() => onStewardEnabled(!stewardEnabled)}
          >
            Steward watches this topic
            <span className={`dk-sw${stewardEnabled ? " on" : ""}`} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </span>
  );
}
