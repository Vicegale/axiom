# 0005. Two providers: Claude Code directly and the T3 service

- Status: accepted
- Date: 2026-11-25
- Spec section: docs/spec/04-agent-connectors.md, docs/spec/06-architecture.md (T6)

## Context

`wip` is set automatically while an agent runs (01). The owner runs agents both in plain Claude Code and in T3 Code.

## Decision

Two providers in the first build, both turning their own events into the same set (started, working, waiting on the owner, stopped, error):

- **Claude Code directly**: hooks call `axiom hook <event>`; `axiom thread attach <topic>` ties a session to a topic.
- **T3 service**: no pairing. Axiom uses the local T3 server's API directly, or reads T3's SQLite database (`~/.t3/userdata/statev2.sqlite`) read-only.

Axiom pins the T3 version it is tested against. Pinned on 2026-11-25: T3 server `0.1.11-nightly.20261118.4890`, database migration 98 (`ActiveShellIndexIndexes`). At startup Axiom compares the running server's version (`~/.t3/userdata/server-runtime.json`) and the latest migration id with the pin. On a mismatch it shows a warning that T3 is an untested version, and if reading fails it marks the T3 provider unavailable instead of breaking.

## Alternatives considered

- Pairing with T3 like a normal client: the supported route, but more setup; rejected by the owner.
- Agents set every status by hand: no integration work, but `wip` would not be automatic.

## Consequences

- Reading T3's database couples Axiom to T3's internal schema. The pin makes a mismatch visible; updating the pin is a deliberate step after re-testing.
- If Claude Code hooks also fire inside T3-run sessions, the same thread would be reported twice. To be tested before building (04 Q9).
  - Update 2026-11-25: tested; they do fire. T3-run sessions carry `T3CODE_THREAD_ID` and `CLAUDE_CODE_ENTRYPOINT=t3-code`, so `axiom hook` can tell them apart. See 04 Q9.
- Codex directly comes later as a third provider.
