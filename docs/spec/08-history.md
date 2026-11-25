# 08. History

- Status: settled (2026-11-25)

## Intent

Topics have no append-only log. History is made of database entries instead. The entry types are derived from what the old work-log history notes contain, free text included.

## What the old logs contain (survey, 2026-11-25)

Source: the `## Log` sections of the GPT Command Center work log, 273 topic files, 4,673 log bullets. Kinds were counted with keyword heuristics, and about 70 random bullets were read by hand to check them. A bullet can count towards several kinds, so the percentages overlap.

| Kind | Share of bullets | Typical content |
| --- | --- | --- |
| Verification | ~37% | "1,189 tests, typecheck, production build pass"; browser checks at given widths; screenshots kept at a path |
| Git / PR event | ~23% | commit SHAs, PR opened (number, base, head), merged, pushed, rebased |
| Thread / agent orchestration | ~15% | thread started, model and effort, worktree, dev port, delegated to whom |
| Finding / diagnosis / research | ~11% | root causes, API contracts confirmed, research with sources, measurements |
| Owner input | ~8% | the owner asked, clarified, confirmed, reported a bug, rejected something |
| Blocked / waiting | ~7% | waiting on the owner, on data, on a deploy |
| Authorization | ~6% | "User explicitly authorizes merging ... and deploying production" |
| Registered / kickoff | ~5% | "Registered the topic before implementation; next step is ..." |
| Deploy | ~4% | deploy triggered, deployed commit verified |
| Decision | ~4% | "Chose a focus-first layout: ..." |
| Reopened | ~4% | "User confirmed X only partially works. Reopened the task" |
| Next steps | ~3% | "Next: ..." |
| Dead end | ~1% | reverted, didn't work |

What stands out:

- **Bullets are dense.** The median bullet is about 410 characters, and about 12% mix three or more kinds (for example: implemented X, tests pass, committed abc123, opened PR #41, next is Y).
- **Most of the bulk is progress narrative** plus its evidence. The free text is where most of the value is; it can't all be turned into fields.
- **A quarter to a third of the content is mechanical** and Axiom could record it by itself: PR opened or merged, commits, thread started or ended, worktree created, deploys, topic registered, reopened, status changes.
- **Authorization matters.** Owner authorizations ("merge and deploy production", "delete only these 17 directories") are rare but important. Under the 03 autonomy rule they deserve their own kind, with the scope of what was allowed.
- **Timestamps are inconsistent.** 78% of bullets start with a date, 33% with a time. Many have no author; when there is one, it's "user" or a named agent, given loosely in the text.
- **Some lines are durable environment facts** (LAN IPs, ports, host recipes). Those belong in project notes or memory, not in a topic's history.

## Entry shape (draft)

Every entry has:

| Field | Notes |
| --- | --- |
| id | |
| topic | Exactly one. An entry that matters to two topics is repeated on each. |
| at | Full timestamp, always. Axiom stamps it. |
| author | The owner, an agent (with its thread), or Axiom itself. |
| kind | Exactly one kind from the list below. An update that covers several kinds is split into several entries. |
| body | Free text (Markdown). Optional for automatic entries. |
| refs | Typed references: PR, commit, branch, worktree, thread, artifact, spec, deploy, external ticket. |

### Kinds (draft)

Written by agents or the owner:

| Kind | Carries, beyond the body |
| --- | --- |
| `note` | Nothing. The default: progress, what changed, context. |
| `decision` | What was decided, and why. |
| `finding` | A cause, a confirmed fact, research, a measurement or a dead end. Optional sub-type. |
| `verification` | What was checked, result (`pass` / `fail` / `partial`), evidence refs (screenshots, artifact). |
| `owner input` | A request, clarification, confirmation, rejection or bug report from the owner. |
| `authorization` | What the owner allowed, its scope, and whether it is one-off or standing. |
| `next steps` | What the agent plans to do next. Kept as history, so the record shows how the plan changed over time. |

Written by Axiom automatically:

| Kind | Source |
| --- | --- |
| `status change` | Old and new status, plus the reason (blocked on what, waiting on whom). Covers "blocked", "reopened" and "done". |
| `topic created` | Replaces "registered the topic". |
| `thread event` | Thread started or ended, model, worktree, how it ended. |
| `git event` | Branch or worktree created, commit, PR opened or merged, rebase (with the old and new tips, as in 03). |
| `deploy event` | Where possible, from a connector; otherwise an agent writes it. |

## Decisions

- 2026-11-25: History is typed database entries, not a log. Free text is kept as an entry type.
- 2026-11-25: The candidate entry types are fine for now (owner). The survey above refines them; see the draft kinds.
- 2026-11-25: Entries are historic records and are generally fixed once written. (Suggested: a mistake is fixed by a new entry that points at the one it corrects, not by editing.)
- 2026-11-25: The split between entries agents or the owner write and entries Axiom writes automatically is right.
- 2026-11-25: An entry belongs to exactly one topic. If it matters to two, it is repeated.
- 2026-11-25: An entry has exactly one kind. Agents split mixed updates into one entry per kind.
- 2026-11-25: Next steps are history entries (kind `next steps`), not a field on the topic.
- 2026-11-25: Environment facts (IPs, ports, host recipes) stay in project notes and memory, outside Axiom.
- 2026-11-25: The owner can delete an entry in exceptional cases, for example one that leaked a secret. Nobody else can.
- 2026-11-25: A task's status change is a `status change` entry like a topic's: author `axiom` (the kind is Axiom-only), `thread_id` of the agent or thread that caused it, and data `{task, from, to, by}` with the task statuses and `by` the actor (`owner`, `agent` or `axiom` for the automatic `wip`). Task creation and dependency edits write no entry; they only move the topic's last worked time.
- 2026-11-25: `authorization` entries are a record only. They do not grant anything: regular threads need no Axiom-level permissions, and the proactive agent's permissions come from its own spec (03).

## Open questions

1. Survey the old work-log `## Log` sections and classify what they record.
   - Done 2026-11-25: see the survey. The draft kinds come from it.
2. Are entries immutable once written, or can they be corrected or deleted?
   - Answered 2026-11-25: generally fixed; they are historic records. Follow-up in Q9.
3. Are some entries written automatically by Axiom and others only by agents or the owner?
   - Answered 2026-11-25: yes, as split in the draft kinds.
4. Can an entry point at more than one topic?
   - Answered 2026-11-25: probably not. Repeat it on each topic instead.
5. A bullet today often mixes several kinds. Should an entry have exactly one kind, or one primary kind plus tags?
   - Answered 2026-11-25: exactly one kind per entry.
6. "Next steps" is current state, not history. Should it be a field on the topic, overwritten as plans change, instead of a history entry?
   - Answered 2026-11-25: no. Next steps stay history entries, as a record of what the agent did over time.
7. Should an `authorization` that is standing (not one-off) also show up somewhere outside the topic's history, for example a list of active permissions the agent checks before acting?
   - Answered 2026-11-25: no list. The proactive agent (03) has its own permission set, separate from regular threads; regular threads don't need permissions specified in Axiom. So `authorization` entries are just a record.
8. Durable environment facts (IPs, ports, host recipes) found while working: does Axiom store them somewhere (per project?), or do they stay in project notes and memory outside Axiom?
   - Answered 2026-11-25: they stay in the notes.
9. "Generally fixed": is a correction a new entry that points at the one it corrects (the suggestion in Decisions)? And can the owner ever delete an entry, for example one that leaked a secret?
   - Answered 2026-11-25: yes, a leaked secret is an example. Owner only.
