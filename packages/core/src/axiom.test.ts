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
