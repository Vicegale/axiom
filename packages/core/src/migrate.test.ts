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
  "entry",
  "epic",
  "link",
  "monitor_target",
  "notification",
  "setting",
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
    expect(pragma("user_version")).toBe(3);
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
    expect(Object.values(b.db.prepare("PRAGMA user_version").get() as object)[0]).toBe(3);
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
    expect(Object.values(ax.db.prepare("PRAGMA user_version").get() as object)[0]).toBe(3);
    const links = ax.getTopic("t").links;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ label: "A", description: null });
    expect(ax.updateLink("t", links[0].id, { description: "d" }, { kind: "owner" }).description).toBe(
      "d",
    );
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
    expect(results).toEqual(Array(6).fill("3 wal"));
    const ax = openDatabase(path);
    expect(Object.values(ax.db.prepare("PRAGMA user_version").get() as object)[0]).toBe(3);
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
