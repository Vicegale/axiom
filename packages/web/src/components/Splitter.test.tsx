import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PaneOptions, usePaneSize } from "../lib/panes";
import { Splitter } from "./Splitter";

const OPTS: PaneOptions = { default: 200, min: 100, max: 400 };

function Harness({
  after = false,
  axis = "col",
  opts = OPTS,
}: {
  after?: boolean;
  axis?: "col" | "row";
  opts?: PaneOptions;
}) {
  const pane = usePaneSize("test", opts);
  return <Splitter pane={pane} axis={axis} after={after} label="Resize test" />;
}

const sep = () => screen.getByRole("separator", { name: "Resize test" });
const now = () => Number(sep().getAttribute("aria-valuenow"));
const cssVar = () => document.documentElement.style.getPropertyValue("--pane-test");

/** Runs animation frames at once so a drag settles. */
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    fn(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Splitter", () => {
  it("is a focusable separator with orientation and value attributes", () => {
    render(<Harness />);
    expect(sep().getAttribute("aria-orientation")).toBe("vertical");
    expect(sep().getAttribute("aria-valuemin")).toBe("100");
    expect(sep().getAttribute("aria-valuemax")).toBe("400");
    expect(now()).toBe(200);
    expect(sep().tabIndex).toBe(0);
    expect(cssVar()).toBe("200px");
  });

  it("is horizontal for a row splitter", () => {
    render(<Harness axis="row" />);
    expect(sep().getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("resizes with a pointer drag, remembers it and clamps to the limits", () => {
    render(<Harness />);
    fireEvent.pointerDown(sep(), { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(sep(), { clientX: 340, pointerId: 1 });
    expect(cssVar()).toBe("240px"); // live, without a React render
    fireEvent.pointerUp(sep(), { clientX: 340, pointerId: 1 });
    expect(now()).toBe(240);
    expect(window.localStorage.getItem("axiom.pane.test")).toBe("240");

    fireEvent.pointerDown(sep(), { button: 0, clientX: 340, pointerId: 1 });
    fireEvent.pointerMove(sep(), { clientX: 2000, pointerId: 1 });
    fireEvent.pointerUp(sep(), { clientX: 2000, pointerId: 1 });
    expect(now()).toBe(400);
    fireEvent.pointerDown(sep(), { button: 0, clientX: 2000, pointerId: 1 });
    fireEvent.pointerMove(sep(), { clientX: -2000, pointerId: 1 });
    fireEvent.pointerUp(sep(), { clientX: -2000, pointerId: 1 });
    expect(now()).toBe(100);
  });

  it("grows the other way for a pane after the separator", () => {
    render(<Harness after />);
    fireEvent.pointerDown(sep(), { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(sep(), { clientX: 260, pointerId: 1 });
    fireEvent.pointerUp(sep(), { clientX: 260, pointerId: 1 });
    expect(now()).toBe(240);
  });

  it("ignores a drag that is cancelled", () => {
    render(<Harness />);
    fireEvent.pointerDown(sep(), { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(sep(), { clientX: 340, pointerId: 1 });
    fireEvent.pointerCancel(sep(), { pointerId: 1 });
    expect(now()).toBe(200);
    expect(cssVar()).toBe("200px");
  });

  it("moves 16 px per arrow key, 64 px with Shift, and Home / End jump to the limits", () => {
    render(<Harness />);
    fireEvent.keyDown(sep(), { key: "ArrowRight" });
    expect(now()).toBe(216);
    fireEvent.keyDown(sep(), { key: "ArrowLeft" });
    fireEvent.keyDown(sep(), { key: "ArrowLeft" });
    expect(now()).toBe(184);
    fireEvent.keyDown(sep(), { key: "ArrowRight", shiftKey: true });
    expect(now()).toBe(248);
    fireEvent.keyDown(sep(), { key: "Home" });
    expect(now()).toBe(100);
    fireEvent.keyDown(sep(), { key: "ArrowLeft", shiftKey: true });
    expect(now()).toBe(100);
    fireEvent.keyDown(sep(), { key: "End" });
    expect(now()).toBe(400);
    expect(window.localStorage.getItem("axiom.pane.test")).toBe("400");
  });

  it("uses the vertical arrows for a row splitter and flips them for a pane after it", () => {
    render(<Harness axis="row" after />);
    fireEvent.keyDown(sep(), { key: "ArrowUp" });
    expect(now()).toBe(216);
    fireEvent.keyDown(sep(), { key: "ArrowDown" });
    fireEvent.keyDown(sep(), { key: "ArrowDown" });
    expect(now()).toBe(184);
    fireEvent.keyDown(sep(), { key: "ArrowLeft" });
    expect(now()).toBe(184);
  });

  it("resets to the default on double-click and forgets the stored size", () => {
    window.localStorage.setItem("axiom.pane.test", "320");
    render(<Harness />);
    expect(now()).toBe(320);
    fireEvent.doubleClick(sep());
    expect(now()).toBe(200);
    expect(window.localStorage.getItem("axiom.pane.test")).toBeNull();
  });

  it("clamps a stored size on load and ignores garbage", () => {
    window.localStorage.setItem("axiom.pane.test", "9999");
    const { unmount } = render(<Harness />);
    expect(now()).toBe(400);
    unmount();
    window.localStorage.setItem("axiom.pane.test", "not a number");
    render(<Harness />);
    expect(now()).toBe(200);
  });

  it("clamps again when the window shrinks", () => {
    let max = 400;
    window.localStorage.setItem("axiom.pane.test", "380");
    render(<Harness opts={{ default: 200, min: 100, max: () => max }} />);
    expect(now()).toBe(380);
    max = 250;
    fireEvent(window, new Event("resize"));
    expect(now()).toBe(250);
    max = 400;
    fireEvent(window, new Event("resize"));
    expect(now()).toBe(380); // the remembered size is not lost
  });

  it("still resizes when localStorage throws on every access", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    render(<Harness />);
    expect(now()).toBe(200);
    fireEvent.keyDown(sep(), { key: "ArrowRight" });
    expect(now()).toBe(216);
    fireEvent.doubleClick(sep());
    expect(now()).toBe(200);
  });

  it("removes its CSS variable when it unmounts", () => {
    const { unmount } = render(<Harness />);
    expect(cssVar()).toBe("200px");
    unmount();
    expect(cssVar()).toBe("");
  });
});
