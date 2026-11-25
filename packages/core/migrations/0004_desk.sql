-- Axiom 0004: the Desk (docs/plan/desk.md, slice D1).
-- A thread keeps its latest reply and the latest summary of it (ephemeral: overwritten each time,
-- never a history entry). A topic gets the owner's Desk arrangement.

ALTER TABLE thread ADD COLUMN last_reply TEXT;
ALTER TABLE thread ADD COLUMN last_reply_at TEXT;
ALTER TABLE thread ADD COLUMN summary_now TEXT;
ALTER TABLE thread ADD COLUMN summary_next TEXT;
ALTER TABLE thread ADD COLUMN summary_at TEXT;
-- The reply time the summary was made from.
ALTER TABLE thread ADD COLUMN summary_reply_at TEXT;
ALTER TABLE thread ADD COLUMN summary_error TEXT;

ALTER TABLE topic ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1));
ALTER TABLE topic ADD COLUMN desk_hidden INTEGER NOT NULL DEFAULT 0 CHECK (desk_hidden IN (0, 1));
ALTER TABLE topic ADD COLUMN desk_order INTEGER;
