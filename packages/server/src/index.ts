import { mkdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Clock, defaultDatabasePath, openDatabase } from "@axiom/core";
import { serve } from "@hono/node-server";
import { type AppContext, createApp } from "./app.js";
import { backupDir, backupIfDue } from "./backup.js";
import { ChangeBus } from "./events.js";
import { T3Provider } from "./providers/t3/provider.js";
import { t3Dir } from "./providers/t3/reader.js";
import { defaultT3Cli, T3ReplyFetcher } from "./providers/t3/replies.js";
import { findClaude, SummaryWorker } from "./summaries.js";

export { backupDir, backupIfDue, newestBackupMs, runBackup } from "./backup.js";
export type { InstallOptions, InstallResult } from "./install.js";
export { DEFAULT_PORT, installService, renderUnit } from "./install.js";
export type { MainIo as ServerCliIo } from "./main.js";
export { main as runServerCli } from "./main.js";

export interface StartServerOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  /** Folder with the built web app (default: packages/web/dist). */
  webDist?: string;
  now?: Clock;
  /** Maintenance (stale prompts, backup) interval; default one hour. */
  maintenanceMs?: number;
  /** T3's user-data folder (default: AXIOM_T3_DIR or ~/.t3/userdata). */
  t3Dir?: string;
  /** How often the T3 provider reads T3; default 2 s. */
  t3PollMs?: number;
  /** The `t3` binary when the `t3Cli` setting is not set (default ~/.t3/bin/t3). */
  t3Cli?: string;
  /** The `claude` binary when the `claudeCli` setting is not set (default: found on PATH). */
  claudeCli?: string;
  /** Summary run timeout (default 60 s) and the wait before retrying a failure (default 10 min). */
  summaryTimeoutMs?: number;
  summaryRetryMs?: number;
  /** How long a detached `claude -p` reply is watched for an early failure (default 1.5 s). */
  sendGraceMs?: number;
  /** Replaces `fetch` for calls to T3's MCP endpoint (tests). */
  fetchImpl?: typeof fetch;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

const HOUR_MS = 60 * 60 * 1000;
const T3_POLL_MS = 2000;

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const dbPath = options.dbPath ?? defaultDatabasePath();
  const now = options.now ?? (() => new Date());
  const ax = openDatabase(dbPath, { now });
  const bus = new ChangeBus(ax.db, now);
  const streams = new Set<() => void>();
  const t3 = new T3Provider({ ax, dir: options.t3Dir ?? t3Dir(), now });
  const webDist = options.webDist ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
  const ctx: AppContext = {
    ax,
    bus,
    t3,
    dbPath,
    webDist,
    webBuildId: readBuildId(webDist),
    startedAt: now().toISOString(),
    streams,
    t3Cli: options.t3Cli,
    claudeCli: options.claudeCli ?? findClaude(),
    sendGraceMs: options.sendGraceMs,
    fetchImpl: options.fetchImpl,
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

  /** Syncs T3 now; tells the UI when threads changed. Never throws. */
  const replies = new T3ReplyFetcher(ax, () => {
    const s = ax.getSetting("t3Cli");
    return typeof s === "string" && s ? s : (options.t3Cli ?? defaultT3Cli());
  });
  const syncT3 = () => {
    try {
      if (t3.sync() > 0) bus.emit();
    } catch (e) {
      console.error("T3 sync failed:", e);
    }
    // Stopped T3 threads: fetch their latest reply (async; a run at a time).
    void replies.run().then((n) => {
      if (n > 0) bus.emit();
    });
  };
  syncT3();
  const t3Timer = setInterval(syncT3, options.t3PollMs ?? T3_POLL_MS);
  // A hook asked for an immediate re-read (it wrote a setting, which the bus noticed).
  const unsubscribeT3 = bus.subscribe(() => {
    if (t3.refreshRequested()) syncT3();
  });
  const summaries = new SummaryWorker({
    ax,
    bus,
    claudeCli: options.claudeCli ?? findClaude(),
    timeoutMs: options.summaryTimeoutMs,
    retryMs: options.summaryRetryMs,
    now,
  });
  summaries.start();
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
    clearInterval(t3Timer);
    unsubscribeT3();
    summaries.stop();
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
      clearInterval(t3Timer);
      unsubscribeT3();
      summaries.stop();
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

/** The web build the server saw when it started (see vite.config.ts); null when there's no build. */
function readBuildId(webDist: string): string | null {
  try {
    return readFileSync(join(webDist, "build-id.txt"), "utf8").trim() || null;
  } catch {
    return null;
  }
}
