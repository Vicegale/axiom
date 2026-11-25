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
| D6 | **Live activity line.** Migration 0005: `thread.activity_text/at` (ephemeral, no history, kept after a stop). Claude Code: a `PreToolUse` hook (`axiom hook pre-tool`, installed by `axiom hooks install`) stores a one-line step (`$ cmd`, `Reading x`, ...). T3: the sync reads the newest `reasoning`/`command_execution`/`dynamic_tool`/`file_change`/`web_search`/`subagent` row of `orchestration_v2_projection_turn_items`. The card's run line shows `running · <step>` while the thread is `wip`. | Tests; hook time measured. |

D1 first; then D2 and D3 in parallel (separate worktrees); then D4 and D5.

## Open questions

1. The latest summary is stored on the thread, not as a history entry (so history isn't flooded with one entry per stop). OK?
   - Answered 2026-11-25: summaries are ephemeral: only the latest is kept, on the thread; never in history.
2. Claude Code approvals need a hook that blocks the agent until Axiom answers (with a timeout that falls back to the normal terminal prompt). OK to install that hook?
   - Answered 2026-11-25: OK.

## D5 as built (2026-11-25)

- **T3 questions:** the Desk card shows a thread's pending `user_input` question (header, text, options; multi-select; free text) and answers it through T3's MCP endpoint (`POST http://127.0.0.1:<port>/mcp`: `initialize`, `notifications/initialized`, `tools/call t3_pending_request {action: "respond", threadId, requestId, answers}`). The bearer token is minted per answer with `t3 auth session issue --scope orchestration:read --scope orchestration:operate --ttl 5m --label axiom --subject mcp-client --json` (T3's MCP endpoint only accepts sessions whose subject is `mcp-client`; a default session gets 401 `invalid_mcp_credential`), used once, revoked with `t3 auth session revoke`, and never stored or logged. `answers` maps a question id to a label (or free text), or to a list of them for a multi-select question.
- **T3 permission approvals:** the MCP tool cannot approve one (T3's own description says so). T3's internal `runtime-request.respond` command does take a `decision`, but only over its WebSocket RPC, which is not a supported surface. The card shows the request with an **Open in T3** link.
- **Claude Code approvals:** `axiom hook permission` (`PermissionRequest`; installed with a 620 s hook timeout) records a row in `approval` (migration 0006), marks the thread waiting on the owner, and polls the database every 500 ms for the owner's decision (`approvalTimeoutSec`, default 600, 10 to 600). It prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` or `{"behavior":"deny","message":"..."}`; on a timeout, SIGTERM or any error it prints nothing, so Claude Code asks in the terminal. No-op for unattached sessions, `AXIOM_INTERNAL=1` and T3-run sessions. A pending approval whose hook process is gone (the owner answered in the terminal) is expired by the server.

## D9, D10: model, effort, context and artifacts on the card (2026-11-25)

The owner asked for a current model / effort indicator with context usage, and the topic's Artifacts menu on the Desk card.

| Slice | What | Done when |
| --- | --- | --- |
| D9 | **Model, effort, context.** Migration 0007: on `thread`, `model`, `effort`, `context_used`, `context_max`, `runtime_at` (ephemeral: latest only, no history). Sources: **T3**: the thread's `payload_json.modelSelection` (`model`; effort is the option `effort` or `reasoningEffort`), and the newest `orchestration_v2_projection_provider_turns` row's `payload_json.tokenUsage` (`usedTokens`, `maxTokens`). **Claude Code**: the Stop hook takes `effort.level` from its payload and reads the tail of `transcript_path` for the last assistant message's `model` and `usage` (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`); `context_max` is 1,000,000 for Claude 5 models (what T3 reports for every one of them) and `[1m]` models, otherwise unknown. **Sends from Axiom** record the chosen model / effort right away. The card's thread row shows `Opus 5.5 · high` and a context meter (`190k / 1M`, bar from 0 to max; tokens only when the max is unknown). | Tests (fake transcript, fake T3 rows); the hook still fast; checked on real threads. |
| D10 | **Artifacts on the card.** The tracker's `ArtifactsMenu` (dropdown with descriptions) in the card header next to the link count, shown when the topic has artifacts. | Tests; browser check. |
