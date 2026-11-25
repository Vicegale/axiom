import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Axiom, type Clock } from "./axiom.js";

export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AXIOM_DB) return env.AXIOM_DB;
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "axiom", "axiom.db");
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

interface Migration {
  version: number;
  sql: string;
}

function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .map((name) => /^(\d+)_.*\.sql$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ version: Number(m[1]), sql: readFileSync(join(dir, m[0]), "utf8") }))
    .sort((a, b) => a.version - b.version);
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/**
 * Applies pending migrations. Safe when several processes open the database at once: the
 * version is re-read after taking the write lock, so only the first one migrates.
 */
export function migrate(db: DatabaseSync, migrations: Migration[] = loadMigrations()): number {
  const target = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  if (userVersion(db) >= target) return userVersion(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = userVersion(db);
    for (const m of migrations) {
      if (m.version <= current) continue;
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return userVersion(db);
}

export interface OpenOptions {
  now?: Clock;
}

/** Opens (creating if needed) and migrates the database, and returns the Axiom API on it. */
export function openDatabase(path: string, options: OpenOptions = {}): Axiom {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return new Axiom(db, options.now);
}
