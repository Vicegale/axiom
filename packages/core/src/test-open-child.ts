// Helper for migrate.test.ts: opens the database given as argv[2] and prints "<user_version> <journal_mode>".
import { openDatabase } from "./index.js";

const ax = openDatabase(process.argv[2] as string);
const v = (ax.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const m = (ax.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
console.log(`${v} ${m}`);
ax.close();
