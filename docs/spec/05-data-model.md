# 05. Data model and storage

- Status: settled (2026-11-25)

## Intent

Axiom has its own internal database. Storage is SQLite (see [ADR 0003](../adr/0003-sqlite-storage.md)). The model below is derived from the settled sections 01 (Tracker) and 08 (History), plus 04 (providers).

## Tables (draft)

Every table has an integer primary key `id`. Times are UTC ISO-8601 strings. Enums are checked in `core` and with SQLite `CHECK` constraints.

### Work items

**epic**, **ticket**

| Column | Notes |
| --- | --- |
| slug | Unique, readable. |
| title | |
| status | `to do` / `wip` / `done`. Used only when not linked to Jira. |
| jira_key, jira_url | Optional. When set, the status is Jira's and locked. |
| jira_status, jira_synced_at | Jira's status under its own name, and when it was last pulled. Filled once the Jira connector exists. |
| created_at, updated_at | |

**ticket_epic** (ticket_id, epic_id): a ticket can sit under several epics.

**topic**

| Column | Notes |
| --- | --- |
| slug | Unique, readable (for example `axiom-spec`). What agents type in the CLI. |
| title | |
| status | One of `idle`, `wip`, `hitl`, `monitoring`, `blocked`, `review`, `done`, `stale`, `error`. Null while several threads carry their own status (01). |
| status_note | Free text: where it stands. |
| goal | Optional. |
| muted | Muting hides its notifications, never its highlight (01). |
| stale_prompt_dismissed | Set when the owner dismisses a "mark as stale" prompt without marking it. The prompt never shows again for this topic. |
| created_at, last_worked_at | Last worked moves on any activity. |

**topic_ticket** (topic_id, ticket_id) and **topic_epic** (topic_id, epic_id): a topic can sit under several tickets, or directly under epics.

### Work attached to a topic

**thread**

| Column | Notes |
| --- | --- |
| topic_id | Exactly one. A thread belongs to one topic. |
| provider | `claude-code` or `t3` (Codex later). |
| provider_thread_id | Claude Code session id, or the T3 thread id. Unique with `provider` (and `environment_id`). |
| environment_id | T3 only. |
| title | As the provider names it, if it does. |
| status | Same values as topic status. Used when the topic has several threads. |
| declared_status | The last status the agent set itself, which the 01 stop table reads. |
| started_at, ended_at, end_reason | |

**link**

| Column | Notes |
| --- | --- |
| topic_id | |
| kind | `project`, `repository`, `branch`, `worktree`, `pr`, `spec`, `artifact`. |
| target | Path, URL, or `owner/repo#123`. |
| label | Optional. |
| created_at, created_by_thread_id | |

A PR that belongs to two topics is two link rows.

**monitor_target**

| Column | Notes |
| --- | --- |
| topic_id, link_id | The link it watches, if any (a PR, a Jira item). |
| kind | What to check (for example `pr-review`, `pr-checks`, `jira-status`). |
| state | `suggested` (Axiom inferred it) or `confirmed` (an agent or the owner confirmed it). |
| created_at | |

The 01 stop table counts only `confirmed` targets.

### Tasks (added 2026-11-25)

**task**

| Column | Notes |
| --- | --- |
| topic_id | Exactly one. |
| key | Unique within the topic (for example `S7`). |
| title | |
| done_when | Optional. |
| status | `to do`, `wip`, `blocked`, `done`. |
| position | Order within the topic. |
| spec_link_id | Optional: a `spec` link of the same topic, for grouping. |
| created_at, updated_at | |

**task_dependency** (task_id, depends_on_task_id): both tasks in the same topic; no cycles; no self-dependency.

**thread.task_id**: optional; the task the thread works on (same topic). While the thread is working, the task is `wip`.

### History

**entry**

| Column | Notes |
| --- | --- |
| topic_id | Exactly one. |
| at | Stamped by Axiom. |
| author | `owner`, `agent` or `axiom`. |
| thread_id | Set when an agent in a known thread wrote it. |
| kind | Agent or owner: `note`, `decision`, `finding`, `verification`, `owner input`, `authorization`, `next steps`. Axiom: `status change`, `topic created`, `thread event`, `git event`, `deploy event`. |
| body | Markdown. Optional for automatic kinds. |
| data | JSON for kind-specific fields, checked per kind in `core`: decision `why`; verification `result` and evidence; authorization `scope` and `standing`; status change `from`, `to`, `reason`; and so on. |
| refs | JSON list of typed references (PR, commit, branch, worktree, thread, artifact, spec, deploy, external ticket, topic). A `topic` ref is how a thread mentions another topic. |
| corrects_entry_id | Set when this entry corrects an earlier one. Entries are never edited. |

The owner can hard-delete an entry (for example one that leaked a secret). Nothing else deletes entries.

### Notifications and settings

**notification**

| Column | Notes |
| --- | --- |
| topic_id, thread_id | |
| kind | `agent stopped`, `agent asked`, `monitor problem`, `jira changed`, `pr review`, `stale prompt`, `error`. |
| body | |
| created_at, dismissed_at | Dismissed when the owner clicks the topic. An undismissed notification is what highlights the topic. |

**setting** (key, value JSON): muted notification kinds, the stale threshold N (in days), the pinned T3 version.

## Decisions

- 2026-11-25: SQLite ([ADR 0003](../adr/0003-sqlite-storage.md)), at `~/.local/share/axiom/axiom.db`, with migrations in the repo and a daily backup copy.
- 2026-11-25: A thread belongs to exactly one topic. It can mention other topics (a `topic` ref on its entries).
- 2026-11-25: A dismissed "mark as stale" prompt never comes back for that topic.
- 2026-11-25 (provisional): The topic's status is null only while more than one of its threads is active at once. To be revisited after real use (Q6).

## Open questions

1. Which engine?
   - Answered 2026-11-25: SQLite.
2. Where does the database live on disk, and how is it backed up?
   - Answered 2026-11-25: `~/.local/share/axiom/axiom.db`, with a daily backup copy next to it.
3. Should the data stay readable and diffable outside Axiom (an export kept in git)?
   - Deferred: export is a later feature (00, "Later").
4. What are the core entities?
   - Drafted 2026-11-25: see Tables.
5. Is there any sync across machines?
   - Answered by 00 (single user, local): no.
6. **Important.** "With more than one thread on a topic, the topic's status is null" (01). A topic collects many threads over its life, so read literally almost every topic would end up with a null status. Does it mean *more than one thread active at the same time*? The draft assumes that: once only one thread is active again, or none, the topic has its own status again.
   - Provisional 2026-11-25: build with that assumption and decide from real use. Keep the rule in one place in `core` so it is cheap to change.
   - Implemented 2026-11-25 (`packages/core/src/rules.ts`, `topicStatusFromThreads`): more than one open `wip` thread → null; exactly one → `wip`; otherwise an open `error` thread, then an open `hitl` thread, decides (so a question is never hidden by another thread stopping later); otherwise the most recently changed thread.
7. Does a thread always belong to exactly one topic?
   - Answered 2026-11-25: yes. It can mention other topics, but belongs to one.
8. When the owner dismisses a "mark as stale" prompt without marking the topic stale, does the prompt come back after another N days, or never for that topic?
   - Answered 2026-11-25: never for that topic.
