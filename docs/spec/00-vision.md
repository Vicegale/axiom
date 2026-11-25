# 00. Vision

- Status: settled (2026-11-25)

## Intent

> Terminology note (2026-11-25): this section says "Axiom tickets" for what agents create. Section 01 later named that item a **topic**; tickets are optional parents of topics. The decisions here are unchanged.

> Axiom keeps track of everything you and your agents are working on, it becomes your command center allowing you to view all your agents simultaneously, and tells you about problems before you go looking.

Axiom is "a bit of everything": part issue tracker, part multi-task UI, part faux-always-on agent (akin to dots / the Grok bot). Long term it replaces the work-log system currently used in GPT Command Center. It has its own internal database and connects to agents directly using their services and CLIs. It is a locally run app with a web view.

The three parts are independent of each other and link into each other:

- **Multi-task UI**: the main place the owner works. Where agents generate work logs today, they will generate Axiom tickets instead.
- **Tracker**: those tickets feed it. It keeps track of what is ongoing, what requires attention, and what the agent is monitoring.
- **Agent**: periodically uses a cheap model to monitor things: monitorable tickets and optional connectors such as Slack.

## Decisions

- 2026-11-25: The three parts are independent and inter-linking; no part needs the others to run.
- 2026-11-25: Proactivity first. Axiom's main job is to catch potential issues earlier.
- 2026-11-25: The first usable version is the tracker plus the agentic tooling that creates tickets. The multi-task UI and the agent come later.
- 2026-11-25: The owner always has the final say. See Non-goals.
- 2026-11-25: Users are the owner and their agents only. Single user; no accounts, sharing or permissions model.
- 2026-11-25: The pitch is the quote at the top of Intent.

## Later (out of scope now)

- Exporting selected things (for example tickets or summaries) so the owner can hand them to other people. Others never use Axiom itself.

## Non-goals

- Axiom never becomes a way to bypass existing processes (review, CI, approvals, a team's own tracker).
- Axiom never does important things on the owner's behalf. It may *suggest* by doing the work somewhere harmless, such as a new branch, and the owner decides.
- Axiom never overwrites the owner's work.

## Open questions

1. Who uses Axiom: only the owner, or the owner plus agents as first-class users? Anyone else, ever?
   - Answered 2026-11-25: just the owner and the agents. A later export feature may let the owner share selected things with others; not in scope now.
2. What is the one-sentence pitch?
   - Answered 2026-11-25: see the quote at the top of Intent. The theme is proactivity, and catching potential issues earlier.
3. Which of the three pillars is the core?
   - Answered 2026-11-25: none; they are independent and inter-linking. The multi-task UI is where the owner works day to day.
4. Non-goals.
   - Answered 2026-11-25: see Non-goals.
5. What does "done" look like for a first usable version?
   - Answered 2026-11-25: the tracker plus the agentic tooling to create tickets. The acceptance criteria still need writing (see 01).
6. What exactly is borrowed from dots and from the Grok bot?
   - Answered 2026-11-25: proactivity first.
7. Where is the line between "important" (the owner does it) and "safe to do autonomously" (for example rebasing a branch)? Draft the rule in 03.
   - Answered 2026-11-25: the baseline autonomy rule in 03. Further exceptions are decided per agent spec.
