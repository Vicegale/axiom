import type { Axiom, Thread } from "@axiom/core";
import { readT3Meta, T3Db, type T3ThreadState, type T3ThreadSummary } from "./reader.js";

export type T3HealthState = "ok" | "untested-version" | "unavailable";

/** The `t3` block of `GET /api/health` (ADR 0005). */
export interface T3Health {
  state: T3HealthState;
  /** Last successful read of T3's database. */
  lastReadAt: string | null;
  serverVersion: string | null;
  migration: number | null;
  pinned: { serverVersion: string; migration: number };
  /** Why the provider is unavailable, or what differs from the pin. */
  detail: string | null;
}

/** What to do to an Axiom thread to match T3's current state, or `null` for nothing. */
export type T3Action =
  | { kind: "working" }
  | { kind: "waiting"; text: string }
  | { kind: "stopped" }
  | { kind: "error"; message: string }
  | { kind: "ended" };

/**
 * Compares T3's state with the Axiom thread's own status and returns the one event that brings
 * them together. Only transitions produce an action, and "already applied" is read from the Axiom
 * thread (so a restart replays nothing). Pure.
 */
export function decide(
  th: Thread,
  state: T3ThreadState | null,
  runningSubagents = 0,
): T3Action | null {
  if (th.endedAt !== null) return null;
  if (state === null || state.removed) return { kind: "ended" };

  if (state.pendingRequests.length > 0) {
    if (th.status === "hitl" && th.waitingOnOwner) return null;
    const [first, ...rest] = state.pendingRequests;
    const text = (first?.text ?? "") + (rest.length ? ` (+${rest.length} more)` : "");
    return { kind: "waiting", text };
  }
  switch (state.status) {
    case "starting":
    case "running":
      return th.status === "wip" ? null : { kind: "working" };
    case "error":
      if (th.status === "error") return null;
      // An error from before the thread was attached is old news; one after it is not.
      if (th.status !== "wip" && state.updatedAt < th.startedAt) return null;
      return { kind: "error", message: state.lastError ?? "T3 thread error" };
    default: // idle, ready, stopped, interrupted
      // A turn that ended while its subagents still run has not stopped (01).
      if (runningSubagents > 0) return null;
      return th.status === "wip" ? { kind: "stopped" } : null;
  }
}

export interface T3ProviderOptions {
  ax: Axiom;
  dir: string;
  now?: () => Date;
}

/** Reads T3 and keeps the Axiom threads of provider `t3` in step with it. */
export class T3Provider {
  private readonly ax: Axiom;
  private readonly dir: string;
  private readonly now: () => Date;
  private current: T3Health;
  /** When the last sync began (epoch ms): a refresh request newer than this triggers another. */
  private lastSyncAt = 0;

  constructor(options: T3ProviderOptions) {
    this.ax = options.ax;
    this.dir = options.dir;
    this.now = options.now ?? (() => new Date());
    this.current = {
      state: "unavailable",
      lastReadAt: null,
      serverVersion: null,
      migration: null,
      pinned: this.pin(),
      detail: "not read yet",
    };
  }

  private pin(): { serverVersion: string; migration: number } {
    return this.ax.getSetting("t3Pin") as { serverVersion: string; migration: number };
  }

  health(): T3Health {
    return { ...this.current, pinned: this.pin() };
  }

  /** True when a hook asked for a re-read since the last sync began. */
  refreshRequested(): boolean {
    return this.ax.providerRefreshRequestedAt("t3") > this.lastSyncAt;
  }

  private unavailable(detail: string): void {
    this.current = { ...this.current, state: "unavailable", pinned: this.pin(), detail };
  }

  /** Opens the database and records health; null (with health set) when T3 cannot be read. */
  private open(): T3Db | null {
    let db: T3Db | undefined;
    try {
      db = T3Db.open(this.dir);
      db.probe();
      const migration = db.migration();
      const meta = readT3Meta(this.dir);
      const pin = this.pin();
      const same = meta.serverVersion === pin.serverVersion && migration === pin.migration;
      this.current = {
        state: same ? "ok" : "untested-version",
        lastReadAt: this.now().toISOString(),
        serverVersion: meta.serverVersion,
        migration,
        pinned: pin,
        detail: same
          ? null
          : `T3 is ${meta.serverVersion ?? "of unknown version"} at migration ${migration ?? "none"}; Axiom is tested against ${pin.serverVersion} at migration ${pin.migration}`,
      };
      return db;
    } catch (e) {
      db?.close();
      this.unavailable(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  /**
   * One tick: read T3, update health, and emit events for the attached threads that changed.
   * Returns how many events were applied. Never throws.
   */
  sync(): number {
    this.lastSyncAt = this.now().getTime();
    const db = this.open();
    if (!db) return 0;
    try {
      const threads = this.ax.listProviderThreads("t3").filter((t) => t.endedAt === null);
      const environmentId = readT3Meta(this.dir).environmentId;
      // Read everything first: a failing query leaves the Axiom threads untouched.
      const planned = threads.map((th) => ({
        th,
        action: decide(
          th,
          db.thread(th.providerThreadId, environmentId),
          this.ax.runningSubagents(th.id),
        ),
      }));
      let applied = 0;
      for (const { th, action } of planned) {
        if (!action) continue;
        switch (action.kind) {
          case "working":
            this.ax.threadWorking(th.id);
            break;
          case "waiting":
            this.ax.threadWaitingOnOwner(th.id, action.text);
            break;
          case "stopped":
            this.ax.threadStopped(th.id);
            break;
          case "error":
            this.ax.threadError(th.id, action.message);
            break;
          case "ended":
            this.ax.threadEnded(th.id, "removed in T3");
            break;
        }
        applied++;
      }
      return applied;
    } catch (e) {
      this.unavailable(e instanceof Error ? e.message : String(e));
      return 0;
    } finally {
      db.close();
    }
  }

  /** Live T3 threads for the picker, newest first. Throws when T3 cannot be read. */
  listThreads(options: { unattachedOnly: boolean; limit?: number }): T3ThreadSummary[] {
    const db = T3Db.open(this.dir);
    try {
      const exclude = options.unattachedOnly
        ? new Set(this.ax.listProviderThreads("t3").map((t) => t.providerThreadId))
        : undefined;
      return db.listThreads(readT3Meta(this.dir).environmentId, {
        exclude,
        limit: options.limit ?? 50,
      });
    } finally {
      db.close();
    }
  }
}
