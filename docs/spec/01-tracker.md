# 01. Tracker

- Status: settled (2026-11-25)

## Intent

Agents record their work in Axiom the way they write work-log entries today. The tracker keeps track of what is ongoing, what requires attention, and what the agent is monitoring.

This is the first usable version of Axiom, together with the agentic tooling that creates and updates items. There are no hard acceptance criteria: v1 is done when it feels usable.

## Hierarchy

```text
Epic            (optional; usually mirrors a Jira epic)
├── Ticket      (optional; usually mirrors a Jira ticket)
│   └── Topic
└── Topic       (directly under an epic, skipping the ticket level)

Topic           (the main item; what a work-log topic is today)
├── Threads    (T3 threads, Claude Code sessions)
├── Specs      (files in the project repo; Axiom keeps a link)
├── Artifacts  (for example an .html report)
├── PRs
└── Links      (project, repository, branch, worktree)
```

- **Topic** is the main item, equivalent to a work-log topic now. A topic may belong to a ticket, or directly to an epic (skipping the ticket level, especially when not using Jira), or to nothing.
- **Ticket** may belong to an epic. Tickets and epics generally have external (Jira) equivalents.
- **Multiple parents** are allowed: a topic can sit under more than one ticket or epic, and a PR can belong to more than one topic. The hierarchy is a graph, not a tree.
- **Thread**: a topic has many threads. A thread is a T3 thread or a Claude Code session.
- **Spec**: agents working on a topic (inside a thread) can write specs. A spec contains **tasks**. Example: `~/projects/vr-test/docs/specs/station.md`, where each row of "8. Milestones" (KC0, KC1, ...) is a task. Specs stay as files in the project repo and Axiom stores a link. **Tasks are stored in Axiom** (amended 2026-11-25, see Tasks below); the spec file refers to them by key.
- **Artifact**: anything an agent produces for the owner to look at, for example an .html report.
- **PR**: pull requests created during a topic.
- Specs, artifacts and PRs are tied to the topic, even when a particular thread produced them.

## Tasks (added 2026-11-25)

A **task** is a unit of work inside a topic, such as a row of a build plan (`S7`) or a spec milestone (`KC3`). Tasks are stored in Axiom; agents create and update them with the CLI as they write a spec, and the spec file refers to them by key.

- **Belongs to** exactly one topic. It may name one of the topic's `spec` links, which groups it on screen (one Tasks block per spec, plus tasks with no spec).
- **Fields:** key (unique within the topic, e.g. `S7`), title, done when, status, order, and **dependencies** (other tasks of the same topic it waits for).
- **Statuses:** `to do`, `wip`, `blocked`, `done`.
- **Dependencies:** a task can depend on several tasks of the same topic. Cycles are rejected. A task whose dependencies are not all `done` is shown as waiting on them.
- **Threads:** a thread can say which task it works on (`axiom thread attach <topic> --task S7`, or later `axiom thread task S7`). While that thread is working, a `to do` or `blocked` task becomes `wip` automatically (a `done` task stays done). Stopping does not change the task; the agent sets `done` or `blocked`.
- **On screen:** the topic page has a Tasks section (per spec, with progress such as 5/8 done) and a separate **dependency graph** section, drawn on the dotted grid (09).

## Statuses

| Status | Meaning |
| --- | --- |
| `idle` | Nothing is happening. |
| `wip` | An agent is working. |
| `hitl` | A human is required (for example, the agent asked a question). |
| `monitoring` | Nothing to do except wait for something the agent can monitor on its own. |
| `blocked` | Nothing to do except wait for something the agent cannot monitor. |
| `review` | Like monitoring, but specifically a PR in review. |
| `done` | No actions left. Set by an agent on its own (allowed by the 03 autonomy baseline) or by the owner. |
| `error` | The agent's thread hit an error. Added 2026-11-25 with the providers (04). |
| `stale` | The owner marked it stale. Only the owner sets it, usually from the "mark as stale" prompt; never automatic, never by an agent. |

- `wip` is set automatically while an agent is running on the topic (Axiom sees a linked thread running). Agents do not set it by hand.
- When the agent stops, the topic goes to `idle`, and Axiom raises a **notification**: the topic is highlighted until the owner clicks it, which dismisses the notification. Exception: if the agent stopped because it asked the owner a question, the topic stays `hitl`.
- With more than one thread on a topic, each thread has its own status, and the topic's status is null. This is a temporary ruling. A topic with a single thread takes that thread's status. The first build reads "more than one thread" as more than one *active at once*; to be decided from real use (see 05 Q6).

### When an agent stops

**Waiting on subagents is not stopping** (owner, 2026-11-25). If the agent ends its turn while subagents it started are still running, the thread stays `wip` (and so do its task and topic). The stop table below applies only when the thread stops with no running subagents. Claude Code reports this in the `Stop` hook payload (`background_tasks` entries with `type: "subagent"` and `status: "running"`; tested 2026-11-25); when the subagent finishes, the parent is re-invoked (a new prompt event), and its next stop is judged again. Background shell commands (dev servers, monitors) do not count here; see the next rule.

**Waiting on a command is monitoring** (owner, 2026-11-26: "When the agent is waiting for a command to finish, the task should go into monitoring mode. Currently it just goes into idle."). If the agent stops with no running subagents but with background commands still running (`background_tasks` entries of any other type with `status: "running"`; Claude Code 2.1.325 lists both a backgrounded `Bash` command and a `Monitor` as `type: "shell"`, checked 2026-11-26), a stop that would be `idle`, or `monitoring` without a confirmed target, is `monitoring` instead. The command is what the agent watches, so no monitor target is needed: each one re-invokes the agent when it finishes (a new prompt event, checked 2026-11-26), and the next stop is judged again. `hitl`, `done`, `blocked` and `review` with a PR still win. If the session ends first, the thread goes back to `idle`, because its commands end with it. Steward's tidy rule and checklist leave such a topic alone, and such a stop does not wake Steward. A dev server left running also counts, so its topic stays `monitoring` until the session ends (Q31).


The owner asked for a common-sense rule (2026-11-25). Whatever the outcome, stopping raises a notification.

| Last status the agent set | Topic after it stops |
| --- | --- |
| nothing, or only `wip` (automatic) | `idle`; `monitoring` while a background command runs |
| `hitl` (it asked a question) | stays `hitl` |
| `done` | stays `done` |
| `blocked` | stays `blocked` |
| (the thread errored) | `error` |
| `review` | stays `review` if the topic has a linked PR; otherwise `idle` |
| `monitoring` | stays `monitoring` if the topic has at least one confirmed monitoring target or a background command runs; otherwise `blocked`, because nothing will check it |

The thread status follows the same table when the topic has several threads.
- No other status is set automatically. In particular, opening a PR does not move a topic to `review`, because a PR can exist before it is ready for review.

The tracker's three views (from 00) map onto these. `idle` and `blocked` are statuses of their own and are not folded into any of the three views:

| View | Statuses |
| --- | --- |
| Ongoing | `wip` |
| Requires attention | `hitl`, `error` |
| Under monitoring | `monitoring`, `review` |
| (own status) | `idle`, `blocked`, `stale` |
| (closed) | `done` |

A topic with a null status (several threads) shows in every view that at least one of its threads qualifies for. For example, it is in "requires attention" if any thread is `hitl`.

### Ticket and epic status

Tickets and epics take their status from Jira by default. When linked to a Jira item, the status is Jira's and is locked: it cannot be changed in Axiom. When not linked, the status can be set in Axiom from a simple set: `to do`, `wip`, `done`. Linked Jira statuses are displayed under Jira's own names, not mapped.

## Fields

The current work log (274 topic files, surveyed 2026-11-25) uses these header fields: Status (116 files), Last worked (112), Goal (82), Scope (44), Project (32), Repository (18). Rarer ones: Target, Verification, Spec, Related, Resolution, Next steps. Common body sections: Log (262), Goal (95), Decisions (16), Related, Findings, Context, Next steps. The things it references most are PRs (~480 mentions), worktrees (~330), branches (~290), threads (~46) and artifacts (a handful).

Note: the work log's "Status" is a free-text summary (for example "merged (PR #147, cea1fa7); deploying"), not an enum. Axiom splits it into the `status` enum plus a short status note.

Topic core (agreed 2026-11-25, "for now"):

| Field | Required | Notes |
| --- | --- | --- |
| id | yes | |
| title | yes | |
| status | yes* | Typed: one of the statuses above. *Null when the topic has more than one thread (temporary ruling); each thread then carries its own status. |
| status note | no | Separate free-text field: where it stands, as the work-log index column does now. |
| goal | no | What "done" means for this topic. Today's Goal / Scope. |
| ticket | no | Parent ticket. |
| created, last worked | yes | Last worked is updated by any activity on the topic. |

Everything else is an attached record: threads, specs, artifacts, PRs, links, and history entries (see [08-history.md](08-history.md)).

## Decisions

- 2026-11-25: Hierarchy as above. Topic is the main item; ticket and epic are optional parents; threads, specs (with tasks), artifacts and PRs hang off the topic.
- 2026-11-25: Statuses: `idle`, `wip`, `hitl`, `monitoring`, `blocked`, `review`, `done`; `stale` and `error` added later the same day.
- 2026-11-25: No logs. The append-only Markdown log is replaced by real database entries (SQLite, if chosen in 05).
- 2026-11-25: Links (project, repository, branch, worktree) are optional records on a topic. Their purpose is to tell agents where the work is happening.
- 2026-11-25: Jira is optional. Where used, a ticket or epic stores a link plus status pulled through the Jira API. Axiom never writes to Jira.
- 2026-11-25: Agents create and update items through a CLI first. MCP server or skill can come later.
- 2026-11-25: Monitoring targets are both explicit and inferred: Axiom suggests them from links (an open PR, a Jira link), and an agent or the owner confirms.
- 2026-11-25: "Requires attention" covers: an agent asked something, a monitor found a problem, the topic is waiting on the owner, the topic went stale. Each case records its reason so the view can show why the topic is there.
- 2026-11-25: No hard acceptance criteria for v1. It is done when it feels usable.
- 2026-11-25: Topic status is a typed field; the free-text "where it stands" goes in a separate status note field.
- 2026-11-25: Tickets and epics have a status. Jira's status when linked (locked); settable in Axiom when not linked.
- 2026-11-25: `idle` and `blocked` are their own statuses, outside the three views.
- 2026-11-25: History gets its own spec section ([08-history.md](08-history.md)), derived from what the old work-log notes contain, free text included.
- 2026-11-25: `wip` is set automatically while an agent is running.
- 2026-11-25: Specs stay in the project repo, with a link in Axiom, for now.
- 2026-11-25: Multiple parents are allowed, and a topic can belong directly to an epic.
- 2026-11-25 (amends the earlier "tasks not modelled"): tasks are stored in Axiom, belong to a topic, have dependencies, and use `to do` / `wip` / `blocked` / `done`. A thread may name its task, which goes `wip` while the thread works.
- 2026-11-25: Unlinked tickets and epics use `to do` / `wip` / `done`. Linked ones show Jira's status names as-is.
- 2026-11-25: When the agent stops, the topic becomes `idle` and a notification highlights it until the owner clicks it.
- 2026-11-25: `wip` is the only automatic status. Opening a PR does not imply `review`.
- 2026-11-25: A thread waiting on its running subagents stays `wip`; it has not stopped (see "When an agent stops").
- 2026-11-25: An agent that stops on a question to the owner leaves the topic in `hitl`, not `idle`.
- 2026-11-25 (temporary): With multiple threads, each thread has its own status and the topic's status is null.
- 2026-11-25: Notifications are a general mechanism with their own notifications pane (see 02), not only the topic highlight.
- 2026-11-25: An agent's own status survives it stopping, by the common-sense table under "When an agent stops" (the owner delegated the rule).
- 2026-11-25: A null-status topic shows in every view any of its threads qualifies for. A single-thread topic mirrors its thread's status.
- 2026-11-25: Notification events: agent stopped, agent asked a question, monitor found a problem, Jira status changed, PR review arrived, topic went stale (later changed to a "mark as stale" prompt, see below). The notifications pane has settings to mute kinds of notification, and a topic can be muted.
- 2026-11-25: Muting a topic hides every notification from it, `hitl` questions included, both in the notifications pane and as system (desktop) notifications. It does not hide the topic's state in the UI: a "waiting for you" highlight still shows until the owner clicks it. Mutes never run out; the topic stays muted until the owner unmutes it.
- 2026-11-25: Staleness is never applied automatically. Axiom shows a "mark as stale" prompt and the owner decides. This replaces the "topic went stale" notification.
- 2026-11-25: `stale` is a new topic status. The prompt appears when a topic has been `idle` with no activity for N days (N configurable; default to be set when building, 14 suggested).
- 2026-11-25: Topics are closed by moving them to `done`, either by an agent on its own or by the owner. That is the main defence against stale topics.
- 2026-11-26: An agent that stops while its own background commands still run (shells, monitors) moves to `monitoring`, not `idle`, with no monitor target needed (owner). See "When an agent stops".

## Open questions

1. What kinds of work item exist, and can they nest?
   - Answered 2026-11-25: see Hierarchy.
2. What states does a work item move through?
   - Answered 2026-11-25: see Statuses. New ones, not the triage labels.
3. Which fields are required on every item?
   - Partly answered 2026-11-25: based on the current work log fields. See the proposed topic core under Fields. Status is typed, with a separate free-text status note. Confirm the rest or amend.
   - Answered 2026-11-25: the proposed core is fine for now.
4. Is the log append-only, and who writes to it?
   - Answered 2026-11-25: there is no log. History is database entries. Follow-up in Q12.
5. How do items relate to projects, branches, worktrees and PRs?
   - Answered 2026-11-25: optional links that guide agents to where the work is.
6. Sync with external trackers?
   - Answered 2026-11-25: Jira link plus pulled status via the API, optional.
7. What does the agentic tooling look like?
   - Answered 2026-11-25: a CLI to start.
8. What makes a topic monitorable?
   - Answered 2026-11-25: both explicit and inferred (see Decisions).
9. What does "requires attention" mean concretely?
   - Answered 2026-11-25: see Decisions.
10. Which items carry a status?
    - Answered 2026-11-25: topics, tickets and epics. Tickets and epics use Jira's status when linked (locked), and are settable when not. Tasks are not modelled yet (Q14).
11. Which statuses land in which view?
    - Answered 2026-11-25: `idle` and `blocked` are their own statuses, outside the three views.
12. With no log, what does a topic's history consist of?
    - Answered 2026-11-25: moved to its own section, [08-history.md](08-history.md). The candidate entry types are fine for now.
13. Who sets `wip`?
    - Answered 2026-11-25: set automatically while an agent is running. Follow-up in Q19.
14. Specs and tasks: file in the repo, or owned by Axiom?
    - Amended 2026-11-25 (owner): specs stay files; tasks are owned by Axiom. See Tasks.
    - Answered 2026-11-25: in the project repo, with a link in Axiom, for now.
15. What does a task carry?
    - Answered 2026-11-25: key, title, done when, status (`to do` / `wip` / `blocked` / `done`), order, dependencies. See Tasks.
    - Deferred 2026-11-25: Axiom does not model tasks while specs are only linked (Q14).
16. Can a topic exist without a ticket, and a ticket without an epic?
    - Answered 2026-11-25: yes. A topic can also belong directly to an epic.
17. Multiple parents?
    - Answered 2026-11-25: yes, for topics and PRs.
18. Status values for tickets and epics not linked to Jira, and display of linked Jira statuses.
    - Answered 2026-11-25: `to do` / `wip` / `done` when not linked. Jira's own names when linked.
19. When the running agent stops, what does the topic's status become?
    - Answered 2026-11-25: `idle`, plus a notification that highlights the topic until the owner clicks it. Follow-up in Q21 and Q22.
20. Can a topic's status be derived automatically beyond `wip`?
    - Answered 2026-11-25: no. For example, a PR can be created before it is ready for review, so a PR opening does not mean `review`.
21. If an agent explicitly sets a status before it stops, does that status stick?
    - Answered 2026-11-25: if it asked the owner a question, the topic stays `hitl`. Other statuses: see Q24.
22. With several threads on one topic, what is the topic's status?
    - Answered 2026-11-25 (temporary ruling): each thread has its own status, and the topic's status is null. Follow-up in Q25.
23. Are notifications a general mechanism, with a list besides the highlight?
    - Answered 2026-11-25: yes, there is a notifications pane. Which events raise notifications: see Q26.
24. Besides "stopped on a question → `hitl`", does any other status the agent set before stopping stick?
    - Answered 2026-11-25: use common sense. See the table under "When an agent stops".
25. While the topic's status is null, which view does it show in? Probably in every view one of its threads qualifies for (for example "requires attention" if any thread is `hitl`). And does a topic with a single thread simply mirror that thread's status?
    - Answered 2026-11-25: yes to both.
26. Which events raise a notification? Candidates: agent stopped, agent asked a question, monitor found a problem, Jira status changed, PR review arrived, topic went stale. Can the owner mute a kind or a topic?
    - Answered 2026-11-25: keep all six. The notifications pane has settings to mute some kinds, and a topic can be muted.
27. Does muting a topic hide everything from it, and does a mute expire?
    - Answered 2026-11-25: it hides every notification from that topic, system notifications included, but the "waiting for you" highlight still shows in the UI until clicked. Mutes never run out.
28. What counts as "went stale"?
    - Answered 2026-11-25: rather than a staleness rule, topics get closed: agents move them to `done` on their own, or the owner does. Follow-up in Q29.
29. Is the "topic went stale" notification still wanted?
    - Answered 2026-11-25: replaced by a "mark as stale" prompt. Never automatic; the owner decides.
30. What does marking a topic stale do, and what triggers the prompt?
    - Answered 2026-11-25: `stale` is a new status. The prompt shows for a topic `idle` with no activity for N days.
31. A background command the agent does not wait on (a dev server it left running) also keeps the topic `monitoring` until the session ends: Claude Code's payload does not tell the two apart. Is that acceptable, or should long-lived commands be told apart (for example by the agent declaring `idle`)?
32. A stop into `monitoring` on a background command still raises the "agent stopped" notification, and the owner gets another one when the command re-invokes the agent and it stops again. Should the first one be skipped?
