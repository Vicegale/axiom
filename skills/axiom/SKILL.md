---
name: axiom
description: Record your work in Axiom, the owner's local tracker, instead of a Markdown work log. Use at the start of any substantive task (find or create the topic and attach your thread), whenever you decide, find, verify or plan something worth keeping, when you need the owner (set hitl), and when you finish (set the final status). Trigger whenever a project's instructions mention Axiom or the `axiom` CLI.
---

# Axiom: recording your work

Axiom tracks what you and the owner are working on. You write to it with the `axiom` CLI (on PATH). Your identity is detected automatically: inside Claude Code or T3 you are an **agent**, and once your thread is attached, every entry you write is tagged with it.

## 1. At the start of a task

```sh
axiom topic list --all                      # is there already a topic for this?
axiom topic show <slug>                     # read it first: status note, goal, recent history
axiom topic new <slug> --title "…" --goal "…" [--epic <slug>] [--ticket <slug>]   # if not
axiom thread attach <slug>                  # tie this session to the topic
```

- One topic per piece of work (what a work-log topic used to be). Slugs are lowercase kebab-case.
- A thread belongs to exactly one topic. Mention other topics with `--ref topic:<slug>` on an entry.
- After `thread attach`, commands default to your topic; you can drop the slug.
- Add where the work happens, so other agents can find it: `axiom link add repository ~/projects/x`, `axiom link add branch feat/y`, `axiom link add worktree …`, `axiom link add pr owner/repo#123`, `axiom link add spec docs/specs/z.md`, `axiom link add artifact <path-or-url>`.

## 2. While working: history entries

Write an entry when something is worth keeping. **One kind per entry**: split a mixed update into several entries.

| Kind | When | Example |
| --- | --- | --- |
| `note` | progress, what changed, context | `axiom entry note "Moved the parser into core; callers updated."` |
| `decision` | a choice with a reason | `axiom entry decision "Use node:sqlite" --why "no native build"` |
| `finding` | a cause, a confirmed fact, research, a measurement, a dead end | `axiom entry finding "Start time was 8.1 s; Scryfall fetch dominates."` |
| `verification` | what you checked and the result | `axiom entry verification "1,412 tests, typecheck, build" --result pass --evidence "npm test"` |
| `next-steps` | what you plan to do next (kept as history) | `axiom entry next-steps "Wire the picker, then screenshots."` |

- `owner-input` and `authorization` are written by the owner only; quote the owner in a `note` if you need to.
- References: `--ref pr:owner/repo#12 --ref commit:abc1234 --ref branch:feat/x --ref artifact:<path>`.
- Entries are never edited. To fix a mistake: `axiom entry note "…corrected…" --corrects <entryId>`.
- Don't record what Axiom records itself: thread start/stop, status changes, topic creation.

## 3. Tasks

When you write a plan or spec with steps, record the steps as tasks in Axiom (the spec file refers to them by key; Axiom is where their status lives).

```sh
axiom task add S1 "Core database" --spec docs/plan/v1.md --done-when "tests pass"
axiom task add S2 "CLI" --spec docs/plan/v1.md --after S1     # S2 waits on S1
axiom task depend S6 --on S3 --on S4                          # more dependencies
axiom task list                                               # key, status, title, waits on
axiom thread task S2                                          # this thread now works on S2
axiom task status S2 done                                     # or blocked / to do
```

- Statuses: `to do`, `wip`, `blocked`, `done`. A task becomes `wip` by itself while a thread that names it is working; you set `done` or `blocked`.
- Dependencies stay within the topic; cycles are rejected.

## 4. Status

`wip` is set automatically while you run; never set it yourself. Set a status before you stop when it isn't simply "idle":

```sh
axiom topic status hitl --reason "Asked: settle 04, 05, 06?"   # you need the owner
axiom topic status review --reason "PR #49 ready"              # needs a pr link on the topic
axiom topic status monitoring --reason "watching the deploy"   # needs a confirmed monitor target
axiom topic status blocked --reason "waiting on the bank's documents"
axiom topic status done
```

When you stop, Axiom applies this: `hitl`, `done`, `blocked` stick; `review` sticks only with a PR link; `monitoring` sticks only with a confirmed monitor target (otherwise it becomes `blocked`); anything else becomes `idle`. Only the owner marks topics `stale`.

Monitor targets: `axiom monitor add pr-review owner/repo#49 --confirmed`, `axiom monitor add pr-checks owner/repo#49 --confirmed` (other checks need `--link-kind`).

Also keep the topic's one-line state current: `axiom topic note "Rows 59, 60 merged; 61 running"`.

## 5. Rules

- Never bypass the owner's processes (review, CI, approvals). Axiom is a record, not a permission system.
- Don't write secrets into entries. If one slips in, tell the owner; only they can delete entries.
- `axiom topic show` and `axiom entries --limit 20` are the fastest way to pick up where another agent left off.
- Add `--json` to any command for machine-readable output.
