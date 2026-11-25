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
        }),
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
  request(threadId: string, kind: "command" | "user_input", text: string | null): string {
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
          ? { requestId: id, questions: [{ id: "q1", header: "h", question: text, options: [] }] }
          : { requestId: id, requestKind: "command", prompt: text };
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
