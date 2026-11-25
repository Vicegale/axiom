import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** The schema of the T3 tables Axiom reads, copied from a real T3 database (no rows). */
const SCHEMA = readFileSync(
  fileURLToPath(new URL("../test-fixtures/t3/schema.sql", import.meta.url)),
  "utf8",
);

export const T3_VERSION = "0.1.11-nightly.20261118.4890";

let seq = 0;

/** A synthetic T3 user-data folder: real schema, invented rows. Test code only. */
export class T3Fixture {
  readonly dir: string;
  readonly db: DatabaseSync;

  constructor(dir: string, options: { migration?: number; version?: string } = {}) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, "statev2.sqlite"));
    this.db.exec(SCHEMA);
    this.db
      .prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, 'synthetic')")
      .run(options.migration ?? 98);
    writeFileSync(
      join(dir, "server-runtime.json"),
      JSON.stringify({ version: 1, port: 3999, serverVersion: options.version ?? T3_VERSION }),
    );
    writeFileSync(join(dir, "environment-id"), "env-test\n");
  }

  thread(
    id: string,
    over: {
      title?: string;
      updatedAt?: string;
      archived?: boolean;
      deleted?: boolean;
      subagent?: boolean;
      /** The thread's `modelSelection` (synthetic): model id and its options, e.g. effort. */
      model?: string;
      options?: { id: string; value: unknown }[];
    } = {},
  ): this {
    this.db
      .prepare(
        `INSERT INTO orchestration_v2_projection_threads
           (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, archived_at, deleted_at, payload_json)
         VALUES (?, 'p1', ?, 'claude', 'full-access', 'default', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        over.title ?? `Synthetic ${id}`,
        "2026-11-25T08:00:00.000Z",
        over.updatedAt ?? "2026-11-25T09:00:00.000Z",
        over.archived ? "2026-11-25T09:30:00.000Z" : null,
        over.deleted ? "2026-11-25T09:30:00.000Z" : null,
        JSON.stringify({
          lineage: { relationshipToParent: over.subagent ? "subagent" : null },
          ...(over.model
            ? {
                modelSelection: {
                  instanceId: "claudeAgent",
                  model: over.model,
                  ...(over.options ? { options: over.options } : {}),
                },
              }
            : {}),
        }),
      );
    return this;
  }

  /** A T3 project (synthetic): live unless `archived` or `deleted`. */
  project(
    id: string,
    over: {
      title?: string;
      root?: string;
      model?: boolean;
      pinned?: boolean;
      archived?: boolean;
      deleted?: boolean;
    } = {},
  ): this {
    const stamp = "2026-11-25T09:30:00.000Z";
    this.db
      .prepare(
        `INSERT INTO projection_projects
           (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at,
            default_model_selection_json, pinned_at, archived_at)
         VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        over.title ?? `Project ${id}`,
        over.root ?? `/work/${id}`,
        stamp,
        stamp,
        over.deleted ? stamp : null,
        over.model ? JSON.stringify({ instanceId: "claudeAgent", model: "claude-opus-5-5" }) : null,
        over.pinned ? stamp : null,
        over.archived ? stamp : null,
      );
    return this;
  }

  touch(id: string, updatedAt: string): this {
    this.db
      .prepare("UPDATE orchestration_v2_projection_threads SET updated_at = ? WHERE thread_id = ?")
      .run(updatedAt, id);
    return this;
  }

  remove(id: string): this {
    this.db
      .prepare(
        "UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-11-25T10:00:00.000Z' WHERE thread_id = ?",
      )
      .run(id);
    return this;
  }

  /** Adds a run, or changes the status of the run with that ordinal. */
  run(threadId: string, ordinal: number, status: string): this {
    this.db
      .prepare(
        `INSERT INTO orchestration_v2_projection_runs
           (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
         VALUES (?, ?, ?, 'claude', ?, '2026-11-25T09:00:00.000Z', '{}')
         ON CONFLICT (thread_id, ordinal) DO UPDATE SET status = excluded.status`,
      )
      .run(`run-${threadId}-${ordinal}`, threadId, ordinal, status);
    return this;
  }

  session(threadId: string, status: string, lastError: string | null = null): this {
    const id = `sess-${threadId}`;
    this.db
      .prepare(
        `INSERT INTO orchestration_v2_projection_provider_sessions
           (provider_session_id, thread_id, provider, status, updated_at, payload_json)
         VALUES (?, ?, 'claude', ?, '2026-11-25T09:00:00.000Z', ?)
         ON CONFLICT (provider_session_id) DO UPDATE SET status = excluded.status,
           payload_json = excluded.payload_json`,
      )
      .run(id, threadId, status, JSON.stringify({ lastError }));
    this.db
      .prepare(
        "INSERT OR IGNORE INTO orchestration_v2_projection_provider_session_bindings VALUES (?, ?)",
      )
      .run(id, threadId);
    return this;
  }

  /** A pending approval (`command`) or question (`user_input`) with its text. */
  /** Points `server-runtime.json` at another port (a fake MCP server in tests). */
  setPort(port: number): this {
    writeFileSync(
      join(this.dir, "server-runtime.json"),
      JSON.stringify({ version: 1, port, serverVersion: T3_VERSION }),
    );
    return this;
  }

  request(
    threadId: string,
    kind: "command" | "user_input",
    text: string | null,
    /** Replaces the fields of the item payload after `requestId` (e.g. `questions`). */
    extra: Record<string, unknown> = {},
  ): string {
    const id = `req-${seq++}`;
    const node = `node-${id}`;
    this.db
      .prepare(
        `INSERT INTO orchestration_v2_projection_runtime_requests
           (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
         VALUES (?, ?, ?, ?, 'pending', '2026-11-25T09:00:00.000Z', '{}')`,
      )
      .run(id, threadId, node, kind);
    if (text !== null) {
      const payload =
        kind === "user_input"
          ? {
              requestId: id,
              questions: [{ id: "q1", header: "h", question: text, options: [] }],
              ...extra,
            }
          : { requestId: id, requestKind: "command", prompt: text, ...extra };
      this.db
        .prepare(
          `INSERT INTO orchestration_v2_projection_turn_items
             (turn_item_id, thread_id, node_id, ordinal, type, status, updated_at, payload_json)
           VALUES (?, ?, ?, 1, ?, 'waiting', '2026-11-25T09:00:00.000Z', ?)`,
        )
        .run(
          `item-${id}`,
          threadId,
          node,
          kind === "user_input" ? "user_input_request" : "approval_request",
          JSON.stringify(payload),
        );
    }
    return id;
  }

  /** A step of a thread (`type` and `payload` as T3 stores them); the ordinal sorts them. */
  item(
    threadId: string,
    ordinal: number,
    type: string,
    payload: Record<string, unknown> = {},
    updatedAt = "2026-11-25T09:00:00.000Z",
  ): this {
    this.db
      .prepare(
        `INSERT INTO orchestration_v2_projection_turn_items
           (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
         VALUES (?, ?, ?, ?, 'completed', ?, ?)`,
      )
      .run(
        `item-${seq++}`,
        threadId,
        ordinal,
        type,
        updatedAt,
        JSON.stringify({ type, ordinal, ...payload }),
      );
    return this;
  }

  /** A provider turn with its token usage (synthetic); the newest `startedAt` is the one read. */
  turn(
    threadId: string,
    ordinal: number,
    over: {
      startedAt?: string;
      model?: string;
      usedTokens?: number;
      maxTokens?: number;
      noUsage?: boolean;
    } = {},
  ): this {
    const usage =
      over.usedTokens === undefined || over.noUsage
        ? undefined
        : { usedTokens: over.usedTokens, ...(over.maxTokens ? { maxTokens: over.maxTokens } : {}) };
    this.db
      .prepare(
        `INSERT INTO orchestration_v2_projection_provider_turns
           (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, started_at,
            payload_json)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`,
      )
      .run(
        `turn-${seq++}`,
        threadId,
        `pt-${threadId}`,
        `node-${seq}`,
        ordinal,
        over.startedAt ?? `2026-11-25T09:00:${String(ordinal).padStart(2, "0")}.000Z`,
        JSON.stringify({
          ordinal,
          ...(over.model ? { model: over.model } : {}),
          ...(usage ? { tokenUsage: usage } : {}),
        }),
      );
    return this;
  }

  /** A subagent of a thread (synthetic); running unless `status` is terminal or `completedAt` is set. */
  subagent(
    threadId: string,
    id: string,
    over: {
      status?: string;
      title?: string;
      model?: string;
      progress?: string;
      startedAt?: string;
      completedAt?: string | null;
    } = {},
  ): this {
    const status = over.status ?? "running";
    const startedAt = over.startedAt ?? "2026-11-25T09:00:00.000Z";
    this.db
      .prepare(
        `INSERT INTO orchestration_v2_projection_subagents
           (subagent_id, thread_id, parent_node_id, provider, origin, status, started_at,
            completed_at, updated_at, payload_json)
         VALUES (?, ?, 'node-sub', 'claude', 'provider_native', ?, ?, ?, ?, ?)
         ON CONFLICT (subagent_id) DO UPDATE SET status = excluded.status,
           completed_at = excluded.completed_at, updated_at = excluded.updated_at,
           payload_json = excluded.payload_json`,
      )
      .run(
        id,
        threadId,
        status,
        startedAt,
        over.completedAt ?? null,
        startedAt,
        JSON.stringify({
          id,
          threadId,
          status,
          startedAt,
          ...(over.title ? { title: over.title } : {}),
          ...(over.model ? { model: over.model } : {}),
          ...(over.progress ? { progress: over.progress } : {}),
        }),
      );
    return this;
  }

  resolve(requestId: string): this {
    this.db
      .prepare(
        "UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved' WHERE runtime_request_id = ?",
      )
      .run(requestId);
    return this;
  }

  close(): void {
    this.db.close();
  }
}
