-- Axiom 0008: working subagents of a thread (docs/plan/desk.md, slice D11).
-- `subagent` holds only the subagents running now (ephemeral: a row goes when the subagent stops,
-- no history). `key` is the provider's own id (Claude Code `agent_id`, T3 `subagent_id`).
-- `subagent_call` queues the Agent/Task tool calls Claude Code announced (PreToolUse) until their
-- SubagentStart arrives, which carries no description: the oldest call of the same type names it.

CREATE TABLE subagent (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES thread (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  title TEXT,
  agent_type TEXT,
  model TEXT,
  progress TEXT,
  started_at TEXT NOT NULL,
  UNIQUE (thread_id, key)
);

CREATE TABLE subagent_call (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES thread (id) ON DELETE CASCADE,
  title TEXT,
  agent_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX subagent_call_thread_idx ON subagent_call (thread_id, id);
