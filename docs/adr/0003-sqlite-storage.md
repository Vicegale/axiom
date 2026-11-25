# 0003. SQLite as Axiom's database

- Status: accepted
- Date: 2026-11-25
- Spec section: docs/spec/05-data-model.md, docs/spec/06-architecture.md (T4)

## Context

Axiom has its own internal database (00). Single user, single machine.

## Decision

SQLite in WAL mode at `~/.local/share/axiom/axiom.db`. Schema migrations live in the repo. A daily backup copy is kept next to the database.

## Alternatives considered

- Postgres: needs a service and buys nothing for one user.
- Markdown or JSON files in git (today's work log): readable, but no real queries, and the owner chose database entries over logs (01).

## Consequences

- Several processes (server, CLI calls from many agents) write at once; WAL and short transactions handle that.
- Data is not human-diffable in git; an export can come later if wanted.
