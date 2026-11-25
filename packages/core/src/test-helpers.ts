import { type Actor, type Axiom, openDatabase } from "./index.js";

export const owner: Actor = { kind: "owner" };
export const axiomActor: Actor = { kind: "axiom" };

export interface TestClock {
  now: () => Date;
  set(iso: string): void;
  advanceDays(days: number): void;
  advanceMs(ms: number): void;
}

export function makeClock(start = "2026-01-01T00:00:00.000Z"): TestClock {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    set: (iso) => {
      t = Date.parse(iso);
    },
    advanceDays: (d) => {
      t += d * 86_400_000;
    },
    advanceMs: (ms) => {
      t += ms;
    },
  };
}

export function makeAxiom(): { ax: Axiom; clock: TestClock } {
  const clock = makeClock();
  return { ax: openDatabase(":memory:", { now: clock.now }), clock };
}

/** A topic with one attached thread, ready for thread events. */
export function topicWithThread(ax: Axiom, slug = "demo", providerThreadId = "t-1") {
  const topic = ax.createTopic({ slug, title: slug }, owner);
  const thread = ax.attachThread(slug, { provider: "claude-code", providerThreadId }, owner);
  return { topic, thread };
}
