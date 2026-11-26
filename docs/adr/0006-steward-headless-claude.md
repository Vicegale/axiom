# 0006. Steward runs as headless Claude Code calls

- Status: accepted
- Date: 2026-11-25
- Spec section: docs/spec/03-ambient-agent.md (Q5, Q18)

## Context

Steward (03) wakes every 30 minutes in working hours, and on events. Each wake runs in stages with their own model and effort, set by the owner: a cheap gather-and-summarise pass, a Sonnet-low decision pass, and rarely a promoted pass on a stronger model. It must run on the owner's subscription (no API key), report token use per model, reach the harness's connectors (Slack, Google Drive) where they are enabled, and stay within the autonomy rule. The Steward chat starts fresh each time with a model the owner picks in the chat.

Axiom already runs one such call: the Desk summaries use `claude -p --model haiku --no-session-persistence` with `AXIOM_INTERNAL=1` so Axiom's own hooks ignore it (plan D1).

## Decision

Each stage of a wake, the daily tidy-up and each chat turn is one **headless Claude Code call** started by Axiom's server:

- `claude -p --model <stage model> --effort <stage effort> --no-session-persistence --output-format json`, with `AXIOM_INTERNAL=1` in its environment, run in a working folder Axiom chooses (a scratch folder for stages 1 and 2; the Steward worktree for promoted work).
- The prompt carries what the stage needs: the gathered activity or its summary, the memory core, the attached memory of the topics involved, and the stage's instructions. The reply is structured JSON (findings, questions, promotions, memory changes) that Axiom validates and writes; the model does not write to Axiom's database itself.
- Token use comes from the call's `modelUsage` (per model: input, output, cache read, cache creation), stored per stage run. Tested 2026-11-25: `--output-format json` returns it.
- Tools are limited per stage: stage 1 gets read-only tools and the harness connectors; stage 2 gets none beyond reading what it is given; stage 3 gets edit and test tools inside its own worktree only. Axiom, not the model, performs anything the autonomy rule governs (rebase in place, status changes, adopt, discard), so a model mistake cannot push, merge or overwrite.
- One wake at a time; stages 2 and 3 stop after 10 minutes. The chat resumes its own call (`--resume`) within one chat and starts fresh for the next.

## Alternatives considered

- **A long-lived T3 thread for Steward.** The owner could watch and talk to it like any thread, but a thread accumulates context across wakes (cost grows, old context leaks into new judgements), and Axiom would depend on T3 for its own agent. Rejected for now.
- **The Claude Agent SDK in Axiom's server.** Finer control over tools and streaming, but it needs an API key or a separate auth path rather than the owner's existing Claude Code subscription login, and adds a dependency. Kept as the next step if headless calls prove too limited.
- **A runtime setting** (headless, T3 or SDK chosen in the UI): more flexible, but three code paths before one is proven. Not in the first build.

## Consequences

- Every call starts with Claude Code's own baseline context. Measured 2026-11-25: a bare "reply ok" Haiku call used about 38k context tokens (14k cache creation, 24k cache read). Stage 1 runs often, so Steward's calls trim what they load (tools, MCP servers, setting sources) and the first slice measures the real cost per stage.
- Connectors are whatever the machine's Claude Code has. On a machine without them (this one, 2026-11-25), Google Drive and Slack show as unreachable sources (blind spots) instead of failing the wake. Untested on a machine with connectors (03 Q26).
- Axiom stays the only writer of its database and the only actor for anything with side effects outside Steward's own branches and worktrees.
- Changing the runtime later (T3 thread, Agent SDK) touches only the stage runner, since prompts in and JSON out stay the same.
- Update 2026-11-26 (ST9): the chat does not use `--resume`. It resends the conversation in each turn's prompt and every turn stays `--no-session-persistence`. `--resume` needs session persistence, which would leave a session file per chat in the owner's Claude history; measured on Haiku, a resumed second turn cost 4.2k cache-creation plus 2.9k cache-read tokens against 0.9k plus 2.6k resent; and each turn needs fresh memory, topics and open items, which a resumed session would hold stale.
- Update 2026-11-26 (owner): the gather stage and the connector probe run with `--setting-sources user` instead of `""`; on the owner's work machine the claude.ai connectors only load with the user's settings. The other stages keep `""` (they load no connectors). Axiom's own hooks in those settings do nothing, since every call runs with `AXIOM_INTERNAL=1`; other user hooks or settings now apply to gather, so its baseline cost may be higher than the ST1 measurement.
