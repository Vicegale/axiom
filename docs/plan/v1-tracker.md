# Build plan: first tracker version

- Status: S0–S6, S5b, S8, S9 done (2026-11-25); S7 in progress
- Created: 2026-11-25
- Builds: 01 Tracker, 08 History, 05 Data model, 04 Providers, 06 Architecture, ADRs 0001–0005.
- Out of scope: the proactive agent (03), Jira, the multi-task UI beyond the tracker views, Codex, export.

Each slice is one local branch (no remote for now), reviewed by the orchestrating thread and merged into `main`; it leaves `npm test` and `npm run build` green. Slices run in order unless marked as parallel.

**Who builds:** the Axiom thread orchestrates and reviews; subagents implement, mostly on Sonnet, since the spec and mockups pin down the behaviour. At most two at once, in separate worktrees when both write.

| Slice | What | Done when |
| --- | --- | --- |
| S0 | **Repo scaffold.** npm workspaces `core`, `cli`, `server`, `web`; TypeScript on Node 24; Vitest; lint and format; shared `tsconfig`; scripts `build`, `test`, `dev`. | `npm test` and `npm run build` pass on an empty suite; the README says how to run things. |
| S1 | **Core: database and rules.** The 05 tables and the first migration; opening the database (WAL, busy timeout, migrations run safely by whichever process opens it first); zod schemas for every enum and every entry kind's `data`; operations for topics, tickets, epics, parents, links, monitor targets, threads, entries, notifications, mutes, settings. The status rules in one module: the 01 stop table, the provisional null-status rule (05 Q6), the views, the stale-prompt check (N days, default 14, never again once dismissed). | Unit tests cover every row of the stop table, the null-status rule, the views, the stale prompt, entry validation per kind, and "only the owner deletes entries". |
| S2 | **CLI.** `axiom topic new/show/list/status/note/goal`, `axiom ticket ...`, `axiom epic ...`, parent links, `axiom entry <kind>`, `axiom link add`, `axiom monitor add/confirm`, `axiom thread attach <topic>`. Human output by default, `--json` for agents. Inside an attached thread, the topic defaults to that thread's topic. | End-to-end tests run the CLI against a temporary database. |
| S3 | **Claude Code hooks.** `axiom hook <event>` reads the hook's stdin and maps prompt submitted → working, `Notification` → waiting on the owner, `Stop` → stopped (stop table + notification), session start and end → thread events. Events carrying `T3CODE_THREAD_ID` only ask for a T3 re-read (04 Q9). `axiom hooks install` adds the hooks to `~/.claude/settings.json` idempotently, with a backup; `axiom hooks uninstall` removes them. | Tests replay the payloads recorded in the 2026-11-25 hook test; a manual run in a real session moves a topic through `wip` → `idle` with a notification. |
| S4 | **Server.** HTTP API for reads and for the owner's actions (set status, dismiss a notification, mute, mark stale, dismiss a stale prompt, delete an entry, attach a T3 thread); change detection for writes made by the CLI; server-sent events to the UI; serves the built web app on `127.0.0.1`; daily database backup; `axiom server install` writes and enables a systemd user unit. | API tests; a CLI write shows up as a pushed event within a second. |
| S5 | **Web UI: Inbox layout** (can start in parallel with S4 once the API shape is fixed). Built from the Inbox mockup (`docs/design/mockups/inbox.html`) on shared components (topic detail, history, notifications list, status and kind tokens) per 09. Settings page: layout (Inbox only for now), light/dark, notification settings. Tracker views: ongoing, requires attention, under monitoring, plus idle / blocked / stale / done piles. Topic page: status, note, goal, parents, threads with their statuses, links, monitor targets, the history timeline. Notifications pane with mute settings; browser notifications; topic highlight until clicked; "mark as stale" prompt. | Browser checks of each view and the topic page at desktop width; notifications appear in a background tab; muting hides them but keeps the highlight. |
| S5b | **Board and Console layouts.** Reuse S5's shared components in the Board and Console shells (`board.html`, `console.html`); enable them on the settings page. | Switching layout keeps the open topic; each layout passes the same browser checks as S5. |
| S6 | **T3 provider.** Read `~/.t3/userdata/statev2.sqlite` read-only; check the pinned version (server `0.1.11-nightly.20261118.4890`, migration 98) and warn on a mismatch; poll, plus an immediate re-read when a hook asks; map T3 statuses and runtime requests onto the common events; `error` status; a T3 thread picker in the UI. | Tests against a copy of a real T3 database; a live T3 thread attached to a topic shows `wip` while running and the stop-table result after. |
| S7 | **Agent instructions and first use.** A short instructions file or skill telling agents how to use the CLI. Axiom tracks its own development as its first topic. | One real topic run end to end with agents writing entries; findings fed back into the spec. |
| S8 | **Tasks with dependencies and the dependency graph** (added 2026-11-25, owner). Tasks stored in Axiom per topic, with dependencies; Tasks section and dependency graph (dotted grid) in all three layouts; CLI `axiom task …`. | Done: merged c5d9834. |
| S9 | **Subagent-aware stops** (added 2026-11-25, owner). A thread waiting on running subagents stays `wip` (hooks read `background_tasks`; T3 sync honours it). | Done: merged 263229b. |

Tasks for this plan are tracked in Axiom itself: topic `axiom-v1`, `axiom task list --topic axiom-v1`.

## Open questions

1. Who builds it: this thread slice by slice, or slice threads (and with which model and concurrency)?
   - Answered 2026-11-25: this thread orchestrates with subagents, mostly Sonnet.
2. Does S5 get a design pass first?
   - Answered 2026-11-25: done; see 09 and the mockups.
3. Is GitHub the remote for the Axiom repo, and should PRs go there, or does it stay local for now?
   - Answered 2026-11-25: local for now.
