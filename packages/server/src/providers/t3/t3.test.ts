import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { T3_VERSION, T3Fixture } from "../../test-t3.js";
import { T3Provider } from "./provider.js";
import { readT3Meta, T3Db } from "./reader.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const owner: Actor = { kind: "owner" };

let root: string;
let ax: Axiom;
let t3: T3Fixture;
let provider: T3Provider;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "axiom-t3-"));
  ax = openDatabase(join(root, "axiom.db"));
  t3 = new T3Fixture(join(root, "t3"));
  provider = new T3Provider({ ax, dir: t3.dir });
});
afterEach(() => {
  t3.close();
  ax.close();
  rmSync(root, { recursive: true, force: true });
});

function attach(id: string, slug = `topic-${id}`) {
  ax.createTopic({ slug, title: slug }, owner);
  return ax.attachThread(slug, { provider: "t3", providerThreadId: id }, owner);
}
const thread = (id: string) => ax.findThread({ provider: "t3", providerThreadId: id });
const topicStatus = (id: string) => ax.getTopic(`topic-${id}`).status;
const events = (id: string) =>
  ax
    .listEntries(`topic-${id}`)
    .filter((e) => e.kind === "thread event")
    .map((e) => (e.data as { event: string }).event);

describe("reader", () => {
  it("reads the meta files", () => {
    expect(readT3Meta(t3.dir)).toEqual({
      serverVersion: T3_VERSION,
      port: 3999,
      environmentId: "env-test",
    });
    expect(readT3Meta(join(root, "nowhere"))).toEqual({
      serverVersion: null,
      port: null,
      environmentId: null,
    });
  });

  it("maps runs and sessions to session statuses", () => {
    const cases: [string | null, string | null, string][] = [
      [null, null, "idle"],
      [null, "stopped", "stopped"],
      [null, "error", "error"],
      ["preparing", null, "starting"],
      ["queued", "ready", "starting"],
      ["starting", null, "starting"],
      ["running", "running", "running"],
      ["waiting", "waiting", "running"],
      ["completed", "ready", "ready"],
      ["completed", "stopped", "ready"],
      ["failed", "error", "error"],
      ["interrupted", "ready", "interrupted"],
      ["cancelled", "ready", "interrupted"],
    ];
    const db = T3Db.open(t3.dir);
    try {
      cases.forEach(([run, session, want], i) => {
        const id = `t${i}`;
        t3.thread(id);
        if (run) t3.run(id, 1, run);
        if (session) t3.session(id, session);
        expect(db.thread(id, null)?.status, `${run}/${session}`).toBe(want);
      });
    } finally {
      db.close();
    }
  });

  it("uses the newest run, reads the last error and the pending request text", () => {
    t3.thread("a").run("a", 1, "failed").run("a", 2, "running").session("a", "running", "boom");
    const q = t3.request("a", "user_input", "Which database?");
    t3.request("a", "command", "Run rm -rf build?");
    t3.thread("b").request("b", "command", null);
    const db = T3Db.open(t3.dir);
    try {
      const a = db.thread("a", "env-test");
      expect(a?.status).toBe("running");
      expect(a?.lastError).toBe("boom");
      expect(a?.environmentId).toBe("env-test");
      expect(a?.pendingRequests.map((r) => r.text)).toEqual([
        "Which database?",
        "Run rm -rf build?",
      ]);
      expect(db.thread("b", null)?.pendingRequests[0]?.text).toBe("Approval requested");
      t3.resolve(q);
      expect(db.thread("a", null)?.pendingRequests).toHaveLength(1);
      expect(db.thread("nope", null)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("lists live non-subagent threads, newest first, minus excluded ones, with a limit", () => {
    t3.thread("old", { updatedAt: "2026-11-20T00:00:00.000Z" });
    t3.thread("new", { updatedAt: "2026-11-25T09:00:00.000Z" });
    t3.thread("mid", { updatedAt: "2026-11-22T00:00:00.000Z" }).request("mid", "user_input", "?");
    t3.thread("sub", { subagent: true });
    t3.thread("gone", { deleted: true });
    t3.thread("arch", { archived: true });
    const db = T3Db.open(t3.dir);
    try {
      const all = db.listThreads("env-test");
      expect(all.map((t) => t.id)).toEqual(["new", "mid", "old"]);
      expect(all[1]).toEqual({
        id: "mid",
        title: "Synthetic mid",
        environmentId: "env-test",
        status: "waiting",
        updatedAt: "2026-11-22T00:00:00.000Z",
      });
      expect(db.listThreads(null, { exclude: new Set(["new"]) }).map((t) => t.id)).toEqual([
        "mid",
        "old",
      ]);
      expect(db.listThreads(null, { limit: 1 })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("opens the database read-only", () => {
    const db = T3Db.open(t3.dir);
    try {
      // @ts-expect-error the handle is private; reaching in proves the connection cannot write
      expect(() => db.db.exec("DELETE FROM effect_sql_migrations")).toThrow(/readonly/i);
    } finally {
      db.close();
    }
  });
});

describe("sync transitions", () => {
  it("running becomes working, and ready afterwards becomes stopped (idle topic, notification)", () => {
    t3.thread("a");
    attach("a");
    expect(provider.sync()).toBe(0); // idle in T3, idle in Axiom
    t3.run("a", 1, "running");
    expect(provider.sync()).toBe(1);
    expect(thread("a")?.status).toBe("wip");
    expect(topicStatus("a")).toBe("wip");
    t3.run("a", 1, "completed").session("a", "ready");
    expect(provider.sync()).toBe(1);
    expect(thread("a")?.status).toBe("idle");
    expect(topicStatus("a")).toBe("idle");
    expect(events("a")).toEqual(["working", "stopped"]);
    expect(ax.listNotifications().map((n) => n.kind)).toEqual(["agent stopped"]);
  });

  it("a pending approval becomes waiting on the owner (hitl) with its text, and stays hitl after stop", () => {
    t3.thread("a").run("a", 1, "running");
    attach("a");
    provider.sync();
    const req = t3.request("a", "command", "Run npm publish?");
    t3.run("a", 1, "waiting");
    expect(provider.sync()).toBe(1);
    expect(topicStatus("a")).toBe("hitl");
    const note = ax.listNotifications().find((n) => n.kind === "agent asked");
    expect(note?.body).toBe("Run npm publish?");
    // answered: the run goes on, then stops; the stop table keeps hitl
    t3.resolve(req).run("a", 1, "running");
    expect(provider.sync()).toBe(1);
    expect(topicStatus("a")).toBe("wip");
    t3.run("a", 1, "completed");
    provider.sync();
    expect(topicStatus("a")).toBe("idle");
  });

  it("a question that is still open when the run stops keeps the topic hitl", () => {
    t3.thread("a").run("a", 1, "running");
    attach("a");
    provider.sync();
    t3.request("a", "user_input", "Which way?");
    provider.sync();
    t3.run("a", 1, "completed");
    expect(provider.sync()).toBe(0);
    expect(topicStatus("a")).toBe("hitl");
  });

  it("a failed run becomes an error with the last error", () => {
    t3.thread("a").run("a", 1, "running");
    attach("a");
    provider.sync();
    t3.run("a", 1, "failed").session("a", "error", "provider crashed");
    expect(provider.sync()).toBe(1);
    expect(thread("a")?.status).toBe("error");
    expect(topicStatus("a")).toBe("error");
    expect(ax.listNotifications().find((n) => n.kind === "error")?.body).toBe("provider crashed");
  });

  it("ignores an error that predates the attach", () => {
    t3.thread("a", { updatedAt: "2020-01-01T00:00:00.000Z" })
      .run("a", 1, "failed")
      .session("a", "error", "old");
    attach("a");
    expect(provider.sync()).toBe(0);
    expect(topicStatus("a")).toBe("idle");
  });

  it("does not repeat events across ticks or across a restart", () => {
    t3.thread("a").run("a", 1, "running");
    attach("a");
    expect(provider.sync()).toBe(1);
    expect(provider.sync()).toBe(0);
    expect(provider.sync()).toBe(0);
    const restarted = new T3Provider({ ax, dir: t3.dir });
    expect(restarted.sync()).toBe(0);
    t3.run("a", 1, "completed");
    expect(restarted.sync()).toBe(1);
    expect(new T3Provider({ ax, dir: t3.dir }).sync()).toBe(0);
    expect(events("a")).toEqual(["working", "stopped"]);
  });

  it("a thread deleted or archived in T3, or missing from it, ends", () => {
    t3.thread("del").thread("arch").thread("miss");
    for (const id of ["del", "arch", "miss"]) attach(id);
    t3.remove("del");
    t3.db
      .prepare(
        "UPDATE orchestration_v2_projection_threads SET archived_at = '2026-11-25T10:00:00.000Z' WHERE thread_id = 'arch'",
      )
      .run();
    t3.db.prepare("DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'miss'").run();
    expect(provider.sync()).toBe(3);
    for (const id of ["del", "arch", "miss"]) {
      expect(thread(id)?.endedAt).not.toBeNull();
      expect(thread(id)?.endReason).toBe("removed in T3");
    }
    expect(provider.sync()).toBe(0);
  });

  it("only touches threads of provider t3", () => {
    ax.createTopic({ slug: "cc", title: "cc" }, owner);
    ax.attachThread("cc", { provider: "claude-code", providerThreadId: "a" }, owner);
    t3.thread("a").run("a", 1, "running");
    expect(provider.sync()).toBe(0);
    expect(ax.findThread({ provider: "claude-code", providerThreadId: "a" })?.status).toBe("idle");
  });
});

describe("version pin and health", () => {
  it("is ok when the version and migration match the pin", () => {
    provider.sync();
    const h = provider.health();
    expect(h.state).toBe("ok");
    expect(h.serverVersion).toBe(T3_VERSION);
    expect(h.migration).toBe(98);
    expect(h.pinned).toEqual({ serverVersion: T3_VERSION, migration: 98 });
    expect(h.lastReadAt).not.toBeNull();
    expect(h.detail).toBeNull();
  });

  it("is untested-version, still syncing, when the migration differs", () => {
    t3.db.prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'x')").run();
    t3.thread("a").run("a", 1, "running");
    attach("a");
    expect(provider.sync()).toBe(1);
    const h = provider.health();
    expect(h.state).toBe("untested-version");
    expect(h.migration).toBe(99);
    expect(h.detail).toMatch(/migration 99/);
  });

  it("is untested-version when the server version differs", () => {
    writeFileSync(join(t3.dir, "server-runtime.json"), JSON.stringify({ serverVersion: "9.9.9" }));
    provider.sync();
    expect(provider.health().state).toBe("untested-version");
    expect(provider.health().serverVersion).toBe("9.9.9");
  });

  it("honours a changed pin setting", () => {
    ax.setSetting("t3Pin", { serverVersion: "9.9.9", migration: 1 }, owner);
    provider.sync();
    expect(provider.health().state).toBe("untested-version");
    expect(provider.health().pinned).toEqual({ serverVersion: "9.9.9", migration: 1 });
  });

  it("is unavailable when the folder or database is missing, then recovers", () => {
    const missing = new T3Provider({ ax, dir: join(root, "nowhere") });
    expect(missing.sync()).toBe(0);
    expect(missing.health().state).toBe("unavailable");
    expect(missing.health().detail).toMatch(/not found/);
    expect(missing.health().lastReadAt).toBeNull();
    provider.sync();
    expect(provider.health().state).toBe("ok");
    t3.db.exec("DROP TABLE orchestration_v2_projection_runs");
    expect(provider.sync()).toBe(0);
    expect(provider.health().state).toBe("unavailable");
    expect(provider.health().lastReadAt).not.toBeNull();
  });

  it("does not end threads while T3 is unavailable", () => {
    t3.thread("a");
    attach("a");
    const p = new T3Provider({ ax, dir: join(root, "nowhere") });
    expect(p.sync()).toBe(0);
    expect(thread("a")?.endedAt).toBeNull();
  });

  it("notices a refresh request newer than the last sync", async () => {
    provider.sync();
    expect(provider.refreshRequested()).toBe(false);
    await sleep(5);
    ax.requestProviderRefresh("t3");
    expect(provider.refreshRequested()).toBe(true);
    await sleep(5);
    provider.sync();
    expect(provider.refreshRequested()).toBe(false);
  });
});
