# 03. Faux-always-on agent (Steward)

- Status: settled (2026-11-25)

## Intent

Axiom is part faux-always-on agent, akin to dots / the Grok bot. It periodically uses a cheap model to monitor things: topics in `monitoring` or `review` (see 01), and optional connectors such as Slack. Those connectors are provided by the harness (Claude Code), not built into Axiom.

Proactivity comes first: the point is to catch potential issues earlier. Some work can be done autonomously (for example rebasing a branch), but the agent never overwrites anything of the owner's. It can suggest by doing the work in a new branch; the owner always has the final say. It never bypasses existing processes or does important things on the owner's behalf.

2026-11-25, owner: "Let's start working speccing out the proactive subagent." That agent is **Steward**, this section's agent (the Desk's on/off toggle, see 02), and its spec stays here. Its first jobs are all four offered (watch PRs, freshen branches, investigate failures, tidy the tracker) "+ others". On how it runs: "We'll pick it in Axiom itself."

2026-11-25, owner, going back to fundamentals ("What makes a proactive agent?"): agreed the seven properties under "What makes it proactive". On prepared work: "I'm concerned about it overwhelming me with trash fixes." On cost: "because we're on a limited subscription, I want to have fine-tuned access to the models and efforts used, in order to manage token usage." What matters most, in order: learning things earlier, having less to do, fewer things slipping. Between a false alarm and a miss: "I prefer it bothers me when it needn't." What it watches: "its own finds too", not only confirmed targets.

2026-11-25, owner, on fixes: "I'm worried here that the lower models we'll use to routinely check things will do a bad job at this. I'd discourage this behavior for now, or find a stable way to promote work to a higher intelligence model. However, I don't want to overdo it, because of token usage." On models: per stage, "and we'll need reporting per model token usage". On sources: "Also recent google docs, if claude has the connector enabled. Things like daily meeting transcripts, etc. A low cost model should summarize the activity, and provide it to sonnet low for decision-making."

2026-11-25, owner: "There should also be a component where the agent tries to detect its own blind spots in information, and has the opportunity to ask me questions."

2026-11-25, owner, on blind spots: detection uses both a fixed checklist and the model's judgement. Questions "appear in the UI. A separate Steward section." "We can make it batched, but I'd say there's no limit. I can dismiss them as needed." "There should be a Steward memory where I can view what it knows. Its knowledge will prioritize checking and updating topics first, and reserving memory for general purpose knowledge."

2026-11-25, owner: the Steward section is "a third view". On the memory: "I can view, edit it directly, and have a specific chat with it." "I essentially want the steward to be able to autonomously manage its memory, not just in a simple file." On promotion to a stronger model: "it depends very much on the complexity of the task."

2026-11-25, owner: on the chat, "A fresh one each time is enough. I'm guessing the steward should take notes from the conversation as we go and remember the important stuff." On judging complexity with a fixed scale the owner maps to models: "I think that works for now." On deleting its own memory: "Yes, its own memory is exempt. However, we should ensure we don't fall into the trap of the agent not being able to find things it _should_ remember because it's looking for the wrong thing."

2026-11-25, owner: findings: "Yes, they go to the Steward view" (to the suggestion: the Steward view by default, urgent ones also as a desktop notification). The chat's model and effort: "It's defined in the chat. I might want it to be different from the passive agentic model picks."

2026-11-25, owner: acting from the chat: "Yes." What counts as urgent: "Let stage 2 decide."

2026-11-25, owner, on recall (an always-loaded core, memory tied to topics, repositories and people, and a regular tidy-up): "I agree with that. Its what I had in mind too."

2026-11-25, owner, on wakes (suggested: every 30 minutes in working hours, rarely or never outside them, plus a wake on events Axiom already sees; opening Axiom doesn't wake it): "Q1 sounds good". On the toggle (off stops new wakes, a running wake finishes, a per-topic off): "Agreed." On limits per wake (one at a time, a time limit, no topic cap, token caps as the brake): "I'd take out the time limit for the cheap models." On connectors in headless runs: "This machine's claude doesn't have connectors. But it should work fine i think."

2026-11-25, owner, on the jobs. Watching PRs (suggested signals: CI failed, changes requested, new review comments, a conflict coming, no reviewer after a few days, approved and ready to merge; read with `gh`; a problem moves the topic to Requires attention): "i think we can keep it as an option to keep it periodic. Gh cli is right." Investigating failures (stage 2 reads failed logs and writes a finding; fixes only by promotion, must pass the tests; worktrees in an Axiom-owned folder): "Sounds good." Tidying (mechanical status changes it makes itself with an entry saying why; judgement calls as questions): "Sounds alright. But if changing a topic, i'd mark it in the history entry that it was changed by the steward." Rebasing (only when behind main and a conflict is coming or the topic is in `review`): "Sounds good."

2026-11-25, owner: adopting and discarding suggestions: "sounds good"; Steward as its own actor: "agreed"; token report and caps: "agree". Slack: "Read recent messages (unseen)". More jobs: "none for now". How far back "recent" goes: "since last check?"

2026-11-25, owner, on watching PRs: "Yes. I accept your signal list, but since the webhooks might not work, i also want a timed version."

## Decisions

Settled 2026-11-25 by the owner ("Settle it"), with the defaults below accepted and Q37 decided as recommended. The remaining small open parts are answered with these defaults; the build plan is [docs/plan/steward.md](../plan/steward.md).


- 2026-11-25: The autonomy rule below applies to this proactive agent only. It has its own permission set, separate from regular threads, which need no permissions specified in Axiom.
- 2026-11-25: Periodic wakes on a cheap model. "Always-on" is faked by a schedule, not a continuously running agent.
- 2026-11-25: It watches the monitoring targets of topics (see 01) and optional harness-provided connectors (Slack named first).
- 2026-11-25: Proactive. It surfaces problems before the owner asks.
- 2026-11-25: It may act autonomously only in ways that never overwrite the owner's work. Results are offered as suggestions (for example a new branch); the owner decides whether to adopt them.
- 2026-11-25: One exception: it may rebase the owner's branch in place onto main to pick up the latest changes, under the conditions in the autonomy rule. Any other history rewrite goes to a copy.
- 2026-11-25: The in-place rebase stays local by default; the agent does not push it. The owner pushes.
- 2026-11-25: Any further autonomy exceptions are decided in the spec for the specific agent that needs them, not in this general rule. This rule is the baseline every agent spec starts from.
- 2026-11-25: The proactive agent is **Steward**, one agent, specified in this section (not a new one).
- 2026-11-25: Steward's first jobs: watch PRs, freshen branches, investigate failures, tidy the tracker (see Jobs). No further jobs for now (Q12).
- 2026-11-25: How Steward runs is picked in Axiom itself, not fixed in this spec (what that means exactly: Q18).
- 2026-11-25: "Proactive" means the seven properties under "What makes it proactive". Steward is built and judged against them.
- 2026-11-25: Priorities, in order: **earlier** (lead time over finding it yourself), **less work** (the next step prepared), **fewer slips** (coverage). When they conflict, the earlier one wins.
- 2026-11-25: When unsure, Steward tells the owner. A false alarm is better than a miss. Staying quiet (property 5) means choosing how loudly to say something, not whether to say it.
- 2026-11-25: Steward looks for problems on its own too, beyond the topics' confirmed monitoring targets (amends the decision above that it watches monitoring targets and connectors). Scope: Q23.
- 2026-11-25: Prepared fixes need a quality bar so they don't pile up as low-value suggestions (owner's concern). What the bar is: Q21.
- 2026-11-25: The owner controls which model and effort Steward uses, in fine detail, to manage token use on a limited subscription. Granularity and limits: Q22.
- 2026-11-25: The cheap models that do the routine checks do not write fixes. Steward reports findings instead. A fix is prepared only if the work is promoted to a stronger model, by a stable rule that is used sparingly (Q25).
- 2026-11-25: Models and efforts are set **per stage** (see Stages). Axiom reports token use **per model**.
- 2026-11-25: A wake runs in stages: a low-cost model gathers and summarises the activity; Sonnet at low effort reads the summary and decides; only promoted work goes to a stronger model.
- 2026-11-25: Steward looks for its own blind spots: what it can't see or doesn't know well enough to judge. It may ask the owner questions to fill them (see "Blind spots and questions"). Asking stays inside Axiom, so it is allowed alone under the autonomy rule; it never asks through external systems on its own.
- 2026-11-25: Blind spots are found by a fixed checklist (for example unreachable sources, topics missing a goal or a target) and by the model's own judgement, both.
- 2026-11-25: Steward's questions appear in a separate **Steward section** of the UI. They come batched, with no limit on how many; the owner dismisses them as needed.
- 2026-11-25: What Steward learns goes to the topics first: it checks and updates the topic it belongs to (goal, status note, targets, links, entries). Its own **Steward memory** holds only general-purpose knowledge that belongs to no topic. The owner can view the memory in the UI.
- 2026-11-25: The Steward section is a **third view**, beside Tracker and Desk.
- 2026-11-25: The owner can view the Steward memory, edit it directly, and have a dedicated chat with Steward.
- 2026-11-25: Steward manages its memory itself (adds, updates, reorganises), and the memory is a managed store, not a single plain file.
- 2026-11-25: Whether work is promoted, and to which model, depends on the complexity of the task.
- 2026-11-25: The Steward chat starts fresh each time. During it, Steward takes notes and keeps what matters (on the topics first, else in its memory).
- 2026-11-25: Promotion works on a fixed complexity scale: stage 2 rates each task (for example simple / medium / hard), and the owner maps each level to a model and effort, or to "report only". The model judges; the owner's mapping picks the model.
- 2026-11-25: Steward's own memory is exempt from "never delete": it may add, merge, retire and delete its own memory items. The memory is items in Axiom's database with a kind, a source and a date, searchable.
- 2026-11-25: Recall is a requirement, not only storage: Steward must find what it should remember even when it isn't searching for the right words (Q36).
- 2026-11-25: Findings go to the Steward view by default; urgent ones also raise a desktop notification.
- 2026-11-25: The Steward chat's model and effort are picked in the chat itself, separate from the stage settings of the wakes.
- 2026-11-25: The owner can ask Steward to act from the chat (for example "check this topic now"), within the autonomy rule.
  - 2026-11-26 (ST9): the only action is "check topic", an owner-triggered wake restricted to that topic, started only while Steward is on and for a topic it is on for; anything else it says it cannot do yet. Notes go to the topic as a history `note` by Steward (or a goal / status-note change when the owner states one), else to memory with source `chat`.
- 2026-11-25: Stage 2 decides which findings are urgent.
- 2026-11-25: Recall in the first build: (1) an **always-loaded core**, a short block put into every stage-2 run and chat with no search, holding the facts Steward must never miss plus an index of what else the memory holds; (2) **attached memory**, items tied to a topic, repository or person, loaded whenever that thing comes up; (3) a regular **tidy-up** where Steward merges and retires items and rewrites the core and index. Steward keeps the core short; the owner can view and edit it. Meaning-based search and a recall test are left for later.
- 2026-11-25: Wakes: every 30 minutes during the owner's working hours, rarely or never outside them; also as soon as an event arrives that Axiom already sees (a thread stops, a review arrives on a watched PR). Opening Axiom does not wake it.
- 2026-11-25: The Desk toggle: off stops new wakes; a wake already running finishes. The owner can also turn Steward off for a single topic.
- 2026-11-25: One wake at a time. No cap on how many topics a wake covers; the per-model token caps (Q22) are the brake. The cheap models (stage 1) have no time limit.
- 2026-11-25: Watching PRs reads GitHub with the `gh` CLI on the owner's login (no connector). It is an option the owner switches on. It reacts to GitHub events (webhooks) when they reach Axiom, and also checks on a timer, since webhooks may not work.
- 2026-11-25: PR signals: CI failed, changes requested, new review comments, a conflict coming (main changed files the PR touches), no reviewer after a few days, and approved and ready to merge. A problem moves the topic to Requires attention; "ready to merge" only goes to the Steward view.
- 2026-11-25: Investigating failures: on a routine wake stage 2 reads the failed CI logs and writes a finding with the likely cause. A fix comes only by promotion (complexity scale), must pass the tests before it is offered, and is built in a worktree inside an Axiom-owned folder, never the owner's checkout.
- 2026-11-25: Tidying: Steward changes a status itself in clear, mechanical cases (for example the PR merged but the topic still says `review`), with an entry saying why. Judgement calls (is it done, has it gone stale) become questions in the Steward view. Every change Steward makes to a topic is marked in its history entry as made by Steward.
- 2026-11-25: Rebasing onto main happens only when the branch is behind main and either a conflict is coming or the topic is in `review`, not on every wake.
- 2026-11-25: Suggestions show in the Steward view, with a marker on the topic's card. Discard deletes Steward's own `axiom/…` branch and worktree. Adopt shows the diff, then brings the change onto the owner's branch locally, only when the owner clicks; pushing stays the owner's.
- 2026-11-25: `steward` is an actor of its own in history, beside `owner` and `agent`. Steward has no topic or thread of its own; its chats leave notes on topics or in its memory.
- 2026-11-25: Token use is reported in the Steward view, per model and per day. Each model has a daily cap; at a cap Steward stops promoting and says so in the view, while stage 1 keeps running.
- 2026-11-25: On Slack, Steward reads recent messages the owner hasn't seen yet.
- 2026-11-25: No further jobs for now: the first set is watch PRs, freshen branches, investigate failures, tidy the tracker.
- 2026-11-25: Each wake reads what changed since its last check (owner, tentative).
- 2026-11-25: The Steward view follows mockup B (briefing): the wake's brief, then Needs you beside Ready for you and Good to know, then memory, token use and wakes; the chat is a drawer from the top bar. Owner: "each area is on screen nicely."
- 2026-11-25: The Desk additions are accepted: Steward as the third page with a count, the toggle with the next wake in the top bar, a two-line strip on cards Steward has something for, the per-topic switch in a card menu, and a small "Steward off" icon.
- 2026-11-25: Steward gets its own icon (owner), distinct from Axiom's (Q39).
- 2026-11-25: Steward's icon is **Facet**: Axiom's diamond with its left half solid (owner: "good enough for now"). "Steward off" is the same mark, faded, with a slash. Candidates in `docs/design/mockups/steward-icons.html`.
- 2026-11-25: Steward runs each stage as a headless `claude -p` call on the owner's subscription ([ADR 0006](../adr/0006-steward-headless-claude.md)).
- 2026-11-25, defaults accepted when settling:
  - **Looking back:** each wake reads what changed since its last check; the first wake, or the first after Steward was off, looks back 24 hours.
  - **Slack:** unseen messages; if the connector can't tell what's unseen, mentions of the owner and DMs since the last check.
  - **Working hours:** a setting in the Steward view (default 09:00–19:00, weekdays). Outside them there are no timer wakes; event wakes still run.
  - **Time limits:** stage 1 has none; stages 2 and 3 stop after 10 minutes each.
  - **Caps and levels:** daily caps per model and the complexity mapping are set in the Steward view, starting generous (Haiku 5M, Sonnet 1.5M, Opus 0.4M tokens a day; simple → Sonnet medium, medium → Opus high, hard → report only), tuned once the report shows real use.
  - **Memory core:** about 2k tokens; the tidy-up runs once a day, on the first wake of the day.
  - **Questions:** answered in place from the Steward view (an *Answer* button opens the field); a new question raises no desktop notification; a dismissed question is not asked again unless what it is about changes.
  - **Past findings and reactions:** findings are history entries on their topic, written by `steward`; dismissing one is recorded there too, which is how Steward avoids repeating it.
  - **Blind-spot checklist:** runs in Axiom's own code before stage 1, with no model; stage 2 adds its own judgement.
  - **Worktrees:** Steward's worktrees live under `~/.local/share/axiom/worktrees/<repo>/<branch>`.
- 2026-11-25: GitHub webhooks are not in the first build. Axiom polls watched PRs with `gh` every 10 minutes in working hours (no tokens) and wakes Steward when something changed, on top of the 30-minute wakes. Webhooks may come later for repos where the owner is an admin (Q37).
- 2026-11-25: Its own looking covers, beyond confirmed targets, recent Google Docs (for example daily meeting transcripts) when Claude's connector for them is enabled, alongside the other sources in Q23.

## What makes it proactive (agreed 2026-11-25)

A proactive agent acts on judgement, not only on a trigger: it decides something matters to the owner, ahead of time, and arrives with the next step ready. Relaying events (a review arrived, an agent stopped) is not enough; Axiom's notifications already do that without a model.

1. **A sense of the owner's goals.** A fact becomes a problem only against a goal ("this blocks what ships Friday"). Sources in Axiom: topic goals, status notes, favourites.
2. **Leading signals, not only lagging ones.** "Main changed the file your PR touches" before "merge conflict". The value is lead time.
3. **Connecting things across sources.** A Slack thread about a topic's PR; a topic still in `review` after its PR was merged; two topics editing the same file.
4. **Arriving with the work done.** A decision to make ("the fix is on `axiom/fix/…`, adopt?") rather than a chore. Without flooding the owner with poor fixes (Q21).
5. **Knowing how loudly to speak.** Interruptions cost the owner attention, so each finding gets a level (for example a desktop notification, a line on the card, or only a history entry). When unsure, it still says it (see Decisions).
6. **Memory of what it said and how the owner reacted.** It doesn't repeat a dismissed finding unless something changed, and it learns which kinds the owner ignores.
7. **Clear limits on what it does alone.** The autonomy rule below.
8. **Knowing what it doesn't know** (added by the owner). It looks for gaps in its own information and asks the owner to fill them, rather than judging on a partial picture.

## Blind spots and questions (draft, 2026-11-25)

Steward keeps track of what it couldn't see or couldn't understand, and can ask the owner about it. Examples of blind spots, not yet a decided list:

- **A source it can't reach:** a connector that isn't authorised (Google Drive, see Q26), a repository it can't read, a CI run whose logs are private.
- **Missing context on a topic:** no goal, no status note, a PR with no topic, a `monitoring` topic with no target.
- **Something it can't place:** a meeting transcript or Slack thread that mentions work no topic covers; two topics that seem to be the same work.
- **A judgement it can't make alone:** whether a deadline mentioned in a meeting applies to a topic, or whether a finding the owner dismissed before still matters.

The owner's answers feed Steward's memory (property 6) and, where they belong there, the tracker itself (for example a topic's goal). Detection is a fixed checklist plus the model's judgement. Questions go to the Steward section of the UI, batched, without a limit; the owner dismisses what they don't want to answer. Answers update the topic they concern first; only general-purpose knowledge goes into the Steward memory, which the owner can view. Remaining details: Q27 to Q32.

## Stages of a wake (draft, 2026-11-25)

Each stage has its own model and effort, set by the owner in Axiom; token use is reported per model.

1. **Gather and summarise** (a low-cost model, for example Haiku). Reads what changed since the last wake: topics and their targets, linked repositories and PRs, and connectors that are enabled (Slack, recent Google Docs such as meeting transcripts). Writes a short summary of the activity. It makes no decisions and writes no fixes.
2. **Decide** (Sonnet, low effort). Reads the summary against the owner's goals and Steward's memory of earlier findings. Decides what is worth telling the owner, how loudly (Q24), and whether anything deserves promotion. Writes findings to the topics.
3. **Promoted work** (a stronger model; which one: Q25). Only for what stage 2 promotes, for example investigating a failure and preparing a fix on an `axiom/…` branch. Rare by design, to keep token use down.

## Autonomy rule (baseline; agreed 2026-11-25)

- **Allowed alone:** read anything it has access to; update topic statuses and records in Axiom; create new branches, worktrees or draft artifacts under an Axiom-owned prefix; manage its own memory, including deleting its own memory items (owner, 2026-11-25).
- **Allowed alone, with conditions:** rebase one of the owner's branches onto main to pick up recent changes (the owner OK'd this 2026-11-25). Only when the rebase is clean, with no conflicts; the branch's worktree has no uncommitted changes; and no one else has pushed to the branch since the owner's last commit. Before rebasing it saves the old tip under `refs/axiom/backup/<branch>/<timestamp>` so the rebase can be undone, and it records the old and new tips on the topic. The result stays local: it does not push (see Q9). If any condition fails, it falls back to the copy below.
- **Never alone:** mark a topic `stale` (owner only, see 01); force-push or rewrite any branch it did not create, except the rebase onto main above; push to the owner's branches; merge; comment, post or reply on external systems (GitHub, Jira, Slack); change an external ticket; delete anything (except its own memory items, above).
- Fallback example: when the in-place rebase isn't allowed (conflicts, someone else pushed, or a rebase onto anything other than main), it rebases a copy as `axiom/rebase/<branch>`, reports the result, and the owner adopts or discards it.

## Jobs (draft, 2026-11-25)

The owner chose these four as the first set. Each stays within the autonomy rule above; the details marked with a question are not decided.

1. **Watch PRs.** For topics in `monitoring` or `review` with a PR target: notice a failed CI run, a review that arrived, or a merge conflict coming. It flags the topic (it lands in Requires attention with the reason, see 01), records a finding on the topic, and reports it in the Steward view. Read with the `gh` CLI, on GitHub events when they arrive and on a timer. Signals: see Decisions.
2. **Freshen branches.** Rebase the owner's branch onto main under the conditions above, or rebase a copy as `axiom/rebase/<branch>` when a condition fails. Only when the branch is behind main and a conflict is coming or the topic is in `review`.
3. **Investigate failures.** When CI fails on a watched PR, stage 2 reads the failed logs and reports the likely cause as a finding. A fix on an `axiom/…` branch only when the work is promoted (see Stages), only once it passes the tests, built in an Axiom-owned worktree.
4. **Tidy the tracker.** Spot topics that look stale, stuck in `wip`, or `monitoring` without a confirmed target, and act on them as the autonomy rule allows (marking `stale` stays the owner's). Mechanical cases it changes itself, marked as Steward's in history; judgement calls become questions.

## UI mockups (2026-11-25)

In [docs/design/mockups/](../design/mockups/) (`src/steward-*.html`, built by `build.py`; screenshots `screens/5-*` to `8-*`), same tokens as the tracker mockups, showing only what this section decides. Sample data, not real.

- **A, Inbox** (`steward-a.html`): a rail of sections (Needs you, Questions, Findings, Suggestions, Memory, Wakes, Token use, Settings), the selected one in the middle, the chat docked on the right.
- **B, Briefing** (`steward-b.html`): one page: the last wake's brief with its stages and blind spots, three columns (Needs you, Ready for you, Good to know), then memory, token use and wakes. The chat opens as a drawer.
- **C, Stream** (`steward-c.html`): a feed with one block per wake and per chat, answered in place, the chat composer at the bottom; memory, token use and sources on the right.
- **Desk additions** (`steward-desk.html`): Steward as the third page with a count, the next wake and the on/off toggle in the top bar, and a Steward strip on each topic card (newest finding, its level, the fitting action, a per-topic switch).

Revised 2026-11-25 after the owner's design review ("several redundant UI elements robbing screen real estate"): answer fields open only on *Answer*; dismiss and discard are a × shown on hover or focus; a prepared fix sits inside its finding instead of appearing twice; suggestion details are one meta line; the rebase's hashes and backup ref fold under *Details*; per-item helper text became tooltips; one label per item; times are dropped inside a wake block; the composer is one growing line; the chat opens from the top bar (A, B); B has two balanced columns with the wake's stages folded into one line; C's memory tabs work; on the Desk the strip is two lines with one action, the per-topic switch is in the card menu (replacing the hide icon), and "Steward off" is a small icon.

The owner picks a direction (Q38).

## Open questions

1. What wakes it?
   - Partly answered 2026-11-25: a periodic schedule. Open: the interval; whether events (CI failed, PR review arrived) or opening Axiom also trigger a wake; whether the cheap model can escalate to a stronger one when it finds something.
   - Partly answered 2026-11-25: escalation, yes, as stages (see Stages; promotion rule in Q25).
   - Answered 2026-11-25: every 30 minutes in working hours, rarely or never outside them, plus a wake on events Axiom already sees; opening Axiom does not wake it. Open: how working hours are set (a setting in the Steward view?), and what "rarely" means outside them.
   - Settled 2026-11-25: working hours are a setting; no timer wakes outside them, event wakes still run.
2. What can it do when it wakes?
   - Answered 2026-11-25: report, flag, and do non-overwriting work as suggestions. See the draft autonomy rule; confirm or amend it.
3. How does it keep continuity between wakes: memory in Axiom's database, the tracker itself, or both?
   - Partly answered 2026-11-25: both, the tracker first. Knowledge about a topic goes to the topic; the Steward memory keeps only general-purpose knowledge (see Decisions). Open: how it remembers its own past findings and the owner's reactions to them (property 6), which belong to no topic's goal but do concern topics.
   - Settled 2026-11-25: findings and their dismissals live in the topic's history (author `steward`).
4. Does it have a persona and a single conversation thread, or is it summoned per work item?
   - Partly answered 2026-11-25: there is a dedicated chat with Steward, in the Steward view (Q32, Q33).
   - Settled 2026-11-25: no persona beyond the name Steward and its icon.
5. Which model and agent back it, and what usage budget does it run within?
   - Partly answered 2026-11-25: a cheap model, run through the harness (Claude Code) so it can use the harness's connectors. Open: which model (for example Haiku), headless Claude Code vs the Agent SDK, a per-day budget cap.
   - Partly answered 2026-11-25: the owner picks models and efforts in fine detail to manage token use (Q22).
   - Settled 2026-11-25: headless `claude -p` per stage (ADR 0006); default stage models Haiku low (gather) and Sonnet low (decide); per-model daily caps.
6. Can it be proactive (message the owner unprompted), and through which channel?
   - Partly answered 2026-11-25: yes, proactivity is the point. Axiom has a notifications pane and system (desktop) notifications, both mutable (01). Open: other channels, such as Slack DMs or phone push.
   - Partly answered 2026-11-25: findings go to the Steward view, urgent ones also as a desktop notification (Q24). Other channels still open.
   - Settled 2026-11-25: Steward view and desktop notifications for urgent findings. Other channels (Slack DMs, phone push) are later.
7. Is "rebase autonomously" meant as in the draft rule (a new branch the owner adopts), or should rebasing the owner's own branch in place be allowed when it is clean and no one else has pushed to it?
   - Answered 2026-11-25: in place is OK in some circumstances, for example rebasing the owner's branch onto main to get the latest changes. See the autonomy rule.
8. What does it monitor on Slack: mentions of the owner, specific channels, threads linked from tickets?
   - Answered 2026-11-25: recent messages the owner hasn't seen yet. Open: whether the Slack connector exposes "unseen" (unread) status; if not, a fallback such as mentions and DMs since the last check.
   - Settled 2026-11-25: fallback to mentions and DMs since the last check.
9. After an in-place rebase onto main, does the agent update the remote (`git push --force-with-lease`), or keep the rebase local and leave pushing to the owner? Pushing rewrites a PR's history and re-triggers CI.
   - Answered 2026-11-25: local by default. The agent doesn't push; the owner does.
10. Are there other "freshen" actions that count as safe in place, such as merging main into the branch for repos that don't rebase, or updating a lockfile? Or is the rebase onto main the only exception?
   - Answered 2026-11-25: other exceptions are decided in the specific agent's spec.
11. Does a rebase onto main happen on every wake when main moves, only when the branch falls N commits behind, or only when a monitor sees a conflict coming?
   - Answered 2026-11-25: only when the branch is behind main and either a conflict is coming or the topic is in `review`.
12. Which other jobs does Steward do ("+ others")? Candidates already in the spec: Slack (Q8), Jira status changes (01's notification events).
   - Answered 2026-11-25: none for now.
13. **Watch PRs:** which signals count (CI failed, changes requested, a new review comment, approved and mergeable, a merge conflict with main), and how does Steward read them (the `gh` CLI, the harness's GitHub connector)? Does each signal set the topic's status (for example `hitl`) or only raise a notification?
   - Partly answered 2026-11-25: the `gh` CLI; owner: "keep it as an option to keep it periodic". Asked: does that mean PR watching is a per-topic or global option that runs on the periodic wakes, or that each signal is an option the owner turns on or off? The suggested signal list is not yet confirmed.
   - Answered 2026-11-25: yes (an option the owner switches on); the signal list as suggested; event-driven by webhooks where they work, plus a timed check. How webhooks reach a local app: Q37.
14. **Investigate failures:** how far does it go: read the logs and write a finding, or also try a fix, run the tests and leave the fix on a branch (`axiom/fix/<branch>`)? Where do its worktrees live? Does a cheap model escalate to a stronger one for this (see Q1)?
   - Partly answered 2026-11-25: routine checks only write findings; a fix needs promotion to stage 3 (Q25). Open: where its worktrees live; whether a promoted fix must pass the tests before it is offered.
   - Answered 2026-11-25: see Decisions (finding on routine wakes; fix by promotion, tests must pass; Axiom-owned worktree folder). Open: the folder's location.
   - Settled 2026-11-25: `~/.local/share/axiom/worktrees/<repo>/<branch>`; a promoted fix must pass the tests before it is offered.
15. **Tidy the tracker:** the autonomy rule lets it update statuses alone. Should it change them (for example `monitoring` without a target to `blocked`), or only suggest the change for the owner to accept? For a topic that looks stale it can only prompt (01).
   - Answered 2026-11-25: mechanical cases it changes itself, marked as Steward's in history; judgement calls become questions.
16. How does the owner see and act on suggestions: where do `axiom/…` branches and other suggestions show (the topic's card, the notifications pane), and what do adopt and discard do?
   - Answered 2026-11-25: see Decisions (Steward view plus a card marker; discard deletes its own branch and worktree; adopt shows the diff and applies locally on the owner's click).
17. What is Steward in the tracker: does it write as its own actor (for example `steward`) on the topic it worked on, and does it have a thread or topic of its own? (Related: Q3, Q4.)
   - Partly answered 2026-11-25: changes Steward makes to a topic are marked in history as Steward's. Open: whether that is a new actor (`steward`) beside `owner` and `agent`, and whether Steward has a thread or topic of its own.
   - Answered 2026-11-25: `steward` is its own actor; no topic or thread of its own.
18. "We'll pick it in Axiom itself": is the runtime a setting in Axiom (for example headless `claude -p` vs a T3 thread, plus model and effort), changeable from the UI? Which options must the first build offer?
   - Partly answered 2026-11-25: models and efforts are set per stage in Axiom (Q22), the chat's in the chat (Q33). Open: whether the runtime itself (headless `claude -p`, a T3 thread, the Agent SDK) is also a setting, and which the first build offers.
   - Settled 2026-11-25: headless `claude -p` for now (ADR 0006). The runtime is not a setting in the first build.
19. What does the Desk toggle do: does off stop the schedule entirely, and what happens to a wake already running? Is there a per-topic opt-out?
   - Answered 2026-11-25: off stops new wakes, a running wake finishes; Steward can also be turned off per topic.
20. Limits per wake: one wake at a time, a time limit, a cap on how many topics it handles per wake? (Related: the budget in Q5.)
   - Answered 2026-11-25: one wake at a time, no topic cap, token caps as the brake; no time limit for the cheap models (stage 1). Open: whether stages 2 and 3 get a time limit.
   - Settled 2026-11-25: stages 2 and 3 stop after 10 minutes each.
21. **Quality bar for prepared fixes** (owner: "overwhelming me with trash fixes"). Which of these, if any: offer a fix only when the tests pass on it; only for some kinds of failure (for example lint, snapshots, a clean rebase); a cap on open suggestions per topic or per day; fall back to a finding with no fix when unsure; drop a kind of fix the owner keeps discarding (property 6)?
   - Answered 2026-11-25: cheap models don't write fixes for now; fixes only through a stable, sparing promotion to a stronger model (Q25).
22. **Model and effort control:** at what grain does the owner pick them: one setting for Steward, per job (watch PRs, investigate failures, ...), or per stage (a cheap triage pass, then a stronger model only for what it found)? Does Axiom show Steward's token use, and are there caps (per wake, per day) that stop or downgrade it?
   - Partly answered 2026-11-25: per stage; token use reported per model. Open: where the report shows (the Desk, a Steward page); caps per wake or per day, and what happens at a cap.
   - Answered 2026-11-25: report in the Steward view, per model and per day; a daily cap per model; at a cap no promotions, stage 1 continues. Open: the default caps.
   - Settled 2026-11-25: default caps Haiku 5M, Sonnet 1.5M, Opus 0.4M tokens a day, editable.
23. **Its own finds:** what does it look at beyond confirmed targets: every non-`done` topic, the repositories and branches linked from topics, Slack, other sources? How often, given the cost (Q22)?
   - Partly answered 2026-11-25: also recent Google Docs (for example daily meeting transcripts) when Claude's connector is enabled; a low-cost model summarises, Sonnet low decides. Open: confirm the other candidates above; how far back "recent" goes (since the last wake?); how often.
   - Partly answered 2026-11-25: since the last check (owner, tentative). Open: how far back the first wake, or one after Steward was off, looks.
   - Settled 2026-11-25: the first wake, or the first after Steward was off, looks back 24 hours. Gathering runs on every wake.
24. **Where a finding lands** (reworded 2026-11-25 at the owner's request). When Steward finds something, Axiom can tell the owner in several places, loudest first: (a) a desktop notification that pops up; (b) an entry in the notifications pane (the bell); (c) the topic moves to Requires attention with the reason; (d) only a finding in the topic's history. Does every finding go to the same place, or does Steward choose per finding (for example "CI failed on the PR you want merged today" → pop-up; "this topic looks stale" → pane only)? If it chooses, is that stage 2's call, and can the owner set fixed rules per kind of finding on top (01 already lets the owner mute a kind of notification)?
   - 2026-11-25: the owner's reply under Q24 was about the memory (Steward manages it itself; see Decisions). Where a finding lands is still open; asked again.
   - Answered 2026-11-25: the Steward view by default; urgent ones also as a desktop notification. Open: what counts as urgent (stage 2's call, per-kind rules from the owner, or both).
   - Answered 2026-11-25: stage 2 decides.
   - (Per-kind rules from the owner on top of stage 2 are not in the first build.)
25. **Promotion to a stronger model:** what makes stage 2 promote work (for example a CI failure on a favourite topic, a finding repeated across two wakes, the owner asking for it from the card), which model and effort stage 3 uses, and what keeps it rare (a cap per day, a token budget for promoted work)? "Stable" (owner) suggests a fixed rule rather than the model's own judgement each time; confirm.
   - Partly answered 2026-11-25: it depends on the complexity of the task. Open: Q34.
26. **Connectors in Steward's runtime:** are Claude's claude.ai connectors (Google Drive, Slack) available to a headless run (`claude -p`) or a T3 thread started by Axiom? Needs a test. In the owner's T3 Claude session on 2026-11-25, Google Drive showed as needing authorisation.
   - 2026-11-25, owner: this machine's Claude has no connectors; the owner expects it to work. Untested: check on a machine with connectors before relying on Google Docs or Slack. When a connector is missing, Steward treats it as a blind spot (an unreachable source) rather than failing.
   - Deferred 2026-11-25: build without depending on it; a missing connector is a blind spot. Test on a machine with connectors.
27. **Detecting blind spots:** which stage does it (stage 2 while deciding, a separate pass, or both), and is there a fixed checklist (sources unreachable, topics missing a goal or target) alongside the model's own judgement?
   - Answered 2026-11-25: both, a fixed checklist and the model's judgement. Open: which stage runs each (the checklist needs no model).
   - Settled 2026-11-25: the checklist runs in Axiom's code before stage 1; stage 2 adds judgement.
28. **Asking:** where do questions appear (the notifications pane, the topic's card, a Steward questions list, a Steward thread), and can the owner answer in place, defer or dismiss? Is a question one of the levels in Q24?
   - Partly answered 2026-11-25: in the UI, in a separate Steward section; the owner can dismiss. Open: answer in place there (a text box per question)? Defer? Does a new question also raise a notification?
   - Settled 2026-11-25: answered in place; no defer; questions raise no desktop notification.
29. **Not nagging:** how many questions at most per wake or per day; are they batched (for example one digest); what happens to one that goes unanswered (asked again, expires, raised louder)?
   - Answered 2026-11-25: batched, no limit; the owner dismisses as needed. Open: does an unanswered question simply stay until answered or dismissed, and does Steward avoid asking a dismissed question again?
   - Settled 2026-11-25: an unanswered question stays until answered or dismissed; a dismissed one is not asked again unless its subject changes.
30. **Where answers go:** Steward's memory only, or also the tracker (a topic's goal or status note, a new monitoring target, a link), and does the answer become a history entry on the topic? Can the owner see and edit what Steward has learned?
   - Answered 2026-11-25: topics first (Steward checks and updates the topic), the Steward memory only for general-purpose knowledge; the owner can view the memory. Open: Q32.
31. **The Steward section of the UI:** where does it sit (a third view beside Tracker and Desk, a pane, a page behind the Desk's Steward toggle), and what else belongs there: the per-model token report (Q22), settings for each stage's model and effort, its recent wakes and findings, the on/off toggle? See 02.
   - Partly answered 2026-11-25: a third view, beside Tracker and Desk. Open: which of the other items live there.
   - Settled 2026-11-25: layout B holds the brief, questions, findings, suggestions, memory core, token use and wakes; settings open from the top bar.
32. **The Steward memory:** can the owner edit, delete or add memory items, or only view them? What counts as general-purpose knowledge (for example "this repo merges main instead of rebasing", "standups are at 10")? When Steward updates a topic from what it learned, is that a normal history entry written by Steward (ties to Q17)?
   - Answered 2026-11-25: the owner views it, edits it directly, and can chat with Steward; Steward manages the memory itself, in a managed store, not one plain file. Open: Q33, Q35.
33. **The Steward chat:** is it one long-running conversation or a new one each time? Which model and effort does it use (a stage setting of its own)? Can the owner ask it to do things in the chat (check a topic now, promote a task), within the autonomy rule, or is it for talking about what it knows?
   - Partly answered 2026-11-25: a fresh conversation each time; Steward takes notes as it goes and keeps the important parts. Open: the chat's model and effort; whether the owner can ask it to act from the chat.
   - Partly answered 2026-11-25: model and effort picked in the chat, separate from the wakes' stage settings. Open: whether the owner can ask it to act from the chat.
   - Answered 2026-11-25: yes, the owner can ask it to act from the chat, within the autonomy rule.
   - (The chat's model and effort are picked in the chat; see Decisions.)
34. **Judging complexity:** who judges a task's complexity (stage 2), on what scale (for example simple / medium / hard), and does the owner map each level to a model and effort in the per-stage settings? Is there a level that is never promoted, only reported? This is how "stable" (Q25) would be kept: the model picks the level, the owner's mapping picks the model.
   - Answered 2026-11-25: yes, for now (see Decisions). Open: the levels and their default models.
   - Settled 2026-11-25: simple / medium / hard; defaults simple → Sonnet medium, medium → Opus high, hard → report only.
35. **The memory store:** what shape is it: items in Axiom's database (05) with a kind, a source and a date, searchable, which Steward adds to, merges and retires? The autonomy rule says Steward never deletes anything alone: is retiring or deleting its own memory items exempt, as its own data (like its `axiom/…` branches), or does it only mark them retired and the owner deletes?
   - Answered 2026-11-25: yes to that shape; its own memory is exempt from "never delete". Owner's caveat on finding things: Q36.
36. **Recall** (owner: the trap of "not being able to find things it _should_ remember because it's looking for the wrong thing"). Search alone fails when Steward doesn't know what to search for. Which of these does it use: (a) a small core it always loads on every wake and chat (what it considers most important, kept short by Steward itself); (b) items tied to topics, repositories or people, pulled in automatically whenever that topic, repo or person comes up, with no search needed; (c) more than one way to search (exact words and meaning-based search); (d) a periodic tidy pass where Steward merges items and rewrites the core; (e) a recall test: a set of facts it should know, checked from time to time so a regression shows?
   - 2026-11-25: the owner asked what (a) means. Explained: each wake and chat starts with an empty context, so anything Steward must search for can be missed. The core is a short block of memory put into every stage-2 run and chat automatically, the way a project's CLAUDE.md is: the few facts it must never miss, plus an index of what else the memory holds, so it knows what to look for. Steward keeps it short (it costs tokens on every wake); the owner sees and edits it in the Steward view. Still open.
   - Answered 2026-11-25: (a) core, (b) attached memory and (d) tidy-up for the first build; (c) and (e) later if needed. Open: how short the core must be, and how often the tidy-up runs.
   - Settled 2026-11-25: core about 2k tokens; tidy-up daily on the first wake of the day.
37. **GitHub webhooks for a local app:** Axiom runs locally, so GitHub can't call it directly. Options: a forwarder (for example the `gh webhook forward` extension, which needs admin rights on the repository or organisation), a relay service, or the timed check only. Owner work repos may not allow creating webhooks. Which does the first build try, and is the timed check's interval the 30-minute wake or its own?
   - Settled 2026-11-25: no webhooks in the first build; `gh` polling every 10 minutes in working hours wakes Steward on a change.
38. **Which Steward view layout:** A (inbox), B (briefing), C (stream), or a mix? And are the Desk additions (top-bar toggle and count, the card strip with a per-topic switch) right?
   - Answered 2026-11-25: B; the Desk additions as mocked.
39. **Steward's icon:** which design? Candidates in `docs/design/mockups/steward-icons.html`.
   - Answered 2026-11-25: Facet, for now.
