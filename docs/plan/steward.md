# Build plan: Steward (spec 03)

- Status: approved (2026-11-25)
- Created: 2026-11-25
- Builds: 03 Faux-always-on agent (Steward), its data model additions in 05, and its parts of the UI (the Steward view, mockup B; the Desk additions). Runtime: [ADR 0006](../adr/0006-steward-headless-claude.md).
- Out of scope: GitHub webhooks (03 Q37), per-kind urgency rules, meaning-based memory search and recall tests (03 Q36), other notification channels (03 Q6), the runtime as a setting.
- Design reference: [docs/design/mockups/steward-b.html](../design/mockups/steward-b.html) and [steward-desk.html](../design/mockups/steward-desk.html); icon: Facet ([steward-icons.html](../design/mockups/steward-icons.html)).

## What we know going in (2026-11-25)

- **Headless calls report tokens per model.** `claude -p --output-format json` returns `modelUsage` per model (input, output, cache read, cache creation, cost).
- **Each call has a baseline.** A bare "reply ok" Haiku call used about 38k context tokens (14k cache creation, 24k cache read). Stage 1 runs every 30 minutes, so the runner must trim what each call loads and ST1 measures it.
- **The Desk already runs headless calls** (`packages/server/src/summaries.ts`: `-p --model haiku --no-session-persistence`, `AXIOM_INTERNAL=1`). The Steward runner follows the same pattern.
- **This machine's Claude Code has no connectors.** Slack and Google Drive are built to show up as blind spots when missing; testing them needs a machine that has them (03 Q26).

### ST1 measurement (2026-11-25)

A trivial Haiku call (`Reply with {"ok":true}`) from a fresh temporary folder with `AXIOM_INTERNAL=1`, `--no-session-persistence`, `--output-format json` (claude 2.1.325), tokens from `modelUsage`. One call per row, so cache read versus creation moves between runs; the total is what counts (it is how the caps count, see below). This machine has no connectors, so what a connector adds to gather is not measured.

| Call | Input | Cache creation | Cache read | Output | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline (nothing trimmed) | 1,177 | 14,092 | 23,689 | 24 | 38,982 |
| `--tools ""` | 2 | 4,595 | 3,474 | 9 | 8,080 |
| `--tools "" --strict-mcp-config` | 2 | 3,538 | 649 | 9 | 4,198 |
| `--setting-sources ""` alone | 2 | 10,360 | 24,222 | 9 | 34,593 |
| `--tools "" --strict-mcp-config --setting-sources "" --disable-slash-commands` | 2 | 3,330 | 649 | 9 | 3,990 |
| the same plus `--system-prompt "<one sentence>"` (**decide, tidy-up**) | 2 | 896 | 0 | 9 | 907 |
| read-only tools (`Read,Grep,Glob`), connectors kept, `--setting-sources ""`, `--disable-slash-commands`, short system prompt (**gather**) | 2 | 7,041 | 0 | 9 | 7,052 |
| the same with Claude Code's default system prompt | 2 | 4,380 | 5,739 | 9 | 10,130 |

Through the runner (real, recorded in `steward_run`): decide on Haiku low 669 tokens; gather on Haiku low 6,807 (7,052 in the table above; the two differ by the cache split only).

What the numbers say: the tool list is the largest part of the baseline (about 30k of 39k), and the short system prompt removes most of what is left. `--setting-sources ""` alone barely helps (it drops hooks, permission rules and user settings, not the default prompt or tools), but the runner keeps it so a user's hooks and permissions never touch a stage. `--bare` is not usable: it never reads the subscription login. `--strict-mcp-config` with no `--mcp-config` starts no MCP servers, which is why the stages without connectors use it.

Flags per stage (all stages: `-p --model <m> --effort <e> --no-session-persistence --output-format json --setting-sources "" --disable-slash-commands`, prompt on stdin, `AXIOM_INTERNAL=1`, a fresh temporary folder unless a folder is given):

| Stage | Tools | Connectors | System prompt | Limit |
| --- | --- | --- | --- | --- |
| gather | `--tools Read,Grep,Glob --allowedTools Read,Grep,Glob[,mcp__<server>...]` (`--add-dir` for repositories) | kept (no `--strict-mcp-config`) | short | none |
| decide, tidy-up | `--tools ""` | none (`--strict-mcp-config`) | short | 10 minutes |
| promoted | `--tools Read,Grep,Glob,Edit,Write,Bash --allowedTools <same> --disallowedTools "Bash(git push *),Bash(gh *)"`, run inside the worktree | none | Claude Code's default (it writes code) | 10 minutes |
| chat | `--tools Read,Grep,Glob`, read-only for now | none | short | none |

Found while testing (a fake MCP server, since this machine has no connectors): a headless call denies any tool that is not allowed, including connector tools, and `--allowedTools "mcp__*"` does not match them. `--allowedTools mcp__<server>` (or `mcp__<server>__*`) does. So gather's connectors work only for servers the runner is told to allow (`mcpServers`); ST2 must list the connected servers and allow only their read tools, since a connector can also post. Bash in promoted is not confined to the folder by any flag: the worktree is the working directory, `git push` and `gh` are denied, and ST6 must add its own checks.

Caps count input + output + cache creation + cache read (`countTokens` in `packages/core/src/steward.ts`). With that rule one trimmed decide call costs under 1k tokens against Sonnet's 1.5M daily cap, and an untrimmed call about 39k, so trimming is what keeps 20 wakes a day far under the caps.

## Slices

| Slice | What | Done when |
| --- | --- | --- |
| ST0 | **Separate live install** (added 2026-11-25, owner). The live service, hooks and CLI run from a release copy at `~/.local/share/axiom/app` (a detached git worktree of a commit, with its own `npm ci` and build), not from the development checkout. `install.sh` creates it and its update step moves it to a chosen commit (`--ref`, default `main`), rebuilds, relinks `axiom` on PATH, re-points the service and restarts it. Development builds and migration files in the repo no longer touch the real database. | Tested in a scratch HOME (Linux); the live install switched over and checked: service up, hooks write, `axiom` resolves to the app copy. |
| ST1 | **Storage and the stage runner.** Migration 0010: the Steward tables of 05 (`steward_wake`, `steward_run`, `steward_item`, `steward_suggestion`, `steward_action`, `steward_memory`, `steward_chat`, `steward_message`), `topic.steward_enabled`, `steward` as an entry author, the `steward urgent` notification kind, Steward settings with the 03 defaults. Core API for all of it. A stage runner in the server: one headless call per stage (`--model`, `--effort`, `--no-session-persistence`, `--output-format json`, `AXIOM_INTERNAL=1`), a JSON reply validated with zod, `modelUsage` stored per run, per-stage tool limits and a 10-minute limit for stages 2 and 3, caps checked before each call. Measure the baseline per stage with and without trimming (tools, MCP servers, setting sources). | Tests with a fake `claude`; one real Haiku call through the runner with its tokens recorded; the trimming measurement written into this plan. |
| ST2 | **Wakes and gathering.** The scheduler: every 30 minutes in working hours, one wake at a time, the top-bar on/off, per-topic off, the first wake looking back 24 hours. Event wakes: a thread stops, and a change on a watched PR. A `gh` poller every 10 minutes in working hours over the topics' PR links (checks, reviews and comments, mergeable state, files changed on main that the PR touches, days without a reviewer, approved and green), with no tokens. The blind-spot checklist in code (unreachable sources, PRs without a topic, topics without a goal, `monitoring` without a target). Stage 1 (gather, Haiku low): summarise what changed, including Slack and Google Drive when the connectors exist. | Tests with fake `gh` and `claude`; a real wake over real topics on this machine, its summary and blind spots checked by hand. |
| ST3 | **Deciding.** Stage 2 (decide, Sonnet low) reads the summary, the memory core, the attached memory of the topics involved and the open items, and returns findings (with level), questions, promotions and memory changes. Axiom writes `steward_item` rows and history entries (`author` `steward`), raises `steward urgent` desktop notifications, and skips anything whose fingerprint was dismissed and hasn't changed. Tidying: mechanical status changes made by Axiom with an entry saying why and an undo; judgement calls become questions. | Tests over recorded summaries; one real wake producing items that read well. |
| ST4 | **The Steward view (B).** `/steward`: a third page tab with the Facet icon and a count of what needs the owner; the brief with the wake's stages folded; Needs you (findings with fixes inside, then questions); Ready for you; Good to know (including Steward's own changes, with undo); memory core; token use per model today; wakes. Answer opens a field; dismiss and discard on hover or focus; settings behind the top-bar control (stage models, complexity mapping, caps, working hours, PR signals, sources). Live updates over the existing event stream. | Browser check against mockup B in dark and light at 1440 and 1024 px; tests. |
| ST5 | **Memory and recall.** The memory store (core, attached, general); the core (about 2k tokens) loaded into every stage-2 run and chat; attached memory pulled in when its topic, repository or person comes up; memory changes from stage 2 and the chat applied by Axiom; the daily tidy-up (first wake of the day) merging, retiring and rewriting the core and its index. Memory page in the Steward view: view, edit, add. | Tests; a tidy-up run on seeded memory checked by hand. |
| ST6 | **Promotion and prepared fixes.** Stage 2 rates a task simple, medium or hard; the owner's mapping picks the model and effort or "report only". Stage 3 runs in a worktree under `~/.local/share/axiom/worktrees/<repo>/<branch>` on an `axiom/fix/…` branch; the fix is offered only if the tests pass. Adopt applies it to the owner's branch locally on click (refused, with the reason, if the owner's worktree has uncommitted changes); Discard deletes Steward's branch and worktree. A cap stops promotions and says so in the view. | A real promoted fix on a throwaway repo: offered, adopted, discarded; tests. |
| ST7 | **Freshening branches.** When a watched branch is behind main and a conflict is coming or its topic is in `review`: rebase in place only if clean, the worktree has no uncommitted changes and nobody else pushed since the owner's last commit; save the old tip under `refs/axiom/backup/<branch>/<timestamp>`, record the tips, offer undo, never push. Otherwise rebase a copy as `axiom/rebase/<branch>`. Repositories the memory marks as "merges main" are only reported. | Tests on throwaway repositories covering each condition and the undo. |
| ST8 | **Desk additions.** The top-bar Steward toggle with the next wake; the Steward tab and count; the two-line strip on cards Steward has something for (its most important item and one action, the rest as a link); a card `⋯` menu holding the per-topic switch, with *hide* moved into it; the small "Steward off" mark. | Browser check against the Desk mockup; tests. |
| ST9 | **The chat.** A drawer from the top bar; a fresh conversation each time (resumed within one chat); model and effort picked in the chat; Steward notes what matters into the topics or its memory; the owner can ask it to act (for example "check this topic now" starts an owner-triggered wake for that topic), within the autonomy rule. | A real chat that notes a fact and runs a check; tests. |

ST0 first (it protects the real database from development builds), then ST1 (done before ST0 was added), ST2, ST3. After ST3: ST4, ST5, ST6 and ST7 can run in parallel (separate worktrees when two write). ST8 after ST4; ST9 after ST4 and ST5.

**Who builds:** as in the v1 build, this thread orchestrates and reviews; subagents implement, mostly on Sonnet. UI slices (ST4, ST8, ST9) are browser-checked before they count as done.

## Open questions

1. Adopt brings the fix onto the owner's branch locally. Cherry-pick the `axiom/fix/…` commits onto it (refusing when the owner's worktree is dirty), or fast-forward when possible and cherry-pick otherwise?
   - Answered 2026-11-25 (ST6): fast-forward when the fix branch descends from the owner's branch tip, otherwise cherry-pick the fix's commits (the range from the commit it started from). Either way a checked-out branch must have no uncommitted changes to tracked files, or Adopt is refused with the reason. A branch checked out nowhere is updated in a temporary worktree that is removed afterwards. A cherry-pick that conflicts is aborted and refused, leaving the branch untouched. Nothing is pushed.
2. Event wakes on "a thread stops": every stop, or only stops on topics in `monitoring` or `review`? Every stop could mean many wakes on a busy day.
   - Answered 2026-11-25: only stops on topics in `monitoring` or `review`.
3. The connectors test (03 Q26) needs a machine with Slack or Google Drive connected to Claude Code. Which machine, and when?
