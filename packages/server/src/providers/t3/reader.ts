/**
 * Read-only access to T3's own state (ADR 0005, docs/spec/04). Nothing here ever writes to T3.
 *
 * Files (folder `~/.t3/userdata`, or `AXIOM_T3_DIR`):
 * - `server-runtime.json`: `serverVersion`, `port`.
 * - `environment-id`: the T3 environment id (one per install), when present.
 * - `statev2.sqlite` (WAL), opened with `readOnly: true`, short queries only.
 *
 * Tables and columns relied on (T3 server 0.1.11-nightly.20261118.4890, migration 98):
 * - `effect_sql_migrations.migration_id`: the latest migration id (`max`).
 * - `orchestration_v2_projection_threads`: `thread_id`, `title`, `updated_at`, `archived_at`,
 *   `deleted_at`, `payload_json` (`$.lineage.relationshipToParent`: `subagent` threads are not
 *   listed, they belong to their parent).
 * - `orchestration_v2_projection_runs`: `thread_id`, `ordinal`, `run_id`, `status`
 *   (`preparing|queued|starting|running|waiting|completed|interrupted|failed|cancelled|rolled_back`).
 *   The newest run (highest `ordinal`) says what the thread is doing, as T3's own sidebar does.
 * - `orchestration_v2_projection_provider_sessions`: `provider_session_id`, `status`, `updated_at`,
 *   `payload_json` (`$.lastError`), joined to a thread through
 * - `orchestration_v2_projection_provider_session_bindings`: `provider_session_id`, `thread_id`.
 * - `orchestration_v2_projection_runtime_requests`: `runtime_request_id`, `thread_id`, `node_id`,
 *   `kind` (`user_input|command|...`), `status` (`pending` is what we want), `created_at`.
 * - `orchestration_v2_projection_turn_items`: `node_id`, `type`
 *   (`user_input_request|approval_request`), `ordinal`, `payload_json`
 *   (`$.questions[].question` for a question, `$.prompt` for an approval): the text of a request.
 *
 * Everything else T3 stores is ignored. Any query error means the schema moved: the caller marks
 * the provider unavailable and tries again on the next tick.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type T3SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "ready"
  | "interrupted"
  | "stopped"
  | "error";

export interface T3Request {
  kind: string;
  text: string;
}

export interface T3ThreadState {
  id: string;
  title: string;
  environmentId: string | null;
  status: T3SessionStatus;
  lastError: string | null;
  updatedAt: string;
  /** The oldest-first pending approvals or questions; empty when nothing waits on the owner. */
  pendingRequests: T3Request[];
  /** Deleted or archived in T3. */
  removed: boolean;
}

export interface T3ThreadSummary {
  id: string;
  title: string;
  environmentId: string | null;
  status: T3SessionStatus | "waiting";
  updatedAt: string;
}

export interface T3Meta {
  serverVersion: string | null;
  port: number | null;
  environmentId: string | null;
}

const MAX_REQUEST_TEXT = 400;

export function t3Dir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AXIOM_T3_DIR || join(homedir(), ".t3", "userdata");
}

export function stateDbPath(dir: string): string {
  return join(dir, "statev2.sqlite");
}

function readText(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/** The small files next to the database. Missing or unreadable pieces come back as `null`. */
export function readT3Meta(dir: string): T3Meta {
  let serverVersion: string | null = null;
  let port: number | null = null;
  const raw = readText(join(dir, "server-runtime.json"));
  if (raw) {
    try {
      const j = JSON.parse(raw) as { serverVersion?: unknown; port?: unknown };
      if (typeof j.serverVersion === "string") serverVersion = j.serverVersion;
      if (typeof j.port === "number") port = j.port;
    } catch {}
  }
  return { serverVersion, port, environmentId: readText(join(dir, "environment-id")) };
}

interface ThreadRow {
  thread_id: string;
  title: string;
  updated_at: string;
  archived_at: string | null;
  deleted_at: string | null;
  run_status: string | null;
  session_status: string | null;
  last_error: string | null;
  pending_count: number;
}

/** Thread columns plus its newest run, newest bound session and pending-request count. */
const THREAD_SELECT = `
  SELECT t.thread_id, t.title, t.updated_at, t.archived_at, t.deleted_at,
    (SELECT r.status FROM orchestration_v2_projection_runs r
       WHERE r.thread_id = t.thread_id ORDER BY r.ordinal DESC, r.run_id DESC LIMIT 1) AS run_status,
    (SELECT s.status FROM orchestration_v2_projection_provider_sessions s
       JOIN orchestration_v2_projection_provider_session_bindings b
         ON b.provider_session_id = s.provider_session_id
       WHERE b.thread_id = t.thread_id
       ORDER BY s.updated_at DESC, s.provider_session_id DESC LIMIT 1) AS session_status,
    (SELECT json_extract(s.payload_json, '$.lastError')
       FROM orchestration_v2_projection_provider_sessions s
       JOIN orchestration_v2_projection_provider_session_bindings b
         ON b.provider_session_id = s.provider_session_id
       WHERE b.thread_id = t.thread_id
       ORDER BY s.updated_at DESC, s.provider_session_id DESC LIMIT 1) AS last_error,
    (SELECT count(*) FROM orchestration_v2_projection_runtime_requests q
       WHERE q.thread_id = t.thread_id AND q.status = 'pending') AS pending_count
  FROM orchestration_v2_projection_threads t`;

const PENDING_SQL = `SELECT runtime_request_id, node_id, kind
  FROM orchestration_v2_projection_runtime_requests
  WHERE thread_id = ? AND status = 'pending' ORDER BY created_at, runtime_request_id`;

const REQUEST_ITEM_SQL = `SELECT payload_json FROM orchestration_v2_projection_turn_items
  WHERE node_id = ? AND type IN ('user_input_request', 'approval_request') ORDER BY ordinal DESC`;

/** Maps T3's run and session statuses to the session statuses of the spec. */
export function sessionStatus(
  runStatus: string | null,
  sessionStatusValue: string | null,
): T3SessionStatus {
  switch (runStatus) {
    case "preparing":
    case "queued":
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "interrupted";
    case "completed":
      return sessionStatusValue === "error" ? "error" : "ready";
    default:
      // No run yet: the provider session alone says what we can.
      if (sessionStatusValue === "error") return "error";
      if (sessionStatusValue === "stopped") return "stopped";
      if (sessionStatusValue === "starting") return "starting";
      if (sessionStatusValue === "running") return "running";
      if (sessionStatusValue === "ready") return "ready";
      return "idle";
  }
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_REQUEST_TEXT ? `${one.slice(0, MAX_REQUEST_TEXT - 1)}…` : one;
}

function requestText(kind: string, payload: unknown): string {
  const p = (payload ?? {}) as { prompt?: unknown; questions?: { question?: unknown }[] };
  if (Array.isArray(p.questions)) {
    const qs = p.questions
      .map((q) => (typeof q.question === "string" ? q.question : ""))
      .filter(Boolean);
    if (qs.length) return clip(qs.join(" / "));
  }
  if (typeof p.prompt === "string" && p.prompt.trim()) return clip(p.prompt);
  return kind === "user_input" ? "The agent asked a question" : "Approval requested";
}

export class T3Db {
  private constructor(private readonly db: DatabaseSync) {}

  /** Opens the database read-only. Throws when the file is missing or unreadable. */
  static open(dir: string): T3Db {
    const path = stateDbPath(dir);
    if (!existsSync(path)) throw new Error(`T3 database not found: ${path}`);
    return new T3Db(new DatabaseSync(path, { readOnly: true, timeout: 1500 }));
  }

  close(): void {
    try {
      this.db.close();
    } catch {}
  }

  /** The latest migration id, or null when the table is empty. */
  migration(): number | null {
    const row = this.db
      .prepare("SELECT max(migration_id) AS m FROM effect_sql_migrations")
      .get() as {
      m: number | null;
    };
    return row.m;
  }

  /** Compiles every query against the live schema; throws when a table or column moved. */
  probe(): void {
    this.db.prepare(`${THREAD_SELECT} LIMIT 1`);
    this.db.prepare(PENDING_SQL);
    this.db.prepare(REQUEST_ITEM_SQL);
  }

  private pending(threadId: string): T3Request[] {
    const requests = this.db.prepare(PENDING_SQL).all(threadId) as {
      runtime_request_id: string;
      node_id: string;
      kind: string;
    }[];
    const items = this.db.prepare(REQUEST_ITEM_SQL);
    return requests.map((r) => {
      let payload: unknown;
      for (const row of items.all(r.node_id) as { payload_json: string }[]) {
        try {
          const p = JSON.parse(row.payload_json) as { requestId?: string };
          if (p.requestId === r.runtime_request_id) {
            payload = p;
            break;
          }
        } catch {}
      }
      return { kind: r.kind, text: requestText(r.kind, payload) };
    });
  }

  /** The state of one thread, or null when T3 has no such thread at all. */
  thread(id: string, environmentId: string | null): T3ThreadState | null {
    const row = this.db.prepare(`${THREAD_SELECT} WHERE t.thread_id = ?`).get(id) as
      | ThreadRow
      | undefined;
    if (!row) return null;
    const removed = row.deleted_at !== null || row.archived_at !== null;
    return {
      id: row.thread_id,
      title: row.title,
      environmentId,
      status: sessionStatus(row.run_status, row.session_status),
      lastError: typeof row.last_error === "string" ? row.last_error : null,
      updatedAt: row.updated_at,
      pendingRequests: row.pending_count > 0 ? this.pending(row.thread_id) : [],
      removed,
    };
  }

  /**
   * Live (not deleted, not archived, not subagent) threads, newest first, skipping `exclude`
   * (the ids already attached), at most `limit`.
   */
  listThreads(
    environmentId: string | null,
    options: { exclude?: ReadonlySet<string>; limit?: number } = {},
  ): T3ThreadSummary[] {
    const limit = options.limit ?? 50;
    const out: T3ThreadSummary[] = [];
    const rows = this.db
      .prepare(
        `${THREAD_SELECT}
         WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
           AND COALESCE(CASE WHEN json_valid(t.payload_json)
                 THEN json_extract(t.payload_json, '$.lineage.relationshipToParent') END, '') <> 'subagent'
         ORDER BY t.updated_at DESC, t.thread_id DESC`,
      )
      .iterate() as Iterable<ThreadRow>;
    for (const row of rows) {
      if (options.exclude?.has(row.thread_id)) continue;
      const status =
        row.pending_count > 0 ? "waiting" : sessionStatus(row.run_status, row.session_status);
      out.push({
        id: row.thread_id,
        title: row.title,
        environmentId,
        status,
        updatedAt: row.updated_at,
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}
