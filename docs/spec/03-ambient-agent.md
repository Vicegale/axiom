# 03. Faux-always-on agent

- Status: draft

## Intent

Axiom is part faux-always-on agent, akin to dots / the Grok bot. It periodically uses a cheap model to monitor things: topics in `monitoring` or `review` (see 01), and optional connectors such as Slack. Those connectors are provided by the harness (Claude Code), not built into Axiom.

Proactivity comes first: the point is to catch potential issues earlier. Some work can be done autonomously (for example rebasing a branch), but the agent never overwrites anything of the owner's. It can suggest by doing the work in a new branch; the owner always has the final say. It never bypasses existing processes or does important things on the owner's behalf.

## Decisions

- 2026-11-25: The autonomy rule below applies to this proactive agent only. It has its own permission set, separate from regular threads, which need no permissions specified in Axiom.
- 2026-11-25: Periodic wakes on a cheap model. "Always-on" is faked by a schedule, not a continuously running agent.
- 2026-11-25: It watches the monitoring targets of topics (see 01) and optional harness-provided connectors (Slack named first).
- 2026-11-25: Proactive. It surfaces problems before the owner asks.
- 2026-11-25: It may act autonomously only in ways that never overwrite the owner's work. Results are offered as suggestions (for example a new branch); the owner decides whether to adopt them.
- 2026-11-25: One exception: it may rebase the owner's branch in place onto main to pick up the latest changes, under the conditions in the autonomy rule. Any other history rewrite goes to a copy.
- 2026-11-25: The in-place rebase stays local by default; the agent does not push it. The owner pushes.
- 2026-11-25: Any further autonomy exceptions are decided in the spec for the specific agent that needs them, not in this general rule. This rule is the baseline every agent spec starts from.

## Autonomy rule (baseline; agreed 2026-11-25)

- **Allowed alone:** read anything it has access to; update topic statuses and records in Axiom; create new branches, worktrees or draft artifacts under an Axiom-owned prefix.
- **Allowed alone, with conditions:** rebase one of the owner's branches onto main to pick up recent changes (the owner OK'd this 2026-11-25). Only when the rebase is clean, with no conflicts; the branch's worktree has no uncommitted changes; and no one else has pushed to the branch since the owner's last commit. Before rebasing it saves the old tip under `refs/axiom/backup/<branch>/<timestamp>` so the rebase can be undone, and it records the old and new tips on the topic. The result stays local: it does not push (see Q9). If any condition fails, it falls back to the copy below.
- **Never alone:** mark a topic `stale` (owner only, see 01); force-push or rewrite any branch it did not create, except the rebase onto main above; push to the owner's branches; merge; comment, post or reply on external systems (GitHub, Jira, Slack); change an external ticket; delete anything.
- Fallback example: when the in-place rebase isn't allowed (conflicts, someone else pushed, or a rebase onto anything other than main), it rebases a copy as `axiom/rebase/<branch>`, reports the result, and the owner adopts or discards it.

## Open questions

1. What wakes it?
   - Partly answered 2026-11-25: a periodic schedule. Open: the interval; whether events (CI failed, PR review arrived) or opening Axiom also trigger a wake; whether the cheap model can escalate to a stronger one when it finds something.
2. What can it do when it wakes?
   - Answered 2026-11-25: report, flag, and do non-overwriting work as suggestions. See the draft autonomy rule; confirm or amend it.
3. How does it keep continuity between wakes: memory in Axiom's database, the tracker itself, or both?
4. Does it have a persona and a single conversation thread, or is it summoned per work item?
5. Which model and agent back it, and what usage budget does it run within?
   - Partly answered 2026-11-25: a cheap model, run through the harness (Claude Code) so it can use the harness's connectors. Open: which model (for example Haiku), headless Claude Code vs the Agent SDK, a per-day budget cap.
6. Can it be proactive (message the owner unprompted), and through which channel?
   - Partly answered 2026-11-25: yes, proactivity is the point. Axiom has a notifications pane and system (desktop) notifications, both mutable (01). Open: other channels, such as Slack DMs or phone push.
7. Is "rebase autonomously" meant as in the draft rule (a new branch the owner adopts), or should rebasing the owner's own branch in place be allowed when it is clean and no one else has pushed to it?
   - Answered 2026-11-25: in place is OK in some circumstances, for example rebasing the owner's branch onto main to get the latest changes. See the autonomy rule.
8. What does it monitor on Slack: mentions of the owner, specific channels, threads linked from tickets?
9. After an in-place rebase onto main, does the agent update the remote (`git push --force-with-lease`), or keep the rebase local and leave pushing to the owner? Pushing rewrites a PR's history and re-triggers CI.
   - Answered 2026-11-25: local by default. The agent doesn't push; the owner does.
10. Are there other "freshen" actions that count as safe in place, such as merging main into the branch for repos that don't rebase, or updating a lockfile? Or is the rebase onto main the only exception?
   - Answered 2026-11-25: other exceptions are decided in the specific agent's spec.
11. Does a rebase onto main happen on every wake when main moves, only when the branch falls N commits behind, or only when a monitor sees a conflict coming?
