-- Axiom 0005: the live activity line of a Desk card (docs/plan/desk.md, slice D6).
-- A thread keeps the newest step its agent took ("$ npm test", "Reading app.ts"). Ephemeral like
-- the summaries: overwritten each time, never a history entry, kept after the thread stops.

ALTER TABLE thread ADD COLUMN activity_text TEXT;
ALTER TABLE thread ADD COLUMN activity_at TEXT;
