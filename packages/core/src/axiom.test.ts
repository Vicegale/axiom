import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Axiom } from "./axiom.js";
import { AxiomError } from "./errors.js";
import { makeAxiom, owner, type TestClock, topicWithThread } from "./test-helpers.js";

let ax: Axiom;
let clock: TestClock;
const agent = (threadId?: number) => ({ kind: "agent" as const, threadId });

beforeEach(() => {
  ({ ax, clock } = makeAxiom());
});

function statuses(slug: string) {
  const t = ax.getTopic(slug);
  return { status: t.status, threads: t.threads.map((x) => x.status), views: t.views };
}

describe("topics", () => {
  it("creates a topic with a `topic created` entry, validates slugs, and rejects duplicates", () => {
    const t = ax.createTopic({ slug: "axiom-spec", title: "Axiom spec" }, owner);
    expect(t.status).toBe("idle");
    const entries = ax.listEntries("axiom-spec");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "topic created", author: "axiom" });
    expect(() => ax.createTopic({ slug: "Bad Slug", title: "x" }, owner)).toThrow(/slug/);
    expect(() => ax.createTopic({ slug: "a--b", title: "x" }, owner)).toThrow(/slug/);
    expect(() => ax.createTopic({ slug: "axiom-spec", title: "x" }, owner)).toThrow(/exists/);
  });

  it("looks topics up by id or slug", () => {
    const t = ax.createTopic({ slug: "a", title: "A" }, owner);
    expect(ax.getTopic(t.id).slug).toBe("a");
    expect(() => ax.getTopic("missing")).toThrow(AxiomError);
  });
});

describe("thread events and status", () => {
  it("working -> wip; stop with nothing declared -> idle with an `agent stopped` notification", () => {
    const { thread } = topicWithThread(ax);
    ax.threadWorking(thread.id);
    expect(statuses("demo")).toMatchObject({ status: "wip", views: ["ongoing"] });
    ax.threadStopped(thread.id);
    expect(statuses("demo")).toMatchObject({ status: "idle", views: ["piles"] });
    expect(ax.listNotifications().map((n) => n.kind)).toEqual(["agent stopped"]);
    const kinds = ax.listEntries("demo").map((e) => e.kind);
    expect(kinds).toEqual([
      "topic created",
      "thread event",
      "status change",
      "thread event",
      "status change",
    ]);
  });

  it("waiting on the owner -> hitl, `agent asked`; stop keeps hitl; a new turn clears it", () => {
    const { thread } = topicWithThread(ax);
    ax.threadWorking(thread.id);
    ax.threadWaitingOnOwner(thread.id, "Which database?");
    expect(ax.getTopic("demo").status).toBe("hitl");
    expect(ax.listNotifications().map((n) => n.kind)).toEqual(["agent asked"]);
    ax.threadStopped(thread.id);
    expect(ax.getTopic("demo").status).toBe("hitl");
    ax.threadWorking(thread.id);
    expect(ax.getThread(thread.id)).toMatchObject({ waitingOnOwner: false, declaredStatus: null });
    ax.threadStopped(thread.id);
    expect(ax.getTopic("demo").status).toBe("idle");
  });

  it("error -> error with an `error` notification", () => {
    const { thread } = topicWithThread(ax);
    ax.threadWorking(thread.id);
    ax.threadError(thread.id, "boom");
    expect(ax.getTopic("demo")).toMatchObject({ status: "error", views: ["attention"] });
    expect(ax.listNotifications()[0]).toMatchObject({ kind: "error", body: "boom" });
  });

  it("ended sets ended_at without changing status", () => {
    const { thread } = topicWithThread(ax);
    ax.threadWorking(thread.id);
    ax.threadStopped(thread.id);
    const ended = ax.threadEnded(thread.id, "session end");
    expect(ended.endedAt).not.toBeNull();
    expect(ended.status).toBe("idle");
    expect(ax.getTopic("demo").status).toBe("idle");
    expect(ax.getTopic("demo").openThreadStatuses).toEqual([]);
  });

  it("reopening clears ended_at, writes a thread event, and is a no-op on an open thread", () => {
    const { thread } = topicWithThread(ax);
    ax.threadWorking(thread.id);
    ax.threadStopped(thread.id);
    ax.threadEnded(thread.id, "session end");
    const before = ax.listEntries("demo").length;
    const reopened = ax.threadReopened(thread.id);
    expect(reopened.endedAt).toBeNull();
    expect(reopened.endReason).toBeNull();
    expect(reopened.status).toBe("idle");
    expect(ax.getTopic("demo").openThreadStatuses).toEqual(["idle"]);
    const entries = ax.listEntries("demo");
    expect(entries).toHaveLength(before + 1);
    expect(entries.at(-1)).toMatchObject({ kind: "thread event", body: "Thread resumed" });
    ax.threadReopened(thread.id);
    expect(ax.listEntries("demo")).toHaveLength(before + 1);
  });

  it("a thread that ends while still running goes idle and the topic follows", () => {
    const { thread } = topicWithThread(ax);
    ax.threadWorking(thread.id);
    expect(ax.getTopic("demo").status).toBe("wip");
    const ended = ax.threadEnded(thread.id, "killed");
    expect(ended.status).toBe("idle");
    expect(ax.getTopic("demo").status).toBe("idle");
  });

  it("ending a stopped thread keeps a status set by hand", () => {
    const { thread } = topicWithThread(ax);
    ax.threadWorking(thread.id);
    ax.threadStopped(thread.id);
    ax.setTopicStatus("demo", "done", { kind: "owner" });
    ax.threadEnded(thread.id, "session end");
    expect(ax.getTopic("demo").status).toBe("done");
  });

  it("stop table through the database: declared statuses, links and monitor targets", () => {
    const { thread } = topicWithThread(ax);
    const stopWith = (declared: Parameters<Axiom["setTopicStatus"]>[1]) => {
      ax.threadWorking(thread.id);
      ax.setTopicStatus("demo", declared, agent(thread.id));
      ax.threadStopped(thread.id);
      return ax.getTopic("demo").status;
    };
    expect(stopWith("done")).toBe("done");
    expect(stopWith("blocked")).toBe("blocked");
    expect(stopWith("hitl")).toBe("hitl");
    expect(stopWith("review")).toBe("idle");
    expect(stopWith("monitoring")).toBe("blocked");
    ax.addLink("demo", { kind: "pr", target: "o/r#1" }, owner);
    expect(stopWith("review")).toBe("review");
    const mt = ax.addMonitorTarget("demo", { kind: "pr-review" }, owner);
    expect(stopWith("monitoring")).toBe("blocked"); // suggested only
    ax.confirmMonitorTarget(mt.id, owner);
    expect(stopWith("monitoring")).toBe("monitoring");
  });

  it("a status change entry and last_worked_at are written when the topic status changes", () => {
    const { thread } = topicWithThread(ax);
    clock.advanceDays(1);
    ax.threadWorking(thread.id);
    const change = ax.listEntries("demo").find((e) => e.kind === "status change");
    expect(change?.data).toEqual({ from: "idle", to: "wip", reason: "thread working" });
    expect(ax.getTopic("demo").lastWorkedAt).toBe(clock.now().toISOString());
  });
});

describe("several threads (provisional null-status rule)", () => {
  function twoThreads() {
    ax.createTopic({ slug: "multi", title: "multi" }, owner);
    const a = ax.attachThread(
      "multi",
      { provider: "t3", providerThreadId: "a", environmentId: "e" },
      owner,
    );
    const b = ax.attachThread(
      "multi",
      { provider: "t3", providerThreadId: "b", environmentId: "e" },
      owner,
    );
    return { a, b };
  }

  it("two wip threads -> null; one stops -> follows the remaining wip thread; both stop -> idle", () => {
    const { a, b } = twoThreads();
    ax.threadWorking(a.id);
    expect(ax.getTopic("multi").status).toBe("wip");
    ax.threadWorking(b.id);
    expect(ax.getTopic("multi")).toMatchObject({ status: null, views: ["ongoing"] });
    ax.threadStopped(a.id);
    expect(ax.getTopic("multi").status).toBe("wip");
    ax.threadStopped(b.id);
    expect(ax.getTopic("multi").status).toBe("idle");
  });

  it("a null-status topic's views come from its open threads only", () => {
    const { a, b } = twoThreads();
    ax.createTopic({ slug: "third", title: "third" }, owner);
    const c = ax.attachThread(
      "multi",
      { provider: "t3", providerThreadId: "c", environmentId: "e" },
      owner,
    );
    ax.threadWorking(a.id);
    ax.threadWaitingOnOwner(c.id, "q"); // hitl, open
    ax.threadWorking(b.id);
    expect(ax.getTopic("multi").status).toBeNull();
    expect(ax.getTopic("multi").views.sort()).toEqual(["attention", "ongoing"]);
    // c stops idle: still null, now an idle open thread -> piles
    ax.threadWorking(c.id);
    ax.threadStopped(c.id);
    expect(ax.getTopic("multi").views.sort()).toEqual(["ongoing", "piles"]);
    // ended idle thread no longer puts the topic in a pile
    ax.threadEnded(c.id);
    expect(ax.getTopic("multi").views).toEqual(["ongoing"]);
    expect(ax.listTopics({ view: "piles" }).map((t) => t.slug)).not.toContain("multi");
    expect(ax.listTopics({ view: "ongoing" }).map((t) => t.slug)).toContain("multi");
  });
});

describe("declared status", () => {
  it("agent declarations are stored on the thread; permissions are enforced", () => {
    const { thread } = topicWithThread(ax);
    ax.setTopicStatus("demo", "blocked", agent(thread.id), "waiting on infra");
    expect(ax.getThread(thread.id).declaredStatus).toBe("blocked");
    expect(ax.getTopic("demo").status).toBe("blocked");
    expect(() => ax.setTopicStatus("demo", "stale", agent(thread.id))).toThrow(/owner/);
    expect(() => ax.setTopicStatus("demo", "wip", agent(thread.id))).toThrow(/automatic/);
    ax.setTopicStatus("demo", "wip", owner);
    expect(ax.getTopic("demo").status).toBe("wip");
    ax.setTopicStatus("demo", "stale", owner);
    expect(ax.getTopic("demo").status).toBe("stale");
  });

  it("does not store a declaration from a thread of another topic", () => {
    const { thread } = topicWithThread(ax);
    ax.createTopic({ slug: "other", title: "other" }, owner);
    ax.setTopicStatus("other", "done", agent(thread.id));
    expect(ax.getThread(thread.id).declaredStatus).toBeNull();
  });
});

describe("notifications", () => {
  function stopped() {
    const { thread } = topicWithThread(ax);
    ax.threadWorking(thread.id);
    ax.threadStopped(thread.id);
    return thread;
  }

  it("muted kinds and muted topics are hidden from the pane but the topic stays highlighted", () => {
    stopped();
    expect(ax.listNotifications()).toHaveLength(1);
    ax.setSetting("mutedKinds", ["agent stopped"], owner);
    expect(ax.listNotifications()).toHaveLength(0);
    expect(ax.isHighlighted("demo")).toBe(true);
    expect(ax.getTopic("demo").highlighted).toBe(true);
    ax.setSetting("mutedKinds", [], owner);
    expect(ax.listNotifications()).toHaveLength(1);
    ax.setTopicMuted("demo", true, owner);
    expect(ax.listNotifications()).toHaveLength(0);
    expect(ax.isHighlighted("demo")).toBe(true);
  });

  it("openTopic dismisses notifications and clears the highlight; only the owner can open or mute", () => {
    stopped();
    expect(() => ax.openTopic("demo", agent())).toThrow(/owner/);
    expect(() => ax.setTopicMuted("demo", true, agent())).toThrow(/owner/);
    ax.openTopic("demo", owner);
    expect(ax.isHighlighted("demo")).toBe(false);
    expect(ax.listNotifications()).toHaveLength(0);
    expect(ax.listNotifications({ includeDismissed: true })).toHaveLength(1);
  });

  it("validates settings", () => {
    expect(ax.getSetting("staleAfterDays")).toBe(14);
    expect(() => ax.setSetting("staleAfterDays", -1, owner)).toThrow(AxiomError);
    expect(() => ax.setSetting("mutedKinds", ["nope"], owner)).toThrow(AxiomError);
    expect(() => ax.setSetting("staleAfterDays", 3, agent())).toThrow(/owner/);
    ax.setSetting("staleAfterDays", 3, owner);
    expect(ax.getSetting("staleAfterDays")).toBe(3);
  });
});

describe("stale prompt", () => {
  it("is created after N idle days, not duplicated, and never returns once dismissed", () => {
    ax.createTopic({ slug: "old", title: "old" }, owner);
    clock.advanceDays(13);
    expect(ax.refreshStalePrompts()).toHaveLength(0);
    clock.advanceDays(2);
    expect(ax.refreshStalePrompts()).toHaveLength(1);
    expect(ax.refreshStalePrompts()).toHaveLength(0);
    expect(ax.listNotifications().map((n) => n.kind)).toEqual(["stale prompt"]);
    ax.dismissStalePrompt("old", owner);
    expect(ax.isHighlighted("old")).toBe(false);
    clock.advanceDays(100);
    expect(ax.refreshStalePrompts()).toHaveLength(0);
    expect(ax.getTopic("old").stalePromptDismissed).toBe(true);
  });

  it("honours staleAfterDays and skips non-idle topics", () => {
    ax.createTopic({ slug: "busy", title: "busy" }, owner);
    ax.setTopicStatus("busy", "blocked", owner);
    ax.setSetting("staleAfterDays", 2, owner);
    clock.advanceDays(3);
    expect(ax.refreshStalePrompts()).toHaveLength(0);
  });

  it("markStale is owner-only, sets stale, writes a status change and dismisses the prompt", () => {
    ax.createTopic({ slug: "old", title: "old" }, owner);
    clock.advanceDays(20);
    ax.refreshStalePrompts();
    expect(() => ax.markStale("old", agent())).toThrow(/owner/);
    expect(() => ax.dismissStalePrompt("old", agent())).toThrow(/owner/);
    ax.markStale("old", owner);
    expect(ax.getTopic("old").status).toBe("stale");
    expect(ax.isHighlighted("old")).toBe(false);
    expect(ax.listEntries("old").at(-1)?.data).toMatchObject({ from: "idle", to: "stale" });
  });
});

describe("entries", () => {
  beforeEach(() => {
    ax.createTopic({ slug: "t", title: "t" }, owner);
  });

  it("enforces who writes which kind", () => {
    expect(() => ax.addEntry("t", { kind: "owner input", body: "x" }, agent())).toThrow(/owner/);
    expect(() =>
      ax.addEntry(
        "t",
        { kind: "authorization", body: "x", data: { scope: "s", standing: false } },
        agent(),
      ),
    ).toThrow(/owner/);
    expect(() => ax.addEntry("t", { kind: "status change", body: "x" }, agent())).toThrow(/Axiom/);
    expect(() => ax.addEntry("t", { kind: "thread event", body: "x" }, owner)).toThrow(/Axiom/);
    expect(() => ax.addEntry("t", { kind: "note", body: "x" }, { kind: "axiom" })).toThrow(
      AxiomError,
    );
    expect(ax.addEntry("t", { kind: "owner input", body: "x" }, owner).author).toBe("owner");
    expect(
      ax.addEntry("t", { kind: "git event", body: "PR opened" }, { kind: "axiom" }).author,
    ).toBe("axiom");
    expect(ax.addEntry("t", { kind: "note", body: "x" }, agent()).author).toBe("agent");
  });

  it("validates data per kind", () => {
    const add = (kind: Parameters<Axiom["addEntry"]>[1]["kind"], data: unknown, a = agent()) =>
      ax.addEntry("t", { kind, body: "b", data }, a);
    expect(() => add("verification", {})).toThrow(/result/);
    expect(() => add("verification", { result: "meh" })).toThrow(AxiomError);
    expect(add("verification", { result: "pass", evidence: ["a.png"] }).data).toEqual({
      result: "pass",
      evidence: ["a.png"],
    });
    expect(() => add("decision", { why: 3 })).toThrow(AxiomError);
    expect(add("decision", { why: "because" }).data).toEqual({ why: "because" });
    expect(add("decision", undefined).data).toBeNull();
    expect(() => add("note", { extra: 1 })).toThrow(AxiomError);
    expect(() => add("authorization", { scope: "merge" }, owner)).toThrow(AxiomError);
    expect(add("authorization", { scope: "merge", standing: true }, owner).data).toEqual({
      scope: "merge",
      standing: true,
    });
    expect(() => ax.addEntry("t", { kind: "note", body: "" }, agent())).toThrow(/body/);
  });

  it("validates refs", () => {
    const e = ax.addEntry(
      "t",
      { kind: "note", body: "b", refs: [{ type: "pr", value: "o/r#1" }] },
      agent(),
    );
    expect(e.refs).toEqual([{ type: "pr", value: "o/r#1" }]);
    expect(() =>
      ax.addEntry(
        "t",
        { kind: "note", body: "b", refs: [{ type: "bogus" as "pr", value: "x" }] },
        agent(),
      ),
    ).toThrow(AxiomError);
  });

  it("corrects_entry_id must point at an entry of the same topic", () => {
    ax.createTopic({ slug: "u", title: "u" }, owner);
    const mine = ax.addEntry("t", { kind: "note", body: "wrong" }, agent());
    const theirs = ax.addEntry("u", { kind: "note", body: "other" }, agent());
    expect(() =>
      ax.addEntry("t", { kind: "note", body: "fix", correctsEntryId: theirs.id }, agent()),
    ).toThrow(/same topic/);
    expect(
      ax.addEntry("t", { kind: "note", body: "fix", correctsEntryId: mine.id }, agent())
        .correctsEntryId,
    ).toBe(mine.id);
  });

  it("only the owner deletes; a corrected entry can be deleted", () => {
    const e = ax.addEntry("t", { kind: "note", body: "secret" }, agent());
    const fix = ax.addEntry("t", { kind: "note", body: "fix", correctsEntryId: e.id }, agent());
    expect(() => ax.deleteEntry(e.id, agent())).toThrow(/owner/);
    expect(() => ax.deleteEntry(e.id, { kind: "axiom" })).toThrow(/owner/);
    ax.deleteEntry(e.id, owner);
    expect(ax.listEntries("t").map((x) => x.id)).not.toContain(e.id);
    expect(ax.listEntries("t").find((x) => x.id === fix.id)?.correctsEntryId).toBeNull();
  });

  it("every entry bumps last_worked_at", () => {
    const before = ax.getTopic("t").lastWorkedAt;
    clock.advanceDays(1);
    ax.addEntry("t", { kind: "note", body: "x" }, agent());
    expect(ax.getTopic("t").lastWorkedAt).toBe(clock.now().toISOString());
    expect(ax.getTopic("t").lastWorkedAt).not.toBe(before);
  });

  it("an agent in a known thread stamps thread_id", () => {
    const { thread } = topicWithThread(ax, "w");
    expect(ax.addEntry("w", { kind: "note", body: "x" }, agent(thread.id)).threadId).toBe(
      thread.id,
    );
    expect(ax.addEntry("w", { kind: "note", body: "x" }, agent(9999)).threadId).toBeNull();
  });
});

describe("tickets and epics", () => {
  it("Jira-linked status cannot be set; unlinked can; Jira status is stored", () => {
    const linked = ax.createTicket(
      { slug: "vr-1", title: "VR", jira: { key: "VR-1", url: "https://j/VR-1" } },
      owner,
    );
    const plain = ax.createTicket({ slug: "plain", title: "plain" }, owner);
    expect(() => ax.setTicketStatus(linked.id, "done", owner)).toThrow(/Jira/);
    expect(ax.setTicketStatus(plain.id, "wip", owner).status).toBe("wip");
    expect(() => ax.setTicketStatus(plain.id, "bogus" as "wip", owner)).toThrow(AxiomError);
    clock.advanceDays(1);
    const synced = ax.setTicketJiraStatus("vr-1", "In Review");
    expect(synced).toMatchObject({
      jiraStatus: "In Review",
      jiraSyncedAt: clock.now().toISOString(),
    });
    const epic = ax.createEpic({ slug: "e", title: "e", jira: { key: "E-1", url: "u" } }, owner);
    expect(() => ax.setEpicStatus("e", "done", owner)).toThrow(/Jira/);
    expect(() => ax.setEpicJiraStatus(epic.id, "Open")).not.toThrow();
    const plainEpic = ax.createEpic({ slug: "pe", title: "pe" }, owner);
    expect(ax.setEpicStatus(plainEpic.id, "done", owner).status).toBe("done");
  });

  it("parents are many-to-many", () => {
    ax.createTopic({ slug: "t", title: "t" }, owner);
    ax.createTicket({ slug: "k1", title: "k1" }, owner);
    ax.createTicket({ slug: "k2", title: "k2" }, owner);
    ax.createEpic({ slug: "e1", title: "e1" }, owner);
    ax.createEpic({ slug: "e2", title: "e2" }, owner);
    ax.addTopicToTicket("t", "k1", owner);
    ax.addTopicToTicket("t", "k2", owner);
    ax.addTopicToTicket("t", "k2", owner);
    ax.addTopicToEpic("t", "e1", owner);
    ax.addTicketToEpic("k1", "e1", owner);
    ax.addTicketToEpic("k1", "e2", owner);
    const t = ax.getTopic("t");
    expect(t.tickets.map((x) => x.slug)).toEqual(["k1", "k2"]);
    expect(t.epics.map((x) => x.slug)).toEqual(["e1"]);
    expect(ax.listTicketEpics("k1").map((x) => x.slug)).toEqual(["e1", "e2"]);
    ax.removeTopicFromTicket("t", "k1", owner);
    expect(ax.getTopic("t").tickets.map((x) => x.slug)).toEqual(["k2"]);
  });
});

describe("links and monitor targets", () => {
  it("stores links and rejects bad kinds", () => {
    ax.createTopic({ slug: "t", title: "t" }, owner);
    const l = ax.addLink("t", { kind: "worktree", target: "/tmp/wt", label: "main" }, owner);
    expect(l.kind).toBe("worktree");
    expect(() => ax.addLink("t", { kind: "nope" as "pr", target: "x" }, owner)).toThrow(AxiomError);
    const m = ax.addMonitorTarget("t", { kind: "pr-review", linkId: l.id }, owner);
    expect(m.state).toBe("suggested");
    expect(ax.confirmMonitorTarget(m.id, owner).state).toBe("confirmed");
    expect(ax.getTopic("t").monitorTargets).toHaveLength(1);
  });
});

describe("link descriptions", () => {
  it("stores, trims, updates and clears label and description", () => {
    ax.createTopic({ slug: "t", title: "t" }, owner);
    const l = ax.addLink(
      "t",
      { kind: "artifact", target: "a.md", label: " A ", description: " About a " },
      owner,
    );
    expect(l).toMatchObject({ label: "A", description: "About a" });
    const bare = ax.addLink("t", { kind: "artifact", target: "b.md" }, owner);
    expect(bare.description).toBeNull();
    const u = ax.updateLink("t", bare.id, { description: "later" }, owner);
    expect(u).toMatchObject({ description: "later", label: null });
    expect(ax.updateLink("t", l.id, { label: "" }, owner)).toMatchObject({
      label: null,
      description: "About a",
    });
    expect(ax.updateLink("t", l.id, { description: "" }, owner).description).toBeNull();
    expect(ax.getTopic("t").links.map((x) => x.description)).toEqual([null, "later"]);
  });

  it("corrects a link's target; folders must exist for repository and worktree links", () => {
    ax.createTopic({ slug: "t", title: "t" }, owner);
    const art = ax.addLink("t", { kind: "artifact", target: "a.md" }, owner);
    expect(ax.updateLink("t", art.id, { target: " b.md " }, owner).target).toBe("b.md");
    expect(() => ax.updateLink("t", art.id, { target: "  " }, owner)).toThrow(AxiomError);
    const repo = ax.addLink("t", { kind: "repository", target: "/home/x/project/axiom" }, owner);
    expect(() => ax.updateLink("t", repo.id, { target: "/nope/axiom" }, owner)).toThrow(
      /folder not found/,
    );
    expect(() => ax.updateLink("t", repo.id, { target: "relative" }, owner)).toThrow(
      /folder not found/,
    );
    const real = mkdtempSync(join(tmpdir(), "axiom-link-"));
    try {
      const u = ax.updateLink("t", repo.id, { target: `${real}/`, label: "R" }, owner);
      expect(u).toMatchObject({ target: real, label: "R" });
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("validates lengths and the link's topic", () => {
    ax.createTopic({ slug: "t", title: "t" }, owner);
    ax.createTopic({ slug: "u", title: "u" }, owner);
    const l = ax.addLink("t", { kind: "artifact", target: "a.md" }, owner);
    expect(() => ax.updateLink("t", l.id, { description: "x".repeat(201) }, owner)).toThrow(
      AxiomError,
    );
    expect(() => ax.updateLink("t", l.id, { label: "x".repeat(121) }, owner)).toThrow(AxiomError);
    expect(() =>
      ax.addLink("t", { kind: "artifact", target: "c", description: "x".repeat(201) }, owner),
    ).toThrow(AxiomError);
    ax.updateLink("t", l.id, { description: "x".repeat(200), label: "y".repeat(120) }, owner);
    expect(() => ax.updateLink("u", l.id, { label: "z" }, owner)).toThrow(/not found/);
    expect(() => ax.updateLink("t", 999, { label: "z" }, owner)).toThrow(/not found/);
  });
});

describe("thread uniqueness", () => {
  it("rejects re-attaching a provider thread to the same or another topic", () => {
    ax.createTopic({ slug: "a", title: "a" }, owner);
    ax.createTopic({ slug: "b", title: "b" }, owner);
    ax.attachThread("a", { provider: "claude-code", providerThreadId: "s1" }, owner);
    expect(() =>
      ax.attachThread("b", { provider: "claude-code", providerThreadId: "s1" }, owner),
    ).toThrow(/already attached/);
    expect(() =>
      ax.attachThread("a", { provider: "claude-code", providerThreadId: "s1" }, owner),
    ).toThrow(/already attached/);
  });

  it("treats environment_id as part of the key, with null equal to empty", () => {
    ax.createTopic({ slug: "a", title: "a" }, owner);
    ax.attachThread("a", { provider: "t3", providerThreadId: "x", environmentId: "env1" }, owner);
    ax.attachThread("a", { provider: "t3", providerThreadId: "x", environmentId: "env2" }, owner);
    expect(() =>
      ax.attachThread("a", { provider: "t3", providerThreadId: "x", environmentId: "env1" }, owner),
    ).toThrow(AxiomError);
    // the DB itself also refuses (NULL and '' are the same key)
    const db = ax.db;
    db.exec(
      "INSERT INTO thread (topic_id, provider, provider_thread_id, status_changed_at, started_at) VALUES (1, 'claude-code', 'z', 'x', 'x')",
    );
    expect(() =>
      db.exec(
        "INSERT INTO thread (topic_id, provider, provider_thread_id, environment_id, status_changed_at, started_at) VALUES (1, 'claude-code', 'z', '', 'x', 'x')",
      ),
    ).toThrow(/UNIQUE/);
  });

  it("the schema's CHECK constraints reject bad enums", () => {
    expect(() =>
      ax.db.exec(
        "INSERT INTO topic (slug, title, status, created_at, last_worked_at) VALUES ('x','x','bogus','t','t')",
      ),
    ).toThrow(/CHECK/);
  });
});

describe("provider support", () => {
  it("defaults the T3 pin and lets the owner change it", () => {
    expect(ax.getSetting("t3Pin")).toEqual({
      serverVersion: "0.1.11-nightly.20261118.4890",
      migration: 98,
    });
    ax.setSetting("t3Pin", { serverVersion: "x", migration: 99 }, owner);
    expect(ax.getSetting("t3Pin")).toEqual({ serverVersion: "x", migration: 99 });
    expect(() => ax.setSetting("t3Pin", { serverVersion: "x" }, owner)).toThrow(/Invalid/);
  });

  it("records a refresh request time per provider", () => {
    expect(ax.providerRefreshRequestedAt("t3")).toBe(0);
    clock.set("2026-02-03T04:05:06.000Z");
    ax.requestProviderRefresh("t3");
    expect(ax.providerRefreshRequestedAt("t3")).toBe(Date.parse("2026-02-03T04:05:06.000Z"));
    expect(ax.providerRefreshRequestedAt("claude-code")).toBe(0);
  });

  it("lists the attached threads of one provider", () => {
    topicWithThread(ax);
    ax.attachThread("demo", { provider: "t3", providerThreadId: "x" }, owner);
    expect(ax.listProviderThreads("t3").map((t) => t.providerThreadId)).toEqual(["x"]);
  });
});

describe("tasks", () => {
  const keys = (topic = "demo") => ax.listTasks(topic).map((t) => t.key);

  beforeEach(() => {
    ax.createTopic({ slug: "demo", title: "demo" }, owner);
    ax.createTopic({ slug: "other", title: "other" }, owner);
  });

  it("creates tasks in order with dependencies, and keeps keys unique per topic", () => {
    ax.createTask("demo", { key: "S0", title: "Setup", doneWhen: "It builds" }, owner);
    ax.createTask("demo", { key: "S1", title: "Core", dependsOn: ["S0"] }, owner);
    expect(keys()).toEqual(["S0", "S1"]);
    expect(ax.getTask("demo", "S0")).toMatchObject({
      doneWhen: "It builds",
      status: "to do",
      position: 1,
      dependents: ["S1"],
      dependsOn: [],
    });
    expect(() => ax.createTask("demo", { key: "S0", title: "again" }, owner)).toThrow(/already/);
    // the same key is fine in another topic
    ax.createTask("other", { key: "S0", title: "elsewhere" }, owner);
    expect(() =>
      ax.createTask("demo", { key: "S2", title: "x", dependsOn: ["nope"] }, owner),
    ).toThrow(/not found/);
    expect(() =>
      ax.createTask("demo", { key: "S2", title: "x", dependsOn: ["S2"] }, owner),
    ).toThrow(/itself/);
    expect(keys()).toEqual(["S0", "S1"]);
    expect(() => ax.createTask("demo", { key: "bad key", title: "x" }, owner)).toThrow(/key/);
  });

  it("rejects a direct cycle, an indirect cycle and a self dependency", () => {
    ax.createTask("demo", { key: "A", title: "a" }, owner);
    ax.createTask("demo", { key: "B", title: "b", dependsOn: ["A"] }, owner);
    ax.createTask("demo", { key: "C", title: "c", dependsOn: ["B"] }, owner);
    expect(() => ax.addTaskDependency("demo", "A", "B", owner)).toThrow(/cycle/);
    expect(() => ax.addTaskDependency("demo", "A", "C", owner)).toThrow(
      /cycle: A waits for C waits for B waits for A/,
    );
    expect(() => ax.addTaskDependency("demo", "A", "A", owner)).toThrow(/itself/);
    expect(ax.getTask("demo", "A").dependsOn).toEqual([]);
    // a diamond is not a cycle, and adding an edge twice is harmless
    ax.createTask("demo", { key: "D", title: "d", dependsOn: ["A"] }, owner);
    ax.addTaskDependency("demo", "C", "D", owner);
    ax.addTaskDependency("demo", "C", "D", owner);
    expect(ax.getTask("demo", "C").dependsOn).toEqual(["B", "D"]);
  });

  it("only allows dependencies inside one topic", () => {
    ax.createTask("demo", { key: "A", title: "a" }, owner);
    ax.createTask("other", { key: "X", title: "x" }, owner);
    expect(() => ax.addTaskDependency("demo", "A", "X", owner)).toThrow(/not found: X/);
    expect(() => ax.createTask("demo", { key: "B", title: "b", dependsOn: ["X"] }, owner)).toThrow(
      /not found/,
    );
  });

  it("computes waiting from the dependencies' statuses and removes dependencies", () => {
    ax.createTask("demo", { key: "A", title: "a" }, owner);
    ax.createTask("demo", { key: "B", title: "b", dependsOn: ["A"] }, owner);
    expect(ax.getTask("demo", "A").waiting).toBe(false);
    expect(ax.getTask("demo", "B").waiting).toBe(true);
    ax.setTaskStatus("demo", "A", "wip", owner);
    expect(ax.getTask("demo", "B").waiting).toBe(true);
    ax.setTaskStatus("demo", "A", "done", owner);
    expect(ax.getTask("demo", "B").waiting).toBe(false);
    ax.setTaskStatus("demo", "A", "blocked", owner);
    expect(ax.getTask("demo", "B").waiting).toBe(true);
    ax.removeTaskDependency("demo", "B", "A", owner);
    expect(ax.getTask("demo", "B")).toMatchObject({ waiting: false, dependsOn: [] });
  });

  it("writes a status change entry, bumps last worked and counts tasks", () => {
    ax.createTask("demo", { key: "A", title: "a" }, owner);
    ax.createTask("demo", { key: "B", title: "b" }, owner);
    clock.advanceDays(1);
    ax.setTaskStatus("demo", "A", "done", { kind: "agent" });
    ax.setTaskStatus("demo", "A", "done", { kind: "agent" }); // no change, no entry
    const entries = ax.listEntries("demo").filter((e) => e.kind === "status change");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      author: "axiom",
      data: { task: "A", from: "to do", to: "done", by: "agent" },
    });
    expect(ax.getTopic("demo").lastWorkedAt).toBe(clock.now().toISOString());
    expect(ax.getTopic("demo").taskCounts).toEqual({ total: 2, done: 1 });
    expect(ax.getTopic("other").taskCounts).toEqual({ total: 0, done: 0 });
    expect(ax.listTopics().find((t) => t.slug === "demo")?.taskCounts.total).toBe(2);
    expect(() => ax.setTaskStatus("demo", "A", "stale" as never, owner)).toThrow(/status/);
  });

  it("bumps last worked on create, update and dependency changes", () => {
    clock.advanceDays(1);
    ax.createTask("demo", { key: "A", title: "a" }, owner);
    expect(ax.getTopic("demo").lastWorkedAt).toBe(clock.now().toISOString());
    clock.advanceDays(1);
    ax.updateTask("demo", "A", { title: "renamed", doneWhen: "x" }, owner);
    expect(ax.getTask("demo", "A")).toMatchObject({ title: "renamed", doneWhen: "x" });
    expect(ax.getTopic("demo").lastWorkedAt).toBe(clock.now().toISOString());
  });

  it("groups by a spec link of the same topic only", () => {
    const spec = ax.addLink("demo", { kind: "spec", target: "docs/plan.md" }, owner);
    const pr = ax.addLink("demo", { kind: "pr", target: "o/r#1" }, owner);
    const foreign = ax.addLink("other", { kind: "spec", target: "docs/x.md" }, owner);
    ax.createTask("demo", { key: "A", title: "a", specLinkId: spec.id }, owner);
    expect(ax.getTask("demo", "A").specLinkId).toBe(spec.id);
    expect(() => ax.createTask("demo", { key: "B", title: "b", specLinkId: pr.id }, owner)).toThrow(
      /spec link/,
    );
    expect(() => ax.updateTask("demo", "A", { specLinkId: foreign.id }, owner)).toThrow(
      /spec link/,
    );
    ax.updateTask("demo", "A", { specLinkId: null }, owner);
    expect(ax.getTask("demo", "A").specLinkId).toBeNull();
  });

  it("pointing an already-working thread at a task makes the task wip at once", () => {
    const { thread } = topicWithThread(ax, "work");
    ax.createTask("work", { key: "S1", title: "one" }, owner);
    ax.createTask("work", { key: "S2", title: "two" }, owner);
    ax.setTaskStatus("work", "S2", "done", owner);
    ax.threadWorking(thread.id);
    ax.setThreadTask(thread.id, "S1", owner);
    expect(ax.getTask("work", "S1").status).toBe("wip");
    ax.setThreadTask(thread.id, "S2", owner); // done stays done
    expect(ax.getTask("work", "S2").status).toBe("done");
    ax.threadStopped(thread.id);
    ax.createTask("work", { key: "S3", title: "three" }, owner);
    ax.setThreadTask(thread.id, "S3", owner); // a stopped thread does not start it
    expect(ax.getTask("work", "S3").status).toBe("to do");
  });

  it("sets the thread's task to wip when it works, and leaves it alone on stop and end", () => {
    const { thread } = topicWithThread(ax, "work");
    ax.createTask("work", { key: "S1", title: "one" }, owner);
    ax.createTask("work", { key: "S2", title: "two" }, owner);
    ax.setThreadTask(thread.id, "S1", owner);
    expect(ax.getThread(thread.id).taskId).toBe(ax.getTask("work", "S1").id);
    ax.threadWorking(thread.id);
    expect(ax.getTask("work", "S1").status).toBe("wip");
    expect(ax.getTask("work", "S2").status).toBe("to do");
    ax.threadStopped(thread.id);
    expect(ax.getTask("work", "S1").status).toBe("wip");
    ax.threadEnded(thread.id);
    expect(ax.getTask("work", "S1").status).toBe("wip");
    const change = ax
      .listEntries("work")
      .find((e) => e.kind === "status change" && (e.data as { task?: string }).task);
    expect(change).toMatchObject({ threadId: thread.id, data: { task: "S1", by: "axiom" } });
    ax.setTaskStatus("work", "S1", "done", owner);
    ax.threadWorking(thread.id); // follow-up work does not reopen a done task
    expect(ax.getTask("work", "S1").status).toBe("done");
    ax.setThreadTask(thread.id, null, owner);
    expect(ax.getThread(thread.id).taskId).toBeNull();
  });

  it("a thread without a task changes no task, and a task must be in the thread's topic", () => {
    const { thread } = topicWithThread(ax, "work");
    ax.createTask("work", { key: "S1", title: "one" }, owner);
    ax.threadWorking(thread.id);
    expect(ax.getTask("work", "S1").status).toBe("to do");
    ax.createTask("other", { key: "X", title: "x" }, owner);
    expect(() => ax.setThreadTask(thread.id, "X", owner)).toThrow(/not found/);
  });

  it("attaches a thread to a task at attach time", () => {
    ax.createTask("demo", { key: "S1", title: "one" }, owner);
    const th = ax.attachThread(
      "demo",
      { provider: "claude-code", providerThreadId: "x", taskKey: "S1" },
      owner,
    );
    expect(th.taskId).toBe(ax.getTask("demo", "S1").id);
    expect(() =>
      ax.attachThread(
        "demo",
        { provider: "claude-code", providerThreadId: "y", taskKey: "no" },
        owner,
      ),
    ).toThrow(/not found/);
    expect(ax.findThread({ provider: "claude-code", providerThreadId: "y" })).toBeUndefined();
  });
});

describe("the Desk: replies, summaries, arrangement", () => {
  it("stores the latest reply (capped), ignores blank or identical text, writes no history", () => {
    const { thread } = topicWithThread(ax);
    const before = ax.listEntries("demo").length;
    ax.setThreadReply(thread.id, "   ");
    expect(ax.getThread(thread.id).lastReply).toBeNull();
    ax.setThreadReply(thread.id, "first", "2026-01-01T00:00:00.000Z");
    ax.setThreadReply(thread.id, "first", "2026-01-02T00:00:00.000Z");
    expect(ax.getThread(thread.id)).toMatchObject({
      lastReply: "first",
      lastReplyAt: "2026-01-01T00:00:00.000Z",
    });
    ax.setThreadReply(thread.id, "x".repeat(250_000));
    expect(ax.getThread(thread.id).lastReply).toHaveLength(200_000);
    expect(ax.getThread(thread.id).lastReplyAt).toBe(clock.now().toISOString());
    expect(ax.listEntries("demo")).toHaveLength(before);
  });

  it("stores the activity line: one line, capped at 300, no history, nothing else bumped", () => {
    const { thread } = topicWithThread(ax);
    const before = ax.listEntries("demo").length;
    const status = ax.getThread(thread.id).status;
    ax.setThreadActivity(thread.id, "  \n ");
    expect(ax.getThread(thread.id).activityText).toBeNull();
    ax.setThreadActivity(thread.id, "  $ npm\n  test  ", "2026-01-01T00:00:00.000Z");
    expect(ax.getThread(thread.id)).toMatchObject({
      activityText: "$ npm test",
      activityAt: "2026-01-01T00:00:00.000Z",
    });
    ax.setThreadActivity(thread.id, "y".repeat(500));
    const t = ax.getThread(thread.id);
    expect(t.activityText).toHaveLength(300);
    expect(t.activityText?.endsWith("…")).toBe(true);
    expect(t.activityAt).toBe(clock.now().toISOString());
    expect(t.status).toBe(status);
    expect(ax.listEntries("demo")).toHaveLength(before);
    // It survives the thread stopping.
    ax.threadWorking(thread.id);
    ax.threadStopped(thread.id);
    expect(ax.getThread(thread.id).activityText).toHaveLength(300);
  });

  it("stores model, effort and context: only what changed, no history", () => {
    const { thread } = topicWithThread(ax);
    const before = ax.listEntries("demo").length;
    expect(ax.getThread(thread.id)).toMatchObject({
      model: null,
      effort: null,
      contextUsed: null,
      contextMax: null,
      runtimeAt: null,
    });
    expect(ax.setThreadRuntime(thread.id, {})).toBe(false);
    expect(
      ax.setThreadRuntime(thread.id, { model: " claude-opus-5-5 ", effort: "high" }, "T1"),
    ).toBe(true);
    expect(ax.getThread(thread.id)).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
      contextUsed: null,
      runtimeAt: "T1",
    });
    // The same values again: no write, so the time stays.
    expect(ax.setThreadRuntime(thread.id, { model: "claude-opus-5-5", effort: "high" }, "T2")).toBe(
      false,
    );
    expect(ax.getThread(thread.id).runtimeAt).toBe("T1");
    // Absent keys stay; null clears; blank text clears.
    expect(
      ax.setThreadRuntime(thread.id, { contextUsed: 190_000, contextMax: 1_000_000 }, "T3"),
    ).toBe(true);
    expect(ax.setThreadRuntime(thread.id, { contextMax: null, effort: "  " }, "T4")).toBe(true);
    expect(ax.getThread(thread.id)).toMatchObject({
      model: "claude-opus-5-5",
      effort: null,
      contextUsed: 190_000,
      contextMax: null,
      runtimeAt: "T4",
    });
    expect(ax.listEntries("demo")).toHaveLength(before);
  });

  it("tracks running subagents: queued call names the start, stop removes, no history", () => {
    const { thread } = topicWithThread(ax);
    const before = ax.listEntries("demo").length;
    ax.queueSubagentCall(thread.id, { title: "Check the schema", agentType: "Explore" });
    ax.queueSubagentCall(thread.id, { title: "Review", agentType: "general-purpose" });
    ax.queueSubagentCall(thread.id, { title: "Review 2", agentType: "general-purpose" });
    // The oldest call of the same type names it, not the oldest call overall.
    expect(ax.subagentStarted(thread.id, "a1", "general-purpose")).toBe(true);
    expect(ax.subagentStarted(thread.id, "a1", "general-purpose")).toBe(false);
    expect(ax.subagentStarted(thread.id, "a2", "general-purpose")).toBe(true);
    // No call of that type left: no title.
    expect(ax.subagentStarted(thread.id, "a3", "general-purpose")).toBe(true);
    const list = ax.listSubagents().get(thread.id) ?? [];
    expect(list.map((s) => [s.key, s.title, s.agentType])).toEqual([
      ["a1", "Review", "general-purpose"],
      ["a2", "Review 2", "general-purpose"],
      ["a3", null, "general-purpose"],
    ]);
    expect(ax.subagentStopped(thread.id, "a1")).toBe(true);
    expect(ax.subagentStopped(thread.id, "a1")).toBe(false);
    expect(ax.listEntries("demo")).toHaveLength(before);
  });

  it("drops announced calls that never started after a while", () => {
    const { thread } = topicWithThread(ax);
    ax.queueSubagentCall(thread.id, { title: "Denied", agentType: "general-purpose" });
    clock.advanceMs(31 * 60_000);
    ax.queueSubagentCall(thread.id, { title: "Fresh", agentType: "general-purpose" });
    ax.subagentStarted(thread.id, "a1", "general-purpose");
    expect(ax.listSubagents().get(thread.id)?.[0]?.title).toBe("Fresh");
  });

  it("a stop keeps the subagents it lists, clears the rest, and leaves unknown ids alone", () => {
    const { thread } = topicWithThread(ax);
    for (const k of ["a1", "a2"]) ax.subagentStarted(thread.id, k, "general-purpose");
    // Ids of another kind than ours: nothing to compare, nothing removed.
    expect(ax.keepSubagents(thread.id, ["x9"])).toBe(false);
    expect(ax.listSubagents().get(thread.id)).toHaveLength(2);
    expect(ax.keepSubagents(thread.id, ["a2"])).toBe(true);
    expect(
      ax
        .listSubagents()
        .get(thread.id)
        ?.map((s) => s.key),
    ).toEqual(["a2"]);
    expect(ax.keepSubagents(thread.id, [])).toBe(true);
    expect(ax.listSubagents().has(thread.id)).toBe(false);
  });

  it("ending a thread forgets its subagents", () => {
    const { thread } = topicWithThread(ax);
    ax.subagentStarted(thread.id, "a1", "Explore");
    ax.threadEnded(thread.id, "done");
    expect(ax.listSubagents().has(thread.id)).toBe(false);
  });

  it("replaces a provider's subagent list, writing only differences", () => {
    const { thread } = topicWithThread(ax);
    const one = {
      key: "s1",
      title: "Explore",
      agentType: null,
      model: "claude-haiku-5",
      progress: "Reading",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(ax.setSubagents(thread.id, [one])).toBe(true);
    expect(ax.setSubagents(thread.id, [one])).toBe(false);
    expect(ax.setSubagents(thread.id, [{ ...one, progress: "Writing" }])).toBe(true);
    expect(ax.listSubagents().get(thread.id)?.[0]?.progress).toBe("Writing");
    expect(ax.setSubagents(thread.id, [])).toBe(true);
    expect(ax.listSubagents().has(thread.id)).toBe(false);
  });

  it("lists threads whose reply has no summary, and overwrites the summary each time", () => {
    const { thread } = topicWithThread(ax);
    expect(ax.threadsNeedingSummary(10)).toEqual([]);
    ax.setThreadReply(thread.id, "one", "2026-01-01T00:00:00.000Z");
    expect(ax.threadsNeedingSummary(10).map((t) => t.id)).toEqual([thread.id]);
    ax.setThreadSummary(thread.id, { now: "n1", next: "x1" }, "2026-01-01T00:00:00.000Z");
    expect(ax.threadsNeedingSummary(10)).toEqual([]);
    expect(ax.getThread(thread.id)).toMatchObject({ summaryNow: "n1", summaryNext: "x1" });
    ax.setThreadReply(thread.id, "two", "2026-01-02T00:00:00.000Z");
    expect(ax.threadsNeedingSummary(10)).toHaveLength(1);
    ax.setThreadSummaryError(thread.id, "boom");
    expect(ax.getThread(thread.id).summaryError).toBe("boom");
    expect(ax.getThread(thread.id).summaryNow).toBe("n1"); // the old one stays until replaced
    ax.setThreadSummary(thread.id, { now: "n2", next: "Nothing" }, "2026-01-02T00:00:00.000Z");
    expect(ax.getThread(thread.id)).toMatchObject({ summaryNow: "n2", summaryError: null });
    expect(ax.threadsNeedingSummary(10)).toEqual([]);
    expect(ax.listEntries("demo").some((e) => /n1|n2/.test(e.body ?? ""))).toBe(false);
  });

  it("a new reply clears an old summary error; the limit applies, newest first", () => {
    const a = topicWithThread(ax, "a", "ta").thread;
    const b = topicWithThread(ax, "b", "tb").thread;
    ax.setThreadReply(a.id, "A", "2026-01-01T00:00:00.000Z");
    ax.setThreadSummaryError(a.id, "boom");
    ax.setThreadReply(b.id, "B", "2026-01-02T00:00:00.000Z");
    expect(ax.threadsNeedingSummary(1).map((t) => t.id)).toEqual([b.id]);
    ax.setThreadReply(a.id, "A2", "2026-01-03T00:00:00.000Z");
    expect(ax.getThread(a.id).summaryError).toBeNull();
  });

  it("favourite, hidden and order are owner only and per topic", () => {
    ax.createTopic({ slug: "a", title: "A" }, owner);
    ax.createTopic({ slug: "b", title: "B" }, owner);
    ax.createTopic({ slug: "c", title: "C" }, owner);
    expect(() => ax.setTopicFavorite("a", true, agent())).toThrow(AxiomError);
    expect(() => ax.setTopicDeskHidden("a", true, agent())).toThrow(AxiomError);
    expect(() => ax.setDeskOrder(["a"], agent())).toThrow(AxiomError);
    ax.setTopicFavorite("a", true, owner);
    ax.setTopicDeskHidden("b", true, owner);
    expect(ax.getTopic("a")).toMatchObject({ favorite: true, deskHidden: false });
    expect(ax.getTopic("b")).toMatchObject({ favorite: false, deskHidden: true });
    ax.setTopicFavorite("a", false, owner);
    expect(ax.getTopic("a").favorite).toBe(false);
    expect(() => ax.setTopicFavorite("missing", true, owner)).toThrow(/not found/);

    ax.setDeskOrder(["c", "a"], owner);
    const order = () => ["a", "b", "c"].map((s) => ax.getTopic(s).deskOrder);
    expect(order()).toEqual([1, null, 0]);
    ax.setDeskOrder(["b"], owner); // c and a keep their relative order after b
    expect(order()).toEqual([2, 0, 1]);
    expect(() => ax.setDeskOrder(["a", "a"], owner)).toThrow(/twice/);
    expect(() => ax.setDeskOrder(["a", "nope"], owner)).toThrow(/not found/);
    expect(order()).toEqual([2, 0, 1]); // a failed call changes nothing
  });
});

describe("permission approvals", () => {
  it("records a pending approval, waits on the owner, and keeps no full tool input", () => {
    const { thread } = topicWithThread(ax);
    const a = ax.requestApproval(thread.id, {
      toolName: "Bash",
      inputSummary: "$ rm -rf build\n  extra",
      hookPid: 4242,
    });
    expect(a).toMatchObject({
      toolName: "Bash",
      inputSummary: "$ rm -rf build extra",
      decidedAt: null,
      decision: null,
      hookPid: 4242,
    });
    expect(ax.pendingApprovals(thread.id).map((x) => x.id)).toEqual([a.id]);
    expect(ax.pendingApprovalCounts().get(thread.id)).toBe(1);
    expect(ax.getThread(thread.id)).toMatchObject({ status: "hitl", waitingOnOwner: true });
    expect(ax.listNotifications().map((n) => n.kind)).toEqual(["agent asked"]);
  });

  it("allow writes an authorization entry, deny an owner input entry; only the owner decides", () => {
    const { thread } = topicWithThread(ax);
    const a = ax.requestApproval(thread.id, { toolName: "Bash", inputSummary: "$ npm test" });
    expect(() => ax.decideApproval(a.id, "allow", undefined, agent(thread.id))).toThrow(AxiomError);
    const done = ax.decideApproval(a.id, "allow", undefined, owner);
    expect(done).toMatchObject({ decision: "allow" });
    expect(done.decidedAt).not.toBeNull();
    expect(ax.pendingApprovals(thread.id)).toEqual([]);
    const auth = ax.listEntries("demo").find((e) => e.kind === "authorization");
    expect(auth).toMatchObject({
      author: "owner",
      data: { scope: "Bash: $ npm test", standing: false },
    });
    expect(() => ax.decideApproval(a.id, "deny", undefined, owner)).toThrow(/already decided/);

    const b = ax.requestApproval(thread.id, { toolName: "Write", inputSummary: "Editing a.ts" });
    const denied = ax.decideApproval(b.id, "deny", "not that file", owner);
    expect(denied).toMatchObject({ decision: "deny", message: "not that file" });
    const input = ax.listEntries("demo").filter((e) => e.kind === "owner input");
    expect(input.at(-1)?.body).toBe("Denied Write: Editing a.ts: not that file");
  });

  it("expiring keeps a decision and closes an undecided approval", () => {
    const { thread } = topicWithThread(ax);
    const a = ax.requestApproval(thread.id, { toolName: "Bash", inputSummary: "$ ls" });
    ax.expireApproval(a.id);
    expect(ax.getApproval(a.id)).toMatchObject({ decision: "expired" });
    expect(() => ax.decideApproval(a.id, "allow", undefined, owner)).toThrow(/already decided/);
    const b = ax.requestApproval(thread.id, { toolName: "Bash", inputSummary: "$ ls" });
    ax.decideApproval(b.id, "allow", undefined, owner);
    ax.expireApproval(b.id);
    expect(ax.getApproval(b.id).decision).toBe("allow");
    expect(() => ax.getApproval(999)).toThrow(/not found/);
  });

  it("approvalTimeoutSec defaults to 600 and is validated", () => {
    expect(ax.getSetting("approvalTimeoutSec")).toBe(600);
    ax.setSetting("approvalTimeoutSec", 120, owner);
    expect(ax.getSetting("approvalTimeoutSec")).toBe(120);
    expect(() => ax.setSetting("approvalTimeoutSec", 5, owner)).toThrow(AxiomError);
    expect(() => ax.setSetting("approvalTimeoutSec", 9999, owner)).toThrow(AxiomError);
  });
});
