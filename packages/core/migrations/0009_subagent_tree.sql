-- Axiom 0009: the subagent tree of a thread's current turn (docs/plan/desk.md, slice D12).
-- `subagent` now keeps the finished ones too (until the next turn starts), each with a status
-- (running, done, failed, cancelled), when it ended, and `parent_key`: the key of the subagent that
-- started it (NULL: started by the thread itself). `subagent_call` remembers who made the call.

ALTER TABLE subagent ADD COLUMN status TEXT NOT NULL DEFAULT 'running';
ALTER TABLE subagent ADD COLUMN ended_at TEXT;
ALTER TABLE subagent ADD COLUMN parent_key TEXT;
ALTER TABLE subagent_call ADD COLUMN parent_key TEXT;
