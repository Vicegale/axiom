-- Axiom 0001: initial schema (docs/spec/05-data-model.md).
-- Times are UTC ISO-8601 strings. JSON columns are TEXT. Enums are mirrored in src/constants.ts.

CREATE TABLE epic (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug <> '' AND slug NOT GLOB '*[^a-z0-9-]*'),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'to do' CHECK (status IN ('to do', 'wip', 'done')),
  jira_key TEXT,
  jira_url TEXT,
  jira_status TEXT,
  jira_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ticket (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug <> '' AND slug NOT GLOB '*[^a-z0-9-]*'),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'to do' CHECK (status IN ('to do', 'wip', 'done')),
  jira_key TEXT,
  jira_url TEXT,
  jira_status TEXT,
  jira_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ticket_epic (
  ticket_id INTEGER NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  epic_id INTEGER NOT NULL REFERENCES epic (id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, epic_id)
);

CREATE TABLE topic (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug <> '' AND slug NOT GLOB '*[^a-z0-9-]*'),
  title TEXT NOT NULL,
  status TEXT CHECK (
    status IS NULL OR status IN
      ('idle', 'wip', 'hitl', 'monitoring', 'blocked', 'review', 'done', 'stale', 'error')
  ),
  status_note TEXT,
  goal TEXT,
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  stale_prompt_dismissed INTEGER NOT NULL DEFAULT 0 CHECK (stale_prompt_dismissed IN (0, 1)),
  created_at TEXT NOT NULL,
  last_worked_at TEXT NOT NULL
);

CREATE TABLE topic_ticket (
  topic_id INTEGER NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, ticket_id)
);

CREATE TABLE topic_epic (
  topic_id INTEGER NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  epic_id INTEGER NOT NULL REFERENCES epic (id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, epic_id)
);

CREATE TABLE thread (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('claude-code', 't3')),
  provider_thread_id TEXT NOT NULL,
  environment_id TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (
    status IN ('idle', 'wip', 'hitl', 'monitoring', 'blocked', 'review', 'done', 'stale', 'error')
  ),
  declared_status TEXT CHECK (
    declared_status IS NULL OR declared_status IN
      ('idle', 'wip', 'hitl', 'monitoring', 'blocked', 'review', 'done', 'stale', 'error')
  ),
  waiting_on_owner INTEGER NOT NULL DEFAULT 0 CHECK (waiting_on_owner IN (0, 1)),
  status_changed_at TEXT NOT NULL,
  status_changed_seq INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);
CREATE UNIQUE INDEX thread_provider_unique
  ON thread (provider, provider_thread_id, COALESCE(environment_id, ''));
CREATE INDEX thread_topic ON thread (topic_id);

CREATE TABLE link (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('project', 'repository', 'branch', 'worktree', 'pr', 'spec', 'artifact')
  ),
  target TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  created_by_thread_id INTEGER REFERENCES thread (id) ON DELETE SET NULL
);
CREATE INDEX link_topic ON link (topic_id);

CREATE TABLE monitor_target (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  link_id INTEGER REFERENCES link (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'suggested' CHECK (state IN ('suggested', 'confirmed')),
  created_at TEXT NOT NULL
);
CREATE INDEX monitor_target_topic ON monitor_target (topic_id);

CREATE TABLE entry (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('owner', 'agent', 'axiom')),
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
CREATE INDEX entry_topic ON entry (topic_id, id);

CREATE TABLE notification (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  thread_id INTEGER REFERENCES thread (id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'agent stopped', 'agent asked', 'monitor problem', 'jira changed', 'pr review',
      'stale prompt', 'error'
    )
  ),
  body TEXT,
  created_at TEXT NOT NULL,
  dismissed_at TEXT
);
CREATE INDEX notification_topic ON notification (topic_id, dismissed_at);

CREATE TABLE setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
