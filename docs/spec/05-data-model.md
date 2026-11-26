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
| label | Optional, at most 120 characters. |
| description | Optional one-line description, at most 200 characters. The web app shows it under an artifact in the Artifacts menu. Added by migration 0003. |
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
| author | `owner`, `agent`, `axiom` or `steward` (added 2026-11-25, 03). |
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
| kind | `agent stopped`, `agent asked`, `monitor problem`, `jira changed`, `pr review`, `stale prompt`, `error`, `steward urgent` (added 2026-11-25, 03). |
| body | |
| created_at, dismissed_at | Dismissed when the owner clicks the topic. An undismissed notification is what highlights the topic. |

**setting** (key, value JSON): muted notification kinds, the stale threshold N (in days), the pinned T3 version, and Steward's settings (added 2026-11-25: on/off, working hours, wake interval, the model and effort per stage, the complexity mapping, daily caps per model, PR signals).

### Steward (added 2026-11-25, owner OK; spec 03)

What Steward reads, decides and does. Findings and Steward's changes to topics are also written as history entries (`author` `steward`), so the topic's history stays complete; the tables below hold the state the Steward view needs (open, dismissed, adopted) and what history doesn't carry.

**topic.steward_enabled**: default true. Off means Steward neither watches nor acts on the topic (the per-topic switch).

**steward_wake**

| Column | Notes |
| --- | --- |
| trigger | `timer`, `event`, `tidy-up` or `owner` (asked from the chat). |
| trigger_detail | For example `review on mtg#219`. |
| started_at, ended_at | |
| status | `running`, `done`, `failed`, `cut short` (a cap or time limit). |
| brief | Stage 2's short summary for the top of the Steward view. |
| blind_spots | JSON list from the checklist and stage 2 (for example an unreachable source). |
| error | When it failed. |

**steward_run**: one row per headless call (ADR 0006).

| Column | Notes |
| --- | --- |
| wake_id or chat_id | Exactly one. |
| stage | `gather`, `decide`, `promoted`, `tidy-up` or `chat`. |
| model, effort | As run. |
| input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens | From the call's `modelUsage`; the per-model daily report and the caps read these. |
| started_at, ended_at, status | |

**steward_item**: what the Steward view lists.

| Column | Notes |
| --- | --- |
| wake_id | The wake that produced it. |
| kind | `finding`, `question` or `suggestion`. |
| topic_id | Optional (a question about a PR with no topic has none). |
| level | Findings: `urgent`, `attention` or `info` (stage 2 decides). |
| title, body | |
| signal, source | For example `CI failed`, `Slack #mtg-standup`, `checklist: PR without a topic`. |
| fingerprint | What the item is about, so a dismissed item is not raised again unless its subject changed. |
| state | `open`, then `answered`, `dismissed`, `adopted`, `discarded` or `undone`. |
| answer | The owner's answer to a question. |
| entry_id | The history entry it wrote, if any. |
| promotion | The complexity (`simple`, `medium`, `hard`) stage 2 rated a task it asked to promote; the promotion step acts on it (added 2026-11-25, ST3). |
| parent_item_id | A suggestion's finding (a prepared fix sits inside its finding). |
| created_at, resolved_at | |

**steward_suggestion**: a suggestion item's branch.

| Column | Notes |
| --- | --- |
| item_id | |
| repository, branch, base | The `axiom/…` branch and what it is based on. |
| worktree | Under `~/.local/share/axiom/worktrees/`. |
| kind | `fix` or `rebase copy`. |
| complexity | `simple`, `medium` or `hard` (promoted work). |
| diffstat, tests | For example `+3 −1 · 1 file`, `142/142 pass`. |

**steward_action**: something Steward did on its own that can be undone.

| Column | Notes |
| --- | --- |
| item_id | The finding it belongs to. |
| kind | `rebase in place` or `status change`. |
| data | JSON: branch, old and new tip, backup ref; or status from and to. |
| done_at, undone_at | |

**steward_memory**

| Column | Notes |
| --- | --- |
| scope | `core`, `attached` or `general`. |
| attached_kind, attached_key | For `attached`: `topic`, `repo` or `person`, and its slug, path or name. |
| text | |
| source | `wake`, `chat`, `tidy-up` or `owner` (the owner edits it directly). |
| created_at, updated_at, retired_at | Steward may retire and delete its own items (03 autonomy rule). |

**steward_chat** (started_at, model, effort) and **steward_message** (chat_id, role `owner` or `steward`, text, at, memory_item_id when Steward noted something).

## Decisions

- 2026-11-25: Steward's tables, the `steward` author and the `steward urgent` notification kind added for 03 (owner OK). 05 stays settled.
- 2026-11-25: `steward_item.note` added (migration 0013, ST6): a quiet fact beside a finding (`report only`, `promotion skipped: cap reached`, `no local repository`, `couldn't prepare a fix: …`, `fix adopted: …`). A prepared fix is a `suggestion` item whose `parent_item_id` is its finding and whose fingerprint is `fix:<finding fingerprint>`; its `steward_suggestion.base` is `<owner's branch>@<commit the fix started from>`.
- 2026-11-25: `steward_item.promotion` added (migration 0012, ST3). A `status change` entry made by Steward has author `steward` and `by: "steward"` in its data.

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
