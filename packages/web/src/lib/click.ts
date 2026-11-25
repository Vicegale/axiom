import type { MouseEvent } from "react";

/** A plain primary-button click. Anything else (ctrl, cmd, shift, alt, middle button) is the
 *  browser's own "open in a new tab / window", which must not mark the topic opened here. */
export function isPlainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

/** True when the click landed on (or inside) a link, button or form control. */
export function onInteractive(e: MouseEvent): boolean {
  return (e.target as Element).closest("a, button, select, input, textarea, summary") !== null;
}
