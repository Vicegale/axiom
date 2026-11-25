import { useRef } from "react";
import type { PaneSize } from "../lib/panes";
import "../styles/splitter.css";

interface Props {
  pane: PaneSize;
  /** Accessible name: what the separator resizes. */
  label: string;
  /** "col" resizes a width (a vertical line); "row" resizes a height (a horizontal line). */
  axis: "col" | "row";
  /**
   * True when the pane sits after the separator (right of it, or below it), so dragging towards
   * the start grows it.
   */
  after?: boolean;
  /** Which edge of its grid cell it straddles: the pane it resizes is on the other side. */
  edge?: "start" | "end";
  className?: string;
  /** Grid placement and the like. */
  style?: React.CSSProperties;
}

const STEP = 16;
const BIG_STEP = 64;

/**
 * A resize handle: a real `role="separator"` (WAI-ARIA "window splitter") with pointer drag,
 * arrow keys (16 px, 64 px with Shift), Home / End and double-click to reset.
 */
export function Splitter({ pane, label, axis, after = false, edge, className = "", style }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ from: number; start: number; now: number; frame: number } | null>(null);
  const sign = after ? -1 : 1;
  const coord = (e: { clientX: number; clientY: number }) => (axis === "col" ? e.clientX : e.clientY);

  const show = (px: number) => {
    ref.current?.setAttribute("aria-valuenow", String(Math.round(px)));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> cannot take focus or children-free ARIA values here
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-label={label}
      data-edge={edge}
      aria-orientation={axis === "col" ? "vertical" : "horizontal"}
      aria-valuenow={pane.size}
      aria-valuemin={pane.min}
      aria-valuemax={pane.max}
      className={`splitter splitter-${axis}${className ? ` ${className}` : ""}`}
      style={style}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        ref.current?.setAttribute("data-dragging", "");
        drag.current = { from: coord(e), start: pane.size, now: pane.size, frame: 0 };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.now = d.start + sign * (coord(e) - d.from);
        if (d.frame) return;
        d.frame = requestAnimationFrame(() => {
          d.frame = 0;
          pane.preview(d.now);
          show(Math.min(pane.max, Math.max(pane.min, d.now)));
        });
      }}
      onPointerUp={(e) => end(e, true)}
      onPointerCancel={(e) => end(e, false)}
      onLostPointerCapture={(e) => end(e, true)}
      onDoubleClick={() => pane.reset()}
      onKeyDown={(e) => {
        const step = e.shiftKey ? BIG_STEP : STEP;
        const grow = axis === "col" ? "ArrowRight" : "ArrowDown";
        const shrink = axis === "col" ? "ArrowLeft" : "ArrowUp";
        let next: number | null = null;
        if (e.key === grow) next = pane.size + sign * step;
        else if (e.key === shrink) next = pane.size - sign * step;
        else if (e.key === "Home") next = after ? pane.max : pane.min;
        else if (e.key === "End") next = after ? pane.min : pane.max;
        if (next === null) return;
        e.preventDefault();
        pane.commit(next);
      }}
    />
  );

  function end(e: React.PointerEvent, keep: boolean) {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.frame) cancelAnimationFrame(d.frame);
    ref.current?.removeAttribute("data-dragging");
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
    if (keep) pane.commit(d.now);
    else pane.preview(d.start);
  }
}
