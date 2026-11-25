import { type KeyboardEvent, useId, useRef } from "react";
import { Link } from "wouter";
import type { LinkItem } from "../api";
import { hrefs } from "../layouts/shared/routes";
import { type ArtifactKind, artifactKind, fileName, hrefOf, viewable } from "../lib/links";
import "../styles/artifacts.css";

const MENU_WIDTH = 360;
const MENU_MAX_HEIGHT = 384;
const EDGE = 8;

const GLYPH_LABEL: Record<ArtifactKind, string> = {
  html: "HTML page",
  image: "Image",
  markdown: "Markdown document",
  external: "External link",
  file: "File",
};

const GLYPH_PATH: Record<ArtifactKind, React.ReactNode> = {
  html: <path d="M5 4 2 7l3 3M9 4l3 3-3 3" />,
  image: (
    <>
      <rect x="1.8" y="2.8" width="10.4" height="8.4" rx="1" />
      <path d="m2.5 10.5 3-3.2 2.2 2.2 1.6-1.6 2.2 2.6" />
      <circle cx="9.6" cy="5.6" r="0.6" />
    </>
  ),
  markdown: <path d="M3 10.5v-7l2.5 3 2.5-3v7M10.5 4v5.5M9 8l1.5 1.7L12 8" />,
  external: (
    <path d="M8 2.5h3.5V6M11.5 2.5 6.5 7.5M10 8.5v2.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V4.8a.8.8 0 0 1 .8-.8h2.2" />
  ),
  file: (
    <path d="M3.5 1.8h4.6l2.4 2.4v7.6a.7.7 0 0 1-.7.7H3.5a.7.7 0 0 1-.7-.7V2.5a.7.7 0 0 1 .7-.7ZM8 1.8v2.6h2.5" />
  ),
};

/** A 14px outline glyph per artifact kind; the kind is also in the item's accessible name. */
function Glyph({ kind }: { kind: ArtifactKind }) {
  return (
    <svg
      className="amenu-glyph"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <title>{GLYPH_LABEL[kind]}</title>
      {GLYPH_PATH[kind]}
    </svg>
  );
}

function Item({ link: l, slug }: { link: LinkItem; slug: string }) {
  const kind = artifactKind(l.target);
  const title = l.label || fileName(l.target);
  const content = (
    <>
      <Glyph kind={kind} />
      <span className="amenu-body">
        <span className="amenu-title">
          <span className="sr-only">{GLYPH_LABEL[kind]}: </span>
          {title}
        </span>
        {l.description ? <span className="amenu-desc">{l.description}</span> : null}
        <span className="amenu-path" title={l.target}>
          {l.target}
        </span>
      </span>
    </>
  );
  const common = { role: "menuitem", className: "amenu-item", tabIndex: -1 } as const;
  if (viewable(l)) {
    // A plain click opens the viewer here, a modified click a new tab (wouter leaves those alone).
    return (
      <Link {...common} href={hrefs.doc(slug, l.id)}>
        {content}
      </Link>
    );
  }
  const href = hrefOf(l);
  return href ? (
    <a {...common} href={href} target="_blank" rel="noreferrer">
      {content}
    </a>
  ) : (
    // A local file the viewer cannot show: listed, but there is nowhere to go.
    <span {...common} aria-disabled="true">
      {content}
    </span>
  );
}

/**
 * The topic's artifacts as one "Artifacts · N" button that opens a menu (native popover, so it
 * sits in the top layer and no scroll container clips it). Escape and a click outside close it and
 * the browser returns focus to the button; the arrow keys move between the items.
 */
export function ArtifactsMenu({ links, slug }: { links: readonly LinkItem[]; slug: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  function place() {
    const el = menu.current;
    const anchor = button.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH, window.innerWidth - 2 * EDGE);
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE));
    const below = window.innerHeight - r.bottom - EDGE - 4;
    const flip = below < 200 && r.top > below;
    const room = flip ? r.top - EDGE - 4 : below;
    el.style.left = `${left}px`;
    el.style.width = `${width}px`;
    el.style.maxHeight = `${Math.max(120, Math.min(MENU_MAX_HEIGHT, room))}px`;
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
      items()[0]?.focus();
    } else {
      const active = document.activeElement;
      if (!active || active === document.body || menu.current?.contains(active)) {
        button.current?.focus();
      }
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    // The layouts bind the arrow keys (next topic) and Escape (close the drawer) on the window.
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

  return (
    <>
      <button
        type="button"
        ref={button}
        className="lchip abtn"
        popoverTarget={id}
        aria-haspopup="menu"
        title="Open the artifacts of this topic"
      >
        Artifacts · {links.length} <span aria-hidden="true">▾</span>
      </button>
      <div
        id={id}
        ref={menu}
        popover="auto"
        className="amenu"
        role="menu"
        aria-label="Artifacts"
        tabIndex={-1}
        onToggle={onToggle}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if ((e.target as Element).closest('[role="menuitem"]')) menu.current?.hidePopover();
        }}
      >
        {links.map((l) => (
          <Item key={l.id} link={l} slug={slug} />
        ))}
      </div>
    </>
  );
}
