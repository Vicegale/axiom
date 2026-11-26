# 06. Architecture

- Status: settled (2026-11-25)

## Intent

A locally run app with a web view.

## First tracker build (agreed 2026-11-25)

Scope of the first build: topics, tickets and epics (set by hand; Jira later), statuses with automatic `wip` / `idle` / `hitl` from agent hooks, history entries, links, the three views plus own-status piles, the notifications pane with muting, and the CLI. Not in it: the proactive agent, Jira, the multi-task UI beyond the tracker views.

| # | Choice | Proposal | Main alternative |
| --- | --- | --- | --- |
| T1 | Shape | One local server process (HTTP API + the web UI on `127.0.0.1`), run as a systemd user service, opened in the normal browser. No desktop shell for now. | Tauri or Electron wrapper |
| T2 | Language | TypeScript on Node 24 for everything (core, CLI, server, UI), schemas shared with zod. Matches Atlas, AHOY and MTG. | Python (FastAPI) backend |
| T3 | UI | React + Vite + Tailwind; live updates pushed over server-sent events. | htmx, server-rendered |
| T4 | Database | SQLite in WAL mode at `~/.local/share/axiom/axiom.db`, schema migrations in the repo, a daily backup copy next to it. | Postgres (overkill for one user) |
| T5 | How the CLI writes | The CLI writes to SQLite directly through a shared core library (same validation and rules as the server). Logging works even when the server is down; the server notices changes and pushes them to the UI. | CLI calls the server's HTTP API (single writer, but fails when the server is down) |
| T6 | Automatic statuses | Two providers (see 04): Claude Code directly, through hooks that call `axiom hook <event>`; and the T3 service, through a client connection to the local T3 server that subscribes to thread updates. Both feed the same events into the 01 status rules. | Agents set every status by hand |
| T7 | System notifications | **Agreed 2026-11-25:** the browser shows them (Web Notifications API), not the server or the CLI. They appear only while an Axiom tab is open (it can sit in the background). | Server sends them through libnotify (rejected) |
| T8 | Topic ids | A readable unique slug (like `axiom-spec`), plus an internal numeric id. | Numbered keys (`AX-42`) |
| T9 | Repo layout | One repo with npm workspaces: `core` (schema, database, rules), `cli`, `server`, `web`. | Separate repos |
| T10 | Agent instructions | Ship a short instructions file (or skill) that tells agents how to use the CLI, to replace the work-log rule project by project when the owner is ready (see 07). | |

## Decisions

- 2026-11-25: System notifications come from the browser (T7), so they need an open Axiom tab.
- 2026-11-25: T1–T6 and T8–T10 agreed as proposed. Recorded in ADRs [0001](../adr/0001-local-server-and-browser.md)–[0005](../adr/0005-providers-claude-code-and-t3.md).
- 2026-11-25: Steward, the proactive agent (03), is now in scope, after the Desk. It runs inside the existing server process as headless Claude Code calls ([ADR 0006](../adr/0006-steward-headless-claude.md)); build plan [docs/plan/steward.md](../plan/steward.md).
- 2026-11-25: The live app (the `axiom` command, the Claude Code hooks, the skill and the service) runs from a release copy at `~/.local/share/axiom/app` (`AXIOM_APP_DIR`, `--app-dir`): a detached git worktree of a chosen commit with its own `npm ci` and build, so development builds and migrations in the checkout never reach the real database. Updating it is re-running `scripts/install.sh [--ref <commit-ish>]` from the checkout (plan slice ST0).
- 2026-11-26: The owner asked for an `axiom update` command that pulls the latest main, installs and restarts. It finds the checkout from the release copy (its git common folder), fast-forwards `main` from its upstream (never merges or rebases: a diverged `main` is refused), then runs the checkout's `scripts/install.sh --ref main`, which restarts the service.

## Open questions

1. "Web view": a local server opened in the browser, or a desktop shell (Tauri, Electron) wrapping a web UI?
2. Is it a long-running background service (needed for an always-on feel and event triggers) with the UI as a client?
3. Language and stack for the backend and the frontend.
4. How is it started: on login, by hand, as a systemd user service?
5. Single user on localhost only, or reachable from other devices on the LAN? What authentication does that need?
