# 0004. The CLI writes to the database directly

- Status: accepted
- Date: 2026-11-25
- Spec section: docs/spec/06-architecture.md (T5)

## Context

Agents record their work through the CLI (01). Losing a record because the server is down is worse than the cost of a second writer.

## Decision

The CLI opens the SQLite database itself and writes through the shared `core` library, which holds the same validation and status rules the server uses. The server notices changes (for example through SQLite's `data_version`) and pushes them to the UI.

## Alternatives considered

- The CLI calls the server's HTTP API: a single writer and simpler change detection, but every agent update fails while the server is down.

## Consequences

- All rules live in `core`, never in the server alone.
- The server needs change detection for writes it did not make.
- Schema migrations must be run by whichever process opens the database first, safely.
