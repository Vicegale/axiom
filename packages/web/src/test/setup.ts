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
