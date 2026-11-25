-- Axiom 0006: permission approvals from the Desk card (docs/plan/desk.md, slice D5).
-- A Claude Code `PermissionRequest` hook records the request here and waits (polling this table)
-- for the owner's decision. `decision` is allow, deny, or expired (the hook gave up, was
-- cancelled, or its process is gone: the terminal prompt took over). Pending = decided_at IS NULL.
-- `hook_pid` lets the server tell a live waiting hook from an abandoned one. No tokens or
-- secrets are stored.

CREATE TABLE approval (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES thread (id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decision TEXT CHECK (decision IN ('allow', 'deny', 'expired')),
  message TEXT,
  hook_pid INTEGER
);
CREATE INDEX approval_thread_idx ON approval (thread_id, decided_at);
