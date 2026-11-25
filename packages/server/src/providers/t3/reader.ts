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
 *   (`$.questions[]` for a question: `id`, `header`, `question`, `options[]` of `label` +
 *   `description`, `multiSelect`; `$.prompt` and `$.requestKind` for an approval): a request's
 *   text and, for questions, what the Desk card shows to answer.
 *   The same table holds a thread's step-by-step activity, read for the Desk card's live line:
 *   the newest row of the thread (`thread_id = ?`, highest `ordinal`: a main-thread item's ordinal
 *   is `run ordinal * 1000000 + n`, so it sorts across runs; index `..._thread_ordinal_idx`) whose
 *   `type` is one of `reasoning` (`$.text`), `command_execution` (`$.input`, the command line),
 *   `dynamic_tool` (`$.toolName`, `$.input` object, `$.title` e.g. `Read /path`), `file_change`
 *   (`$.fileName`), `web_search` (`$.patterns[]`), `subagent` (`$.title`). `updated_at` is the
 *   line's time. Other types (assistant text, checkpoints, todo lists, notices) are skipped.
 *
 * - Model, effort and context for the Desk card's indicator: the thread's `payload_json`
 *   `$.modelSelection.model` and the `$.modelSelection.options[]` entry whose `id` is `effort` or
 *   `reasoningEffort` (its `value`); and, from `orchestration_v2_projection_provider_turns`
 *   (`thread_id`, `started_at`, `ordinal`, `payload_json`), the newest turn that reports
 *   `$.tokenUsage.usedTokens` (with `$.tokenUsage.maxTokens` when known; `$.model` is the model the
 *   turn ran on, used when the thread names none).
 *
 * - `orchestration_v2_projection_subagents`: `subagent_id`, `thread_id`, `status`, `started_at`,
 *   `completed_at`, `updated_at`, `payload_json` (`$.title`, `$.model`, `$.progress` the latest
 *   step). Running = no `completed_at` and a status other than `completed`, `failed`, `cancelled`,
 *   `interrupted`.
 *
 * - `projection_projects`: `project_id`, `title`, `workspace_root`, `default_model_selection_json`
 *   (null or `null` when the project has no default model), `pinned_at`, `archived_at`,
 *   `deleted_at`. Read for the new-topic dialog's project select (live projects only).
 *
 * Everything else T3 stores is ignored. Any query error means the schema moved: the caller marks
 * the provider unavailable and tries again on the next tick.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describeToolUse, oneLine, type SubagentSnapshot } from "@axiom/core";

export type T3SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "ready"
  | "interrupted"
  | "stopped"
  | "error";

/** One question of a `user_input` request, as T3 stores it. */
export interface T3Question {
  /** The key of its answer (often the question text itself). */
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface T3Request {
  /** T3's runtime request id (what an answer is addressed to). */
  id: string;
  kind: string;
  text: string;
  /** The structured questions of a `user_input` request; empty for approvals. */
  questions: T3Question[];
  /** What an approval is about (`command`, `file-change`, ...), when T3 says. */
  requestKind: string | null;
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
  /** The newest run's id: a new id means the thread ran again, even if the run was too quick to see. */
  latestRunId: string | null;
  /** The newest step the agent took, as one short line, or null when there is none. */
  activity: { text: string; at: string } | null;
  /** Model, effort and context use, or null when T3 says nothing of them. */
  runtime: T3Runtime | null;
  /** The subagents running now (none once they complete, fail, are cancelled or interrupted). */
  subagents: SubagentSnapshot[];
}

/** What a T3 thread runs on; a field is null when T3 does not say. */
export interface T3Runtime {
  model: string | null;
  effort: string | null;
  contextUsed: number | null;
  contextMax: number | null;
}

export interface T3ThreadSummary {
  id: string;
  title: string;
  environmentId: string | null;
  status: T3SessionStatus | "waiting";
  updatedAt: string;
}

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  /** The project has a default model, so a new thread needs no model of its own. */
  hasDefaultModel: boolean;
  pinned: boolean;
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
  run_id: string | null;
}

/** Thread columns plus its newest run, newest bound session and pending-request count. */
const THREAD_SELECT = `
  SELECT t.thread_id, t.title, t.updated_at, t.archived_at, t.deleted_at,
    (SELECT r.status FROM orchestration_v2_projection_runs r
       WHERE r.thread_id = t.thread_id ORDER BY r.ordinal DESC, r.run_id DESC LIMIT 1) AS run_status,
    (SELECT r.run_id FROM orchestration_v2_projection_runs r
       WHERE r.thread_id = t.thread_id ORDER BY r.ordinal DESC, r.run_id DESC LIMIT 1) AS run_id,
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

const ACTIVITY_SQL = `SELECT type, updated_at, payload_json
  FROM orchestration_v2_projection_turn_items
  WHERE thread_id = ?
    AND type IN ('reasoning', 'command_execution', 'dynamic_tool', 'file_change', 'web_search', 'subagent')
  ORDER BY ordinal DESC LIMIT 1`;

const MODEL_SQL = `SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?`;

const CONTEXT_SQL = `SELECT json_extract(payload_json, '$.model') AS model,
    json_extract(payload_json, '$.tokenUsage.usedTokens') AS used,
    json_extract(payload_json, '$.tokenUsage.maxTokens') AS max
  FROM orchestration_v2_projection_provider_turns
  WHERE thread_id = ? AND json_valid(payload_json)
    AND json_extract(payload_json, '$.tokenUsage.usedTokens') IS NOT NULL
  ORDER BY started_at DESC, ordinal DESC LIMIT 1`;

// A subagent is running until T3 gives it a completion time or a terminal status; any other status
// (`running` is the one seen) counts, so a new in-flight status is not missed.
const SUBAGENTS_SQL = `SELECT subagent_id, started_at, updated_at, payload_json
  FROM orchestration_v2_projection_subagents
  WHERE thread_id = ? AND completed_at IS NULL
    AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
  ORDER BY started_at, subagent_id`;

const PROJECTS_SQL = `SELECT project_id, title, workspace_root, default_model_selection_json, pinned_at
  FROM projection_projects WHERE deleted_at IS NULL AND archived_at IS NULL
  ORDER BY (pinned_at IS NULL), title COLLATE NOCASE, project_id`;

function hasModelSelection(json: string | null): boolean {
  if (!json) return false;
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === "object" && v !== null && Object.keys(v).length > 0;
  } catch {
    return false;
  }
}

/** The thread's chosen model and effort from its payload (`$.modelSelection`); exported for tests. */
export function modelSelection(payload: unknown): { model: string | null; effort: string | null } {
  const sel = (payload as { modelSelection?: unknown } | null)?.modelSelection as
    | { model?: unknown; options?: unknown }
    | null
    | undefined;
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  let effort: string | null = null;
  if (Array.isArray(sel?.options)) {
    for (const o of sel.options as unknown[]) {
      const { id, value } = (o ?? {}) as { id?: unknown; value?: unknown };
      if ((id === "effort" || id === "reasoningEffort") && text(value)) {
        effort = text(value);
        break;
      }
    }
  }
  return { model: text(sel?.model), effort };
}

const THINKING_CHARS = 80;

function fileBase(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** The one-line wording of a turn item, or null when it has nothing to say. Exported for tests. */
export function activityLine(type: string, payload: unknown): string | null {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  switch (type) {
    case "command_execution": {
      const first = text(p.input)
        .split("\n")
        .find((l) => l.trim() !== "");
      return first ? oneLine(`$ ${first}`, 200) : "Running a command";
    }
    case "dynamic_tool": {
      if (text(p.toolName)) return describeToolUse(text(p.toolName), p.input);
      return text(p.title) ? oneLine(text(p.title), 200) : null;
    }
    case "file_change":
      return text(p.fileName) ? `Editing ${fileBase(text(p.fileName))}` : "Editing files";
    case "web_search":
      return "Searching the web";
    case "subagent":
      return text(p.title) ? oneLine(`Subagent: ${text(p.title)}`, 200) : "Subagent";
    case "reasoning": {
      const t = oneLine(text(p.text), THINKING_CHARS);
      return t ? `Thinking: ${t}` : "Thinking";
    }
    default:
      return null;
  }
}

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

const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 20;
const MAX_QUESTION_CHARS = 2000;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * The questions of a `user_input_request` payload (`questions[]`: `id`, `header`, `question`,
 * `options[]` of `label` + `description`, `multiSelect`). Entries without a question text or an
 * id are skipped; everything else is kept as is (capped). Exported for tests.
 */
export function parseQuestions(payload: unknown): T3Question[] {
  const list = (payload as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(list)) return [];
  const out: T3Question[] = [];
  for (const raw of list.slice(0, MAX_QUESTIONS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const q = raw as Record<string, unknown>;
    const question = str(q.question, MAX_QUESTION_CHARS);
    const id = typeof q.id === "string" && q.id !== "" ? q.id : question;
    if (!question || !id) continue;
    const options = Array.isArray(q.options)
      ? q.options.slice(0, MAX_OPTIONS).flatMap((o) => {
          const opt = (typeof o === "object" && o !== null ? o : {}) as Record<string, unknown>;
          const label = str(opt.label, 500);
          return label ? [{ label, description: str(opt.description, 1000) }] : [];
        })
      : [];
    out.push({
      id,
      header: str(q.header, 100),
      question,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return out;
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
    this.db.prepare(ACTIVITY_SQL);
    this.db.prepare(MODEL_SQL);
    this.db.prepare(CONTEXT_SQL);
    this.db.prepare(SUBAGENTS_SQL);
    this.db.prepare(PROJECTS_SQL);
  }

  /** Live (not deleted, not archived) projects: pinned first, then by title. */
  listProjects(): T3Project[] {
    const rows = this.db.prepare(PROJECTS_SQL).all() as {
      project_id: string;
      title: string;
      workspace_root: string;
      default_model_selection_json: string | null;
      pinned_at: string | null;
    }[];
    return rows.map((r) => ({
      id: r.project_id,
      title: r.title,
      workspaceRoot: r.workspace_root,
      hasDefaultModel: hasModelSelection(r.default_model_selection_json),
      pinned: r.pinned_at !== null,
    }));
  }

  /** The newest step of a thread as one line, with its time; null when it has taken none. */
  activity(threadId: string): { text: string; at: string } | null {
    const row = this.db.prepare(ACTIVITY_SQL).get(threadId) as
      | { type: string; updated_at: string; payload_json: string }
      | undefined;
    if (!row) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {}
    const text = activityLine(row.type, payload);
    return text ? { text, at: row.updated_at } : null;
  }

  /** The thread's model, effort and context use; null when T3 says nothing of them. */
  runtime(threadId: string): T3Runtime | null {
    let payload: unknown;
    const row = this.db.prepare(MODEL_SQL).get(threadId) as { payload_json: string } | undefined;
    try {
      payload = row ? JSON.parse(row.payload_json) : null;
    } catch {}
    const sel = modelSelection(payload);
    const turn = this.db.prepare(CONTEXT_SQL).get(threadId) as
      | { model: unknown; used: unknown; max: unknown }
      | undefined;
    const tokens = (v: unknown) => (typeof v === "number" && v > 0 ? Math.round(v) : null);
    const runtime: T3Runtime = {
      model: sel.model ?? (typeof turn?.model === "string" && turn.model ? turn.model : null),
      effort: sel.effort,
      contextUsed: typeof turn?.used === "number" && turn.used >= 0 ? Math.round(turn.used) : null,
      contextMax: tokens(turn?.max),
    };
    return Object.values(runtime).some((v) => v !== null) ? runtime : null;
  }

  /** The thread's subagents that are running now, oldest first. */
  subagents(threadId: string): SubagentSnapshot[] {
    const rows = this.db.prepare(SUBAGENTS_SQL).all(threadId) as {
      subagent_id: string;
      started_at: string | null;
      updated_at: string;
      payload_json: string;
    }[];
    return rows.map((r) => {
      let p: Record<string, unknown> = {};
      try {
        const v: unknown = JSON.parse(r.payload_json);
        if (typeof v === "object" && v !== null) p = v as Record<string, unknown>;
      } catch {}
      const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
      return {
        key: r.subagent_id,
        title: text(p.title),
        agentType: null,
        model: text(p.model) ?? text((p.modelSelection as { model?: unknown } | null)?.model),
        progress: text(p.progress),
        startedAt: r.started_at ?? text(p.startedAt) ?? r.updated_at,
      };
    });
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
      const requestKind = (payload as { requestKind?: unknown } | undefined)?.requestKind;
      return {
        id: r.runtime_request_id,
        kind: r.kind,
        text: requestText(r.kind, payload),
        questions: r.kind === "user_input" ? parseQuestions(payload) : [],
        requestKind: typeof requestKind === "string" ? requestKind : null,
      };
    });
  }

  /** The thread's pending approvals and questions, oldest first. */
  pendingRequests(threadId: string): T3Request[] {
    return this.pending(threadId);
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
      latestRunId: row.run_id ?? null,
      activity: removed ? null : this.activity(row.thread_id),
      runtime: removed ? null : this.runtime(row.thread_id),
      subagents: removed ? [] : this.subagents(row.thread_id),
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
