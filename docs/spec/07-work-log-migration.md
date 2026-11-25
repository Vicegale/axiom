# 07. Work-log migration

- Status: stub

## Intent

Long term, Axiom replaces the work-log system in GPT Command Center: `docs/work/README.md` (index) plus `docs/work/<topic>.md` (details and append-only log), and the `.scratch/` tracker.

## Decisions

None yet.

## Open questions

1. Import the existing `docs/work/` topics into Axiom, or start fresh and freeze the old log?
   - Partly answered 2026-11-25: old logs are not migrated right away. Whether they are imported later is open.
2. What happens to the AGENTS.md rule that makes agents update the work log: do agents write to Axiom instead, and through what interface?
   - Partly answered 2026-11-25: yes, agents create Axiom topics instead of work-log entries, through a CLI first (01).
3. Do `docs/projects/` notes and memories move into Axiom too, or stay as files?
4. What is the cut-over condition (the point where Axiom is trusted enough to stop writing Markdown)?
