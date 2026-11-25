# 04. Agent connectors

- Status: settled (2026-11-25)

## Intent

Axiom connects to agents directly, using their services and CLIs.

Optional connectors used by the agent (for example Slack) are provided by the harness (Claude Code), not implemented by Axiom.

## Providers (first build)

A **provider** is a source of threads Axiom can watch (and, later, launch). Each provider turns its own events into the same small set: thread started, working, waiting on the owner (a question or a permission prompt), stopped (with how it ended), error. The 01 status rules only ever see these events, never provider details.

| Provider | Thread id | How Axiom learns status |
| --- | --- | --- |
| `claude-code` (direct) | Claude Code session id | Claude Code hooks call `axiom hook <event>`: prompt submitted → working; `Notification` (permission prompt, waiting for input) → waiting on the owner; `Stop` → stopped. A session is tied to a topic with `axiom thread attach <topic>`. |
| `t3` (T3 service) | T3 environment id + thread id | Axiom talks to the local T3 server's API directly (no pairing), or reads T3's own SQLite database read-only. T3 session statuses (`idle`, `starting`, `running`, `ready`, `interrupted`, `stopped`, `error`) and pending approvals or user-input requests are mapped to the common events. |

Notes from reading the T3 source (`~/projects/t3code`, 2026-11-25):

- The T3 server exposes these as RPC methods over its client connection; it also has `orchestration.launchThread`, which a later version could use to start threads from Axiom.
- The server has an auth and pairing model, but Axiom skips it: it uses the API directly or reads the database (Q8).
- T3's state lives in `~/.t3/userdata/statev2.sqlite` (SQLite, WAL), with projection tables for threads, provider sessions, provider session bindings, runtime requests (pending approvals and questions) and runs. The running server's port is in `~/.t3/userdata/server-runtime.json` (3773 on this machine).
- Reading T3's database couples Axiom to T3's internal schema, which can change between nightly builds. Axiom should only ever read it, never write, and should fail soft (mark the provider unavailable) when the schema doesn't match.
- `provider_session_bindings` probably maps T3 threads to the underlying Claude Code session ids, which would solve the double-reporting problem (Q9).
- T3 runs Claude Code underneath. If Claude Code hooks also fire inside T3-run sessions, the same thread would be reported twice; Axiom must ignore hook events for sessions that T3 owns (Q9).

## Decisions

- 2026-11-25: The first build has two providers: Claude Code directly, and the T3 service.
- 2026-11-25: No pairing with T3. Axiom uses T3's API directly or queries T3's SQLite database (read-only).
- 2026-11-25: A thread error is its own status, `error` (see 01).
- 2026-11-25: A T3 thread is tied to a topic either by the agent running `axiom thread attach` inside it, or by the owner picking it from a list of T3 threads in Axiom.
- 2026-11-25: Codex directly is a later provider.
- 2026-11-25: Subagents. Claude Code's `Stop` payload lists `background_tasks`; running `subagent` entries mean the thread is still working. For Claude Code threads the hook then skips the stop. For T3 threads the hook (which fires inside T3 sessions too) records the pending-subagent state on the Axiom thread, and the T3 sync does not apply a stop while it is set. T3's own delegated child threads show as a `waiting` run, which the T3 provider already treats as working.
- 2026-11-25: Working subagents (D11). `axiom hooks install` also installs `SubagentStart` and `SubagentStop` (`axiom hook subagent-start` / `subagent-stop`). `PreToolUse` for the `Agent` tool (`Task` in older versions) queues the call's description and type, `SubagentStart` (`agent_id`, `agent_type`; no description) adds a row named by the oldest queued call of its type, and `SubagentStop` removes it; it is not the parent's `Stop`. The parent's `Stop` keeps only the subagents `background_tasks` still lists as running. These rows are written for direct Claude Code sessions only: for T3-run sessions the T3 sync reads `orchestration_v2_projection_subagents`.
- 2026-11-25: T3 is the source of truth for T3 threads. Hook events from T3-run sessions (they carry `T3CODE_THREAD_ID`) are not recorded as Claude Code threads; they make Axiom re-read that T3 thread at once (Q9).
- 2026-11-25: Axiom pins the T3 version it is tested against (server `0.1.11-nightly.20261118.4890`, database migration 98) and warns on a mismatch. See [ADR 0005](../adr/0005-providers-claude-code-and-t3.md).
- 2026-11-25: A topic has many threads (T3 threads, Claude Code sessions); see 01.
- 2026-11-25: Third-party connectors (Slack and similar) come from the harness, such as Claude Code's MCP connectors. Axiom does not build its own.

## Open questions

1. Which agents are in scope first: Claude Code, Codex, others? Through the CLI, the SDK (for example the Claude Agent SDK), or a hosted API?
2. Does Axiom start and own agent sessions, attach to sessions started elsewhere (terminal, T3), or both?
3. What does Axiom need back from a session: status, transcript, cost/usage, files changed, PR links?
4. How are credentials handled? Reuse each CLI's own login, or does Axiom store keys?
5. Where do agents run: only this machine, or also remote hosts (for example slopfactory) and cloud sessions?
6. Should Axiom expose itself to agents (for example as an MCP server) so they can read and write the tracker directly?
   - Raised in priority 2026-11-25: agentic topic creation is part of v1, as a CLI first (see 01).
7. Codex directly (outside T3): add as a third provider later, through its `notify` setting?
   - Answered 2026-11-25: yes, later.
8. How does Axiom authenticate to the local T3 server: a pairing flow once, a token from T3's settings, or something else? Check T3's auth model before building.
   - Answered 2026-11-25: no pairing. Use the API directly, or query T3's SQLite database. Which of the two to use first is decided when building (the database needs no running server; the API is the stabler contract).
9. Do Claude Code hooks fire inside T3-run Claude sessions? If yes, how does Axiom recognise them (an environment marker, the session id matching a T3 thread)? Verify before building.
   - Tested 2026-11-25: **yes, they fire.** Log-only test hooks (user-level `~/.claude/settings.json` and project-level `.claude/settings.local.json`) on `SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, `SessionEnd`; one plain headless `claude -p` run and one T3-run Claude thread (a throwaway delegated child on Haiku). Both runs fired all four events that applied (no `Notification`, since nothing asked for approval), at both scopes. Test hooks removed and settings restored afterwards.
   - T3-run sessions are easy to recognise: the hook process inherits `T3CODE_THREAD_ID` (the T3 thread id) and `CLAUDE_CODE_ENTRYPOINT=t3-code`. A plain run has no `T3CODE_THREAD_ID` and `CLAUDE_CODE_ENTRYPOINT=sdk-cli` (headless) or the CLI value.
   - T3's database also links the two: `orchestration_v2_projection_provider_threads.payload_json` contains the Claude session id.
   - Not tested: whether `Notification` fires inside T3 for approvals. It doesn't matter much, since T3 handles approvals itself and records them as runtime requests.
   - Agreed rule (2026-11-25): T3 is the source of truth for T3 threads. `axiom hook` ignores events that carry `T3CODE_THREAD_ID` as Claude Code threads, but uses them to make Axiom re-read that T3 thread at once, so status changes show without waiting for a poll.
10. How do T3 statuses map exactly? Proposal: `starting` / `running` → working; pending approval or user input → waiting on the owner; `ready` / `idle` / `stopped` after a turn → stopped; `interrupted` → stopped; `error` → error. What does an `error` do to the topic: `hitl` with the error as the reason?
   - Answered 2026-11-25: a new `error` status. The rest of the mapping stands as proposed.
11. How is a T3 thread tied to a topic: the agent runs `axiom thread attach` inside it (as for Claude Code), or Axiom offers a picker of T3 threads in the UI, or both?
   - Answered 2026-11-25: both.
