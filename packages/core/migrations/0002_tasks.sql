-- Axiom 0002: tasks and task dependencies (docs/spec/05-data-model.md, "Tasks").

CREATE TABLE task (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topic (id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (key <> ''),
  title TEXT NOT NULL,
  done_when TEXT,
  status TEXT NOT NULL DEFAULT 'to do' CHECK (status IN ('to do', 'wip', 'blocked', 'done')),
  position INTEGER NOT NULL DEFAULT 0,
  spec_link_id INTEGER REFERENCES link (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (topic_id, key)
);
CREATE INDEX task_topic ON task (topic_id, position, id);

CREATE TABLE task_dependency (
  task_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  depends_on_task_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX task_dependency_on ON task_dependency (depends_on_task_id);

ALTER TABLE thread ADD COLUMN task_id INTEGER REFERENCES task (id) ON DELETE SET NULL;
