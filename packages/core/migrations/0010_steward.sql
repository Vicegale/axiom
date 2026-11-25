-- Axiom 0010: Steward (docs/plan/steward.md, slice ST1; docs/spec/05-data-model.md, "Steward").
-- Adds Steward's tables and `topic.steward_enabled`, and widens two CHECK constraints: `entry.author`
-- gains `steward` and `notification.kind` gains `steward urgent`. SQLite cannot change a CHECK in
-- place, so `entry` and `notification` are rebuilt (create, copy with the same ids, drop, rename,
-- recreate the indexes). Nothing else references them except `entry.corrects_entry_id` (itself) and
-- the new `steward_item.entry_id`, which is created after the rebuild. Foreign key checks are
-- deferred to the commit because dropping `entry` while the copy still points at it would fail.
-- Dropping `entry` would also fire the copy's ON DELETE SET NULL on `corrects_entry_id`, so the
-- pairs are parked in a temporary table and put back after the rename.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE entry_new (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('owner', 'agent', 'axiom', 'steward')),
  thread_id INTEGER REFERENCES thread (id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'note', 'decision', 'finding', 'verification', 'owner input', 'authorization', 'next steps',
      'status change', 'topic created', 'thread event', 'git event', 'deploy event'
    )
  ),
  body TEXT,
  data TEXT,
  refs TEXT,
  corrects_entry_id INTEGER REFERENCES entry (id) ON DELETE SET NULL
);
CREATE TEMP TABLE entry_corrects AS
  SELECT id, corrects_entry_id FROM entry WHERE corrects_entry_id IS NOT NULL;
INSERT INTO entry_new (id, topic_id, at, author, thread_id, kind, body, data, refs)
  SELECT id, topic_id, at, author, thread_id, kind, body, data, refs FROM entry;
DROP TABLE entry;
ALTER TABLE entry_new RENAME TO entry;
UPDATE entry SET corrects_entry_id =
  (SELECT c.corrects_entry_id FROM entry_corrects c WHERE c.id = entry.id)
  WHERE id IN (SELECT id FROM entry_corrects);
DROP TABLE entry_corrects;
CREATE INDEX entry_topic ON entry (topic_id, id);

CREATE TABLE notification_new (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  thread_id INTEGER REFERENCES thread (id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'agent stopped', 'agent asked', 'monitor problem', 'jira changed', 'pr review',
      'stale prompt', 'error', 'steward urgent'
    )
  ),
  body TEXT,
  created_at TEXT NOT NULL,
  dismissed_at TEXT
);
INSERT INTO notification_new (id, topic_id, thread_id, kind, body, created_at, dismissed_at)
  SELECT id, topic_id, thread_id, kind, body, created_at, dismissed_at FROM notification;
DROP TABLE notification;
ALTER TABLE notification_new RENAME TO notification;
CREATE INDEX notification_topic ON notification (topic_id, dismissed_at);

ALTER TABLE topic ADD COLUMN steward_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (steward_enabled IN (0, 1));

CREATE TABLE steward_wake (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('timer', 'event', 'tidy-up', 'owner')),
  trigger_detail TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed', 'cut short')),
  brief TEXT,
  blind_spots TEXT,
  error TEXT
);
CREATE INDEX steward_wake_started ON steward_wake (started_at);

CREATE TABLE steward_chat (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL
);

CREATE TABLE steward_run (
  id INTEGER PRIMARY KEY,
  wake_id INTEGER REFERENCES steward_wake (id) ON DELETE CASCADE,
  chat_id INTEGER REFERENCES steward_chat (id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('gather', 'decide', 'promoted', 'tidy-up', 'chat')),
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed', 'cut short')),
  error TEXT,
  -- Exactly one of wake_id and chat_id.
  CHECK ((wake_id IS NULL) <> (chat_id IS NULL))
);
CREATE INDEX steward_run_model_started ON steward_run (model, started_at);
CREATE INDEX steward_run_wake ON steward_run (wake_id);
CREATE INDEX steward_run_chat ON steward_run (chat_id);

CREATE TABLE steward_item (
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
    state IN ('open', 'answered', 'dismissed', 'adopted', 'discarded', 'undone')
  ),
  answer TEXT,
  entry_id INTEGER REFERENCES entry (id) ON DELETE SET NULL,
  parent_item_id INTEGER REFERENCES steward_item (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX steward_item_state ON steward_item (state, id);
CREATE INDEX steward_item_topic ON steward_item (topic_id);
CREATE INDEX steward_item_fingerprint ON steward_item (fingerprint);
CREATE INDEX steward_item_wake ON steward_item (wake_id);

CREATE TABLE steward_suggestion (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES steward_item (id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  base TEXT NOT NULL,
  worktree TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('fix', 'rebase copy')),
  complexity TEXT CHECK (complexity IS NULL OR complexity IN ('simple', 'medium', 'hard')),
  diffstat TEXT,
  tests TEXT
);
CREATE INDEX steward_suggestion_item ON steward_suggestion (item_id);

CREATE TABLE steward_action (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES steward_item (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('rebase in place', 'status change')),
  data TEXT,
  done_at TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX steward_action_item ON steward_action (item_id);

CREATE TABLE steward_memory (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('core', 'attached', 'general')),
  attached_kind TEXT CHECK (attached_kind IS NULL OR attached_kind IN ('topic', 'repo', 'person')),
  attached_key TEXT,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('wake', 'chat', 'tidy-up', 'owner')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  CHECK (
    (scope = 'attached' AND attached_kind IS NOT NULL AND attached_key IS NOT NULL)
    OR (scope <> 'attached' AND attached_kind IS NULL AND attached_key IS NULL)
  )
);
CREATE INDEX steward_memory_scope ON steward_memory (scope, retired_at);
CREATE INDEX steward_memory_attached ON steward_memory (attached_kind, attached_key);

CREATE TABLE steward_message (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES steward_chat (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'steward')),
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  memory_item_id INTEGER REFERENCES steward_memory (id) ON DELETE SET NULL
);
CREATE INDEX steward_message_chat ON steward_message (chat_id, id);
