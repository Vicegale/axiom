import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// jsdom has no <dialog> modal API. Emulate showModal / close and the Escape key's `cancel`.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = [...document.querySelectorAll("dialog[open]")].at(-1);
    if (!open) return;
    const cancel = new Event("cancel", { cancelable: true });
    open.dispatchEvent(cancel);
    if (!cancel.defaultPrevented) (open as HTMLDialogElement).close();
  });
}

// jsdom has no popover API. Emulate popover="auto": showPopover / hidePopover / togglePopover,
// the `toggle` event, `:popover-open` (reported as [data-popover-open], tests read it with
// `matches(":popover-open")` via a patched `matches`), the popovertarget invoker, light
// dismiss and Escape, with focus returned to the invoker.
if (
  typeof HTMLElement !== "undefined" &&
  (HTMLElement.prototype as { showPopover?: unknown }).showPopover === undefined
) {
  // jsdom's own sheet hides every [popover]; show the open ones.
  const style = document.createElement("style");
  style.textContent = "[popover][data-popover-open] { display: block !important; }";
  document.head.append(style);
  const openPopovers: HTMLElement[] = [];
  const invokers = new WeakMap<HTMLElement, HTMLElement | null>();
  const fire = (el: HTMLElement, oldState: string, newState: string) => {
    const e = new Event("toggle") as Event & { oldState: string; newState: string };
    e.oldState = oldState;
    e.newState = newState;
    el.dispatchEvent(e);
  };
  HTMLElement.prototype.showPopover = function showPopover() {
    if (this.hasAttribute("data-popover-open")) return;
    invokers.set(
      this,
      document.activeElement instanceof HTMLElement ? document.activeElement : null,
    );
    this.setAttribute("data-popover-open", "");
    openPopovers.push(this);
    fire(this, "closed", "open");
  };
  HTMLElement.prototype.hidePopover = function hidePopover() {
    if (!this.hasAttribute("data-popover-open")) return;
    this.removeAttribute("data-popover-open");
    openPopovers.splice(openPopovers.indexOf(this), 1);
    const back = invokers.get(this);
    if (back?.isConnected) back.focus();
    fire(this, "open", "closed");
  };
  HTMLElement.prototype.togglePopover = function togglePopover() {
    if (this.hasAttribute("data-popover-open")) this.hidePopover();
    else this.showPopover();
    return this.hasAttribute("data-popover-open");
  };
  const matches = Element.prototype.matches;
  Element.prototype.matches = function patched(this: Element, selector: string) {
    if (selector === ":popover-open") return this.hasAttribute("data-popover-open");
    return matches.call(this, selector);
  } as typeof matches;
  // Light dismiss runs before the click handlers, as in browsers (pointerdown / pointerup).
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target as Element;
      const invoker = target.closest("[popovertarget]");
      for (const p of [...openPopovers]) {
        if (!p.contains(target) && !(invoker && invoker.getAttribute("popovertarget") === p.id)) {
          p.hidePopover();
        }
      }
    },
    true,
  );
  document.addEventListener("click", (e) => {
    const invoker = (e.target as Element).closest("[popovertarget]");
    const target = invoker && document.getElementById(invoker.getAttribute("popovertarget") ?? "");
    target?.togglePopover();
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") openPopovers.at(-1)?.hidePopover();
    },
    true,
  );
}
