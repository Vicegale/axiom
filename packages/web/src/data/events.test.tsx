import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../App";
import { FakeServer, notification, topic } from "../test/fakeApi";

class FakeEventSource {
  static last: FakeEventSource | undefined;
  listeners = new Map<string, (() => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  close() {}
}

let server: FakeServer;
const shown: string[] = [];

beforeEach(() => {
  shown.length = 0;
  server = new FakeServer();
  server.topics = [topic({ slug: "a", title: "Alpha", status: "wip" })];
  server.notifications = [notification({ id: 1, topicSlug: "a" })];
  server.install();
  vi.stubGlobal("EventSource", FakeEventSource);
  class N {
    static permission = "granted";
    constructor(title: string) {
      shown.push(title);
    }
  }
  vi.stubGlobal("Notification", N);
});
afterEach(() => vi.unstubAllGlobals());

it("refetches what is on screen on every SSE change and notifies only for new ids", async () => {
  render(<App router={{ hook: memoryLocation({ path: "/" }).hook }} />);
  await screen.findByText("Alpha");
  act(() => FakeEventSource.last?.emit("open"));
  await screen.findByText("live");
  expect(shown).toEqual([]); // the first load only seeds the seen ids

  server.topics.push(topic({ slug: "b", title: "Beta", status: "hitl" }));
  server.notifications = [
    notification({ id: 2, topicSlug: "b", kind: "agent asked", body: "Q?" }),
    ...server.notifications,
  ];
  act(() => FakeEventSource.last?.emit("change"));
  await screen.findByText("Beta");
  await waitFor(() => expect(shown).toEqual(["agent asked: Beta"]));

  // A burst of changes is coalesced; nothing new means nothing shown.
  const before = server.called("GET", "/api/topics?all=1").length;
  act(() => {
    FakeEventSource.last?.emit("change");
    FakeEventSource.last?.emit("change");
  });
  await waitFor(() => expect(server.called("GET", "/api/topics?all=1").length).toBe(before + 1));
  expect(shown).toEqual(["agent asked: Beta"]);
});
