# 0002. TypeScript on Node 24, React + Vite + Tailwind

- Status: accepted
- Date: 2026-11-25
- Spec section: docs/spec/06-architecture.md (T2, T3, T9)

## Context

One developer, with agents doing most of the coding. Atlas, AHOY and MTG already use TypeScript, React, Vite and Tailwind; T3 Code is TypeScript. Node 24 is installed.

## Decision

TypeScript on Node 24 for every part, with schemas shared through zod. UI in React + Vite + Tailwind, with live updates over server-sent events. One repo with npm workspaces: `core` (schema, database, rules), `cli`, `server`, `web`.

## Alternatives considered

- Python (FastAPI) backend: fine, but two languages and no shared types with the UI.
- htmx with server rendering: less code, but a weaker fit for a live multi-pane UI later.
- Separate repos per part: more ceremony for no gain at this size.

## Consequences

- The CLI, server and UI share one set of types and validation rules.
- npm workspaces rather than pnpm (pnpm is not on PATH on this machine).
