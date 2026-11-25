# Build plan: the Desk (spec 02)

- Status: approved (2026-11-25)
- Created: 2026-11-25
- Builds: 02 Multi-task UI. Out of scope: the Steward (03), the ctx meter (no source yet), mobile.

## What we learned first (2026-11-25)

- **T3 has a CLI that does the hard part.** `~/.t3/bin/t3 thread send <thread> -` sends a message (a busy thread gets it as its next turn), `t3 thread start <project> - --provider … --model … --option effort=…` starts a thread, and `t3 thread show <thread> --messages N --json` returns the thread state (status, model, `pendingRequestCount`, …) and the latest messages' text. The CLI handles T3's own authentication, so Axiom needs no pairing. Limits: `send` cannot change the model or effort of an existing thread; there is no CLI command for approvals.
- **Claude Code's `Stop` hook payload carries `last_assistant_message`**, so the hook gets the reply text directly (also `transcript_path`, `cwd`, `effort`).
- **`claude -p --model haiku --no-session-persistence`** runs a one-off summary on the owner's subscription without leaving a session behind.
- **Replying to a direct Claude Code session** is `claude -p --resume <id> --model … --effort …` in the session's folder. That is only safe when the session isn't open in a terminal (Axiom knows: it has seen `SessionEnd`). While it is open, the card offers the copy-resume command instead.

## Slices

| Slice | What | Done when |
| --- | --- | --- |
| D1 | **Replies and summaries.** Migration 0004: on `thread`, the latest reply (text, time) and its summary (`now`, `next for owner`, time); on `topic`, Desk fields (favourite, hidden, manual order). Hooks store `last_assistant_message` on stop; the T3 sync fetches the latest message with `t3 thread show --json` when a T3 thread stops. A server worker summarises each new reply with Haiku (`claude -p --model haiku --no-session-persistence`, one at a time, with a timeout, skipped when the reply hasn't changed). Desk API: cards (topics with threads, latest reply, summary), favourite / hide / reorder. | Tests with a fake `claude` and a fake `t3` binary; a real summary of a real reply checked by hand. |
| D2 | **Desk UI (read and arrange).** `/desk` route and a Desk entry in the app. Top bar: active count, hidden count (opens the list to unhide), sort `Ready first` / `Fixed` (favourites first in both), cards per row `1 2 3 4 N` (remembered per browser), notifications, provider health. Cards: title, topic status and selected thread status, favourite / hide / open, task progress, last worked, link count, thread selector, `Now` summary, `Latest reply · show ▾` as Markdown (the document viewer's renderer), drag to reorder (Fixed mode). Web standards baseline. | Browser checks against the reference; tests. |
| D3 | **Replying.** A `Reply` button on the card reveals the reply box: text, model and effort picker, `Send` (selected thread) and `New thread` (attached to the topic). T3: `t3 thread send` / `t3 thread start` (+ attach). Claude Code: `claude -p --resume` when the session is closed; the copy-resume command while it's open. The box closes after sending; the draft survives a refresh. | A real reply sent to a throwaway T3 thread and a throwaway Claude Code session; tests with fakes. |
| D4 | **New topic.** `+ New topic`: title, project folder, first message, provider, model, effort; creates the topic and starts its first thread (T3), attached. | Tests; one real run. |
| D5 | **Approvals from the card.** T3: answer pending requests through T3 (API or its MCP endpoint; to research, the CLI has no command). Claude Code: a `PermissionRequest` hook that asks Axiom and waits for the owner's decision (to verify in this Claude Code version; the terminal prompt stays as a fallback). | Approve and deny work for both providers on throwaway threads. |

D1 first; then D2 and D3 in parallel (separate worktrees); then D4 and D5.

## Open questions

1. The latest summary is stored on the thread, not as a history entry (so history isn't flooded with one entry per stop). OK?
   - Answered 2026-11-25: summaries are ephemeral: only the latest is kept, on the thread; never in history.
2. Claude Code approvals need a hook that blocks the agent until Axiom answers (with a timeout that falls back to the normal terminal prompt). OK to install that hook?
   - Answered 2026-11-25: OK.
