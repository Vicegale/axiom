import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDatabasePath, migrate, openDatabase } from "./index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-core-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TABLES = [
  "approval",
  "entry",
  "epic",
  "link",
  "monitor_target",
  "notification",
  "setting",
  "steward_action",
  "steward_chat",
  "steward_item",
  "steward_memory",
  "steward_message",
  "steward_pr_snapshot",
  "steward_run",
  "steward_state",
  "steward_suggestion",
  "steward_wake",
  "subagent",
  "subagent_call",
  "task",
  "task_dependency",
  "thread",
  "ticket",
  "ticket_epic",
  "topic",
  "topic_epic",
  "topic_ticket",
];

describe("opening", () => {
  it("creates the parent directory, uses WAL, sets pragmas and creates every table", () => {
    const path = join(dir, "nested", "deeper", "axiom.db");
    const ax = openDatabase(path);
    const pragma = (name: string) =>
      Object.values(ax.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("foreign_keys")).toBe(1);
    expect(pragma("busy_timeout")).toBe(5000);
    expect(pragma("user_version")).toBe(14);
    const names = (
      ax.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(TABLES);
    ax.close();
  });

  it("reopening is a no-op and keeps data", () => {
    const path = join(dir, "axiom.db");
    const a = openDatabase(path);
    a.createTopic({ slug: "keep", title: "keep" }, { kind: "owner" });
    a.close();
    const b = openDatabase(path);
    expect(b.getTopic("keep").title).toBe("keep");
    expect(Object.values(b.db.prepare("PRAGMA user_version").get() as object)[0]).toBe(14);
    b.close();
  });

  it("migrate() skips migrations at or below the current version and applies newer ones once", () => {
    const db = new DatabaseSync(join(dir, "m.db"));
    const migrations = [
      { version: 1, sql: "CREATE TABLE a (x)" },
      { version: 2, sql: "CREATE TABLE b (x)" },
    ];
    expect(migrate(db, migrations)).toBe(2);
    expect(migrate(db, migrations)).toBe(2);
    db.close();
  });

  it("upgrades a version 2 database: links gain a nullable description and keep their rows", () => {
    const path = join(dir, "v2.db");
    const raw = new DatabaseSync(path);
    const read = (f: string) =>
      readFileSync(fileURLToPath(new URL(`../migrations/${f}`, import.meta.url)), "utf8");
    migrate(raw, [
      { version: 1, sql: read("0001_init.sql") },
      { version: 2, sql: read("0002_tasks.sql") },
    ]);
    raw.exec(
      "INSERT INTO topic (slug, title, created_at, last_worked_at) VALUES ('t', 't', 'x', 'x')",
    );
    raw.exec(
      "INSERT INTO link (topic_id, kind, target, label, created_at) VALUES (1, 'artifact', 'a.md', 'A', 'x')",
    );
    raw.close();
    const ax = openDatabase(path);
    expect(Object.values(ax.db.prepare("PRAGMA user_version").get() as object)[0]).toBe(14);
    const links = ax.getTopic("t").links;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ label: "A", description: null });
    expect(
      ax.updateLink("t", links[0].id, { description: "d" }, { kind: "owner" }).description,
    ).toBe("d");
    ax.close();
  });

  it("upgrades a version 3 database: threads and topics gain the Desk columns and keep their rows", () => {
    const path = join(dir, "v3.db");
    const raw = new DatabaseSync(path);
    const read = (f: string) =>
      readFileSync(fileURLToPath(new URL(`../migrations/${f}`, import.meta.url)), "utf8");
    migrate(raw, [
      { version: 1, sql: read("0001_init.sql") },
      { version: 2, sql: read("0002_tasks.sql") },
      { version: 3, sql: read("0003_link_description.sql") },
    ]);
    raw.exec(
      "INSERT INTO topic (slug, title, created_at, last_worked_at) VALUES ('t', 'T', 'x', 'x')",
    );
    raw.exec(
      `INSERT INTO thread (topic_id, provider, provider_thread_id, status_changed_at, started_at)
       VALUES (1, 'claude-code', 's1', 'x', 'x')`,
    );
    raw.close();
    const ax = openDatabase(path);
    expect(Object.values(ax.db.prepare("PRAGMA user_version").get() as object)[0]).toBe(14);
    const t = ax.getTopic("t");
    expect(t).toMatchObject({ title: "T", favorite: false, deskHidden: false, deskOrder: null });
    expect(t.threads[0]).toMatchObject({
      providerThreadId: "s1",
      lastReply: null,
      lastReplyAt: null,
      summaryNow: null,
      summaryNext: null,
      summaryAt: null,
      summaryReplyAt: null,
      summaryError: null,
    });
    ax.setThreadReply(t.threads[0].id, "hello");
    expect(ax.getThread(t.threads[0].id).lastReply).toBe("hello");
    ax.close();
  });

  it("upgrades a version 9 database: entries and notifications keep their rows and accept the new values", () => {
    const path = join(dir, "v9.db");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = ON");
    const files = [
      "0001_init.sql",
      "0002_tasks.sql",
      "0003_link_description.sql",
      "0004_desk.sql",
      "0005_activity.sql",
      "0006_approvals.sql",
      "0007_runtime.sql",
      "0008_subagents.sql",
      "0009_subagent_tree.sql",
    ];
    migrate(
      raw,
      files.map((f, i) => ({
        version: i + 1,
        sql: readFileSync(fileURLToPath(new URL(`../migrations/${f}`, import.meta.url)), "utf8"),
      })),
    );
    raw.exec(
      "INSERT INTO topic (slug, title, created_at, last_worked_at) VALUES ('t', 'T', 'x', 'x')",
    );
    raw.exec(
      `INSERT INTO thread (topic_id, provider, provider_thread_id, status_changed_at, started_at)
       VALUES (1, 'claude-code', 's1', 'x', 'x')`,
    );
    raw.exec(
      `INSERT INTO entry (id, topic_id, at, author, thread_id, kind, body, data, refs, corrects_entry_id)
       VALUES (5, 1, '2026-01-01T00:00:00.000Z', 'agent', 1, 'finding', 'first', '{"subtype":"x"}', '[]', NULL),
              (7, 1, '2026-01-02T00:00:00.000Z', 'owner', NULL, 'note', 'fixes it', NULL, '[]', 5)`,
    );
    raw.exec(
      `INSERT INTO notification (id, topic_id, thread_id, kind, body, created_at, dismissed_at)
       VALUES (3, 1, 1, 'agent stopped', 'stopped', 'x', NULL), (4, 1, NULL, 'error', 'bad', 'x', 'y')`,
    );
    raw.close();

    const ax = openDatabase(path);
    expect(Object.values(ax.db.prepare("PRAGMA user_version").get() as object)[0]).toBe(14);
    expect(ax.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const entries = ax.listEntries("t");
    expect(entries.map((e) => [e.id, e.author, e.body, e.threadId, e.correctsEntryId])).toEqual([
      [5, "agent", "first", 1, null],
      [7, "owner", "fixes it", null, 5],
    ]);
    expect(entries[0].data).toEqual({ subtype: "x" });
    expect(
      ax.listNotifications({ includeDismissed: true }).map((n) => [n.id, n.kind, n.dismissedAt]),
    ).toEqual([
      [4, "error", "y"],
      [3, "agent stopped", null],
    ]);
    const indexes = (table: string) =>
      (
        ax.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
          .all(table) as { name: string }[]
      ).map((r) => r.name);
    expect(indexes("entry")).toContain("entry_topic");
    expect(indexes("notification")).toContain("notification_topic");
    // The widened constraints, and the rest of the schema still holds.
    const note = ax.addEntry("t", { kind: "note", body: "from Steward" }, { kind: "steward" });
    expect(note.author).toBe("steward");
    expect(note.id).toBeGreaterThan(7);
    ax.raiseNotification("t", "steward urgent", "CI failed", { kind: "axiom" });
    expect(() =>
      ax.db.exec(
        "INSERT INTO entry (topic_id, at, author, kind) VALUES (1, 'x', 'nobody', 'note')",
      ),
    ).toThrow(/CHECK/);
    expect(ax.getTopic("t").threads[0]).toMatchObject({ providerThreadId: "s1" });
    expect(ax.getTopic("t").stewardEnabled).toBe(true);
    // Deleting the topic still cascades to its entries and notifications.
    ax.db.exec("DELETE FROM topic WHERE id = 1");
    expect(ax.db.prepare("SELECT COUNT(*) AS n FROM entry").get()).toEqual({ n: 0 });
    expect(ax.db.prepare("SELECT COUNT(*) AS n FROM notification").get()).toEqual({ n: 0 });
    ax.close();
  });

  it("rolls back a failing migration", () => {
    const db = new DatabaseSync(join(dir, "f.db"));
    expect(() =>
      migrate(db, [{ version: 1, sql: "CREATE TABLE a (x); CREATE TABLE a (x);" }]),
    ).toThrow();
    expect(Object.values(db.prepare("PRAGMA user_version").get() as object)[0]).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").all()).toHaveLength(0);
    db.close();
  });

  it("upgrades a version 8 database: a running subagent keeps its row, as running and unparented", () => {
    const path = join(dir, "v8.db");
    const raw = new DatabaseSync(path);
    const migrations = [
      "0001_init.sql",
      "0002_tasks.sql",
      "0003_link_description.sql",
      "0004_desk.sql",
      "0005_activity.sql",
      "0006_approvals.sql",
      "0007_runtime.sql",
      "0008_subagents.sql",
    ].map((f, i) => ({
      version: i + 1,
      sql: readFileSync(fileURLToPath(new URL(`../migrations/${f}`, import.meta.url)), "utf8"),
    }));
    migrate(raw, migrations);
    raw.exec(
      "INSERT INTO topic (slug, title, created_at, last_worked_at) VALUES ('t', 'T', 'x', 'x')",
    );
    raw.exec(
      `INSERT INTO thread (topic_id, provider, provider_thread_id, status_changed_at, started_at)
       VALUES (1, 'claude-code', 's1', 'x', 'x')`,
    );
    raw.exec("INSERT INTO subagent (thread_id, key, started_at) VALUES (1, 'a1', 'x')");
    raw.close();
    const ax = openDatabase(path);
    expect(ax.listSubagents().get(1)).toMatchObject([
      { key: "a1", status: "running", endedAt: null, parentKey: null },
    ]);
    ax.close();
  });

  it("opens the same file from several processes at once and migrates once", async () => {
    const path = join(dir, "race.db");
    const script = fileURLToPath(new URL("./test-open-child.ts", import.meta.url));
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", script, path], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => {
          out += d;
        });
        child.stderr.on("data", (d) => {
          err += d;
        });
        child.on("close", (code) =>
          code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)),
        );
      });
    const results = await Promise.all(Array.from({ length: 6 }, run));
    expect(results).toEqual(Array(6).fill("14 wal"));
    const ax = openDatabase(path);
    expect(Object.values(ax.db.prepare("PRAGMA user_version").get() as object)[0]).toBe(14);
    ax.close();
  }, 60_000);
});

describe("defaultDatabasePath", () => {
  it("prefers AXIOM_DB, then XDG_DATA_HOME, then ~/.local/share", () => {
    expect(defaultDatabasePath({ AXIOM_DB: "/x/y.db", XDG_DATA_HOME: "/z" })).toBe("/x/y.db");
    expect(defaultDatabasePath({ XDG_DATA_HOME: "/z" })).toBe("/z/axiom/axiom.db");
    expect(defaultDatabasePath({})).toMatch(/\.local\/share\/axiom\/axiom\.db$/);
  });
});
