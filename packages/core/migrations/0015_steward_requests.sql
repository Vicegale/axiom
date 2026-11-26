-- Axiom 0015: requests to Steward from the CLI (docs/plan/steward.md, slice ST10).
-- The CLI never runs a wake. It writes a row here; the server's scheduler notices the write (the
-- ChangeBus polls the database) and on every tick, asks for the wake and marks the row handled.
-- While the server is not running a request waits. `kind` is `run` (the owner's Run now) or
-- `check` (one topic; an agent or the owner). `requested_by` is the actor kind, `thread_id` the
-- agent's attached thread when known. `result` says what the server did with it.

CREATE TABLE steward_request (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('run', 'check')),
  topic TEXT,
  requested_by TEXT NOT NULL,
  thread_id INTEGER,
  created_at TEXT NOT NULL,
  handled_at TEXT,
  result TEXT
);

CREATE INDEX steward_request_pending ON steward_request (handled_at);
CREATE INDEX steward_request_topic ON steward_request (kind, topic, created_at);
