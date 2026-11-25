import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const BACKUP_KEEP = 7;
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BACKUP_NAME = /^axiom-\d{4}-\d{2}-\d{2}\.db$/;

export function backupDir(dbPath: string): string {
  return join(dirname(dbPath), "backups");
}

function backupNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => BACKUP_NAME.test(n))
      .sort();
  } catch {
    return [];
  }
}

/** Modification time (ms) of the newest backup, or null when there is none. */
export function newestBackupMs(dir: string): number | null {
  const newest = backupNames(dir).at(-1);
  return newest === undefined ? null : statSync(join(dir, newest)).mtimeMs;
}

/** `VACUUM INTO` a dated copy, then keep only the newest {@link BACKUP_KEEP}. Returns its path. */
export function runBackup(db: DatabaseSync, dir: string, now: Date): string {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `axiom-${now.toISOString().slice(0, 10)}.db`);
  rmSync(target, { force: true });
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  for (const name of backupNames(dir).slice(0, -BACKUP_KEEP))
    rmSync(join(dir, name), { force: true });
  return target;
}

/** Backs up when there is no backup yet or the newest is more than 24 h old. */
export function backupIfDue(db: DatabaseSync, dir: string, now: Date): string | null {
  const newest = newestBackupMs(dir);
  if (newest !== null && now.getTime() - newest < BACKUP_INTERVAL_MS) return null;
  return runBackup(db, dir, now);
}
