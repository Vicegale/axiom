# Axiom glossary

Working definitions. They change as the spec settles; `docs/spec/` wins where they disagree.

| Term | Meaning |
| --- | --- |
| Tracker | The part of Axiom that stores work items and their history. |
| Topic | The main Axiom item, equivalent to a work-log topic today. Has a status, threads, specs, artifacts, PRs and links. See `docs/spec/01-tracker.md`. |
| Ticket | An optional parent of topics. Usually mirrors a Jira ticket, whose status it then shows (locked). |
| Epic | An optional parent of tickets. Usually mirrors a Jira epic. |
| Thread | A T3 thread or Claude Code session that works on a topic. Has its own status when its topic has several threads. |
| Spec | A document an agent writes inside a topic; contains tasks. Stored in the project repo, linked from Axiom. |
| Task | A unit of work inside a spec (for example a spec milestone row). Lives in the spec file; Axiom does not model tasks yet. |
| Artifact | Something an agent produces for the owner to look at, such as an .html report. Tied to a topic. |
| Status | One of `idle`, `wip`, `hitl`, `monitoring`, `blocked`, `review`, `done`, `stale`, `error`. |
| HITL | Human in the loop: the status for "a human is required". |
| Notification | An event for the owner (for example, a topic's agent stopped). Shown as a highlight on the topic until clicked, and listed in the notifications pane. |
| External ticket | A ticket in another system (for example Jira) that an Axiom ticket or epic mirrors. Optional. Axiom reads its status and never writes to it. |
| Monitoring target | Something the agent checks on each wake for a topic (a PR, a Jira status, ...). Suggested by Axiom from links, confirmed by an agent or the owner. |
| Ongoing / Requires attention / Under monitoring | The tracker's three core views, built from topic statuses. |
| Suggestion | Work the agent did without overwriting anything (for example a new `axiom/...` branch) that the owner may adopt or discard. |
| Multi-task UI | The web view that shows many pieces of work, and the agents on them, at once. |
| Faux-always-on agent | An agent that seems continuously present and responsive, while actually waking on a schedule and running a cheap model. See `docs/spec/03-ambient-agent.md`. |
| Steward | The faux-always-on agent itself: wakes on a schedule, watches topics and connectors, does non-overwriting work as suggestions. On the Desk as an on/off toggle. See `docs/spec/03-ambient-agent.md`. |
| Steward view | The third view beside Tracker and Desk: Steward's questions to the owner, its memory and a chat with it. See `docs/spec/03-ambient-agent.md`. |
| Steward memory | General-purpose knowledge Steward keeps that belongs to no topic. Steward manages it itself; the owner can view and edit it. |
| Memory core | The short part of the Steward memory loaded into every stage-2 run and chat without searching: must-know facts plus an index of the rest. |
| Wake | One run of Steward: a blind-spot check, then gather (a cheap model summarises what changed), tidy, decide (a stronger model judges it), and sometimes promoted work. Started by the timer, an event, Run now or a check request. |
| Finding | Something Steward tells the owner, with a level: `urgent` (also a desktop notification), `attention` or `info`. Written to the topic's history by `steward`. |
| Resolved | A Steward item Steward closed itself, with the reason: no longer true, or the owner said it is handled. Separate from *dismissed*, which only the owner does. |
| Research stages | Gather and the chat: the Steward calls that may look things up (linked folders, read-only git and `gh`, connectors' read tools), as opposed to decide and tidy-up, which read only their prompt. |
| Promotion | Handing a finding to a stronger model to prepare a fix, chosen by how complex Steward rates it; the fix is offered only after Axiom's own test run passes. |
| Release copy | The detached git worktree at `~/.local/share/axiom/app` that the live service, hooks and CLI run from, so development in the checkout never reaches the real database. Updated by `scripts/install.sh`. |
| Provider | A source of threads Axiom watches: Claude Code directly or the T3 service (Codex later). See `docs/spec/04-agent-connectors.md`. |
| Connector | How Axiom talks to an external agent (a service API or a CLI such as Claude Code or Codex). Third-party connectors like Slack come from the harness. |
| Work log | The current Markdown system in GPT Command Center (`docs/work/`) that Axiom will replace. |
