import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { type Clock, defaultDatabasePath, openDatabase } from "@axiom/core";
import { serve } from "@hono/node-server";
import { type AppContext, createApp } from "./app.js";
import { backupDir, backupIfDue } from "./backup.js";
import { ChangeBus } from "./events.js";

export { backupDir, backupIfDue, newestBackupMs, runBackup } from "./backup.js";
export type { InstallOptions, InstallResult } from "./install.js";
export { DEFAULT_PORT, installService, renderUnit } from "./install.js";

export interface StartServerOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  /** Folder with the built web app (default: packages/web/dist). */
  webDist?: string;
  now?: Clock;
  /** Maintenance (stale prompts, backup) interval; default one hour. */
  maintenanceMs?: number;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

const HOUR_MS = 60 * 60 * 1000;

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const dbPath = options.dbPath ?? defaultDatabasePath();
  const now = options.now ?? (() => new Date());
  const ax = openDatabase(dbPath, { now });
  const bus = new ChangeBus(ax.db, now);
  const streams = new Set<() => void>();
  const ctx: AppContext = {
    ax,
    bus,
    dbPath,
    webDist: options.webDist ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
    startedAt: now().toISOString(),
    streams,
  };
  const app = createApp(ctx);

  /** Stale prompts (hourly) and the daily backup; failures are logged, never fatal. */
  const maintain = () => {
    try {
      if (ax.refreshStalePrompts().length > 0) bus.emit();
    } catch (e) {
      console.error("stale-prompt refresh failed:", e);
    }
    try {
      mkdirSync(backupDir(dbPath), { recursive: true });
      backupIfDue(ax.db, backupDir(dbPath), now());
    } catch (e) {
      console.error("backup failed:", e);
    }
  };
  maintain();
  const timer = setInterval(maintain, options.maintenanceMs ?? HOUR_MS);

  const host = options.host ?? "127.0.0.1";
  let server: Server;
  try {
    server = await new Promise((resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: options.port ?? 0, hostname: host }, () =>
        resolve(s as Server),
      ) as Server;
      s.once("error", reject);
    });
  } catch (e) {
    clearInterval(timer);
    bus.stop();
    ax.close();
    throw e;
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);

  return {
    url: `http://${host}:${port}`,
    async close() {
      clearInterval(timer);
      bus.stop();
      for (const end of [...streams]) end();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      ax.close();
    },
  };
}
