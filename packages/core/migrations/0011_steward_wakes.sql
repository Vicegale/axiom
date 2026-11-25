-- Axiom 0011: Steward wakes and gathering (docs/plan/steward.md, slice ST2).
-- A wake keeps what stage 1 gathered (JSON) and the look-back point it read from. The PR poller
-- keeps the latest snapshot of each watched PR and the signals it raised. `steward_state` holds
-- small key/value facts of the scheduler (its heartbeat, to tell whether Steward was off).

ALTER TABLE steward_wake ADD COLUMN gathered TEXT;
ALTER TABLE steward_wake ADD COLUMN look_back_from TEXT;

CREATE TABLE steward_pr_snapshot (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- OPEN, MERGED or CLOSED (a merged or closed PR is not polled again).
  state TEXT NOT NULL,
  -- The facts of the last poll (JSON).
  snapshot TEXT NOT NULL,
  -- The signals active now, as {signal: key} (JSON); a signal is new when its key changes.
  active TEXT NOT NULL DEFAULT '{}',
  -- The signals raised so far, newest last: [{signal, at, detail}] (JSON, capped).
  fired TEXT NOT NULL DEFAULT '[]',
  first_seen_at TEXT NOT NULL,
  polled_at TEXT NOT NULL,
  UNIQUE (repo, number)
);

CREATE TABLE steward_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
