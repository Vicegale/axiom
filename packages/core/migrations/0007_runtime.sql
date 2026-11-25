-- Axiom 0007: model, effort and context of a thread (docs/plan/desk.md, slice D9).
-- The Desk card shows what a thread runs on and how full its context is. Ephemeral like the
-- activity line: only the latest is kept, never a history entry. `context_max` is NULL when the
-- window size is unknown; `runtime_at` is when any of these last changed.

ALTER TABLE thread ADD COLUMN model TEXT;
ALTER TABLE thread ADD COLUMN effort TEXT;
ALTER TABLE thread ADD COLUMN context_used INTEGER;
ALTER TABLE thread ADD COLUMN context_max INTEGER;
ALTER TABLE thread ADD COLUMN runtime_at TEXT;
