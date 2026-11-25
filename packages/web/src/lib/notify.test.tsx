import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxiomNotification } from "../api";
import { notification } from "../test/fakeApi";
import { takeNew, useBrowserNotifications } from "./notify";

function Probe({
  list,
  onOpen,
}: {
  list: AxiomNotification[] | undefined;
  onOpen: (s: string) => void;
}) {
  useBrowserNotifications({ notifications: list, titleOf: (s) => `Title ${s}`, onOpen });
  return null;
}

describe("takeNew", () => {
  it("returns only unseen ids and remembers them", () => {
    const seen = new Set<number>([1, 2]);
    const list = [notification({ id: 3 }), notification({ id: 2 }), notification({ id: 1 })];
    expect(takeNew(seen, list).map((n) => n.id)).toEqual([3]);
    expect(takeNew(seen, list)).toEqual([]);
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });
});

describe("useBrowserNotifications", () => {
  const shown: { title: string; options: NotificationOptions | undefined; onclick?: () => void }[] =
    [];

  beforeEach(() => {
    shown.length = 0;
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        const rec: (typeof shown)[number] = { title, options };
        shown.push(rec);
        Object.defineProperty(this, "onclick", {
          set: (fn: () => void) => {
            rec.onclick = fn;
          },
          get: () => rec.onclick ?? null,
        });
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("seeds on the first load, then fires only for new ids", () => {
    const onOpen = vi.fn();
    const old = [notification({ id: 1, topicSlug: "a" })];
    const { rerender } = render(<Probe list={undefined} onOpen={onOpen} />);
    rerender(<Probe list={old} onOpen={onOpen} />);
    expect(shown).toHaveLength(0);

    rerender(
      <Probe
        list={[notification({ id: 2, topicSlug: "b", kind: "agent asked", body: "Q?" }), ...old]}
        onOpen={onOpen}
      />,
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe("agent asked: Title b");
    expect(shown[0]?.options?.body).toBe("Q?");

    // The same list again, and a list that only lost entries, fire nothing.
    rerender(<Probe list={[notification({ id: 2, topicSlug: "b" }), ...old]} onOpen={onOpen} />);
    rerender(<Probe list={old} onOpen={onOpen} />);
    expect(shown).toHaveLength(1);
  });

  it("focuses the tab and opens the topic when clicked", () => {
    const onOpen = vi.fn();
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const { rerender } = render(<Probe list={[]} onOpen={onOpen} />);
    rerender(<Probe list={[notification({ id: 5, topicSlug: "zed" })]} onOpen={onOpen} />);
    act(() => shown[0]?.onclick?.());
    expect(focus).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith("zed");
  });

  it("shows nothing without permission, but still remembers the ids", () => {
    const onOpen = vi.fn();
    (Notification as unknown as { permission: string }).permission = "denied";
    const { rerender } = render(<Probe list={[]} onOpen={onOpen} />);
    rerender(<Probe list={[notification({ id: 1 })]} onOpen={onOpen} />);
    expect(shown).toHaveLength(0);
    (Notification as unknown as { permission: string }).permission = "granted";
    rerender(<Probe list={[notification({ id: 1 })]} onOpen={onOpen} />);
    expect(shown).toHaveLength(0);
  });
});
