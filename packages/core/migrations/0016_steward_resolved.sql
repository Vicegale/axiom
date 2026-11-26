-- Axiom 0016: Steward closes its own items (docs/plan/steward.md, follow-up SF1).
-- A new item state `resolved`: Steward closed the item because it is no longer true or the owner
-- said it is handled. It is separate from `dismissed`, which only the owner does. `resolution`
-- keeps why, in a sentence.
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt. Dropping it would
-- cascade to its suggestions and actions, so those are kept aside and put back.

CREATE TEMP TABLE keep_suggestion AS SELECT * FROM steward_suggestion;
CREATE TEMP TABLE keep_action AS SELECT * FROM steward_action;
CREATE TEMP TABLE keep_parent AS
  SELECT id, parent_item_id FROM steward_item WHERE parent_item_id IS NOT NULL;

CREATE TABLE steward_item_new (
  id INTEGER PRIMARY KEY,
  wake_id INTEGER REFERENCES steward_wake (id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('finding', 'question', 'suggestion')),
  topic_id INTEGER REFERENCES topic (id) ON DELETE CASCADE,
  level TEXT CHECK (level IS NULL OR level IN ('urgent', 'attention', 'info')),
  title TEXT NOT NULL,
  body TEXT,
  signal TEXT,
  source TEXT,
  fingerprint TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (
    state IN ('open', 'answered', 'dismissed', 'adopted', 'discarded', 'undone', 'resolved')
  ),
  answer TEXT,
  entry_id INTEGER REFERENCES entry (id) ON DELETE SET NULL,
  parent_item_id INTEGER REFERENCES steward_item (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  promotion TEXT CHECK (promotion IS NULL OR promotion IN ('simple', 'medium', 'hard')),
  note TEXT,
  resolution TEXT
);
INSERT INTO steward_item_new
  (id, wake_id, kind, topic_id, level, title, body, signal, source, fingerprint, state, answer,
   entry_id, created_at, resolved_at, promotion, note)
  SELECT id, wake_id, kind, topic_id, level, title, body, signal, source, fingerprint, state,
    answer, entry_id, created_at, resolved_at, promotion, note
  FROM steward_item;
DELETE FROM steward_suggestion;
DELETE FROM steward_action;
DROP TABLE steward_item;
ALTER TABLE steward_item_new RENAME TO steward_item;
UPDATE steward_item SET parent_item_id =
  (SELECT k.parent_item_id FROM keep_parent k WHERE k.id = steward_item.id)
  WHERE id IN (SELECT id FROM keep_parent);
CREATE INDEX steward_item_state ON steward_item (state, id);
CREATE INDEX steward_item_topic ON steward_item (topic_id);
CREATE INDEX steward_item_fingerprint ON steward_item (fingerprint);
CREATE INDEX steward_item_wake ON steward_item (wake_id);

INSERT INTO steward_suggestion SELECT * FROM keep_suggestion;
INSERT INTO steward_action SELECT * FROM keep_action;
DROP TABLE keep_suggestion;
DROP TABLE keep_action;
DROP TABLE keep_parent;
