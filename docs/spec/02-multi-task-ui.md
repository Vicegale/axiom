# 02. Multi-task UI ("Desk")

- Status: draft

## Intent

Axiom is part multi-task UI, used through a web view of a locally run app. It is the main place the owner works. The agents working there create Axiom topics (see 01).

The owner's reference for it is a screen called **Desk** ([docs/design/references/desk.png](../design/references/desk.png), 2026-11-25; private text is redacted in red). In the owner's words:

- I can see the operations of multiple agents on the same screen (the top right controls the sorting and the number per row).
- Each item on this screen is a topic. It can contain its own threads.
- There is a Haiku summary of the agent's last reply, which summarises the last agent response and what needs to be done next (by me).
- It also includes a collapsible section to view the full reply of the agent (in Markdown).
- It also includes a text box to reply, along with a model and effort picker and the option to send in the selected thread or start a new one attached to this topic.
- Topics can be favourited in this view, and drag sorted (see the Are We Leonida Yet? dashboard, 09 References).
- Change from the reference: the reply box stays hidden until the owner decides to reply, to save screen space.

### What the reference shows (reading of the screenshot)

- **Top bar:** view switch (Board / Desk), a "Steward off" toggle, the count of active topics, a notifications bell, provider health ("T3 ready"), `+ New topic`, the count of hidden topics, the sort control (`Ready first` / `Fixed`) and the cards-per-row control (`1 2 3 4 N`).
- **A card per topic:** title; topic status and thread run state pills (`doing`, `review`, `blocked`, `idle`); favourite star, hide and open (↗) icons; task progress ("No tasks yet"); last worked date; link count.
- **Thread selector** on the card: which of the topic's threads the card shows; the thread's run state ("finished 6d ago", failed commands) and a context-usage meter (`ctx`).
- **RUN line:** a one-line summary of the latest run.
- **Now:** the Haiku summary of the latest reply and what the owner needs to do next.
- **Latest reply · 6d ago, show ▾:** the full reply, collapsible, rendered as Markdown.
- **Reply area:** text box, model and effort picker, `Send` (to the selected thread) and `New thread` (a new thread attached to this topic).

## Decisions

- 2026-11-25: The multi-task view is a separate vertical of the application, not a layout of the tracker (09).
- 2026-11-25: There is a notifications pane (see 01 for what raises notifications). It has settings to mute kinds of notification; a single topic can also be muted.
- 2026-11-25: The multi-task UI is the owner's main workspace, but it is not part of the first usable version (that is the tracker, see 00).
- 2026-11-25: The Desk is a grid of topic cards as in the reference: several agents' work on one screen; cards per row and sort order chosen in the top bar; favourites; drag to reorder.
- 2026-11-25: Each card shows one of its topic's threads (selectable), a Haiku summary of that thread's latest reply plus what the owner must do next, and the full reply collapsible as Markdown.
- 2026-11-25: The owner can reply from the card: to the selected thread, or as a new thread attached to the topic, with a model and effort picker. The reply box is hidden until the owner chooses to reply.
- 2026-11-25 (amended): the reply box is a collapsible composer: collapsed to one line (with a draft preview) on every card, expanding to a rounded box with its controls inside (thread / provider / model / effort chips, collapse, round Send). "New thread" is a choice of the thread chip.
- 2026-11-25: Replying works for both providers: T3 threads (through T3's API) and direct Claude Code sessions (by resuming the session).
- 2026-11-25: The Haiku summary is made each time a thread stops, using the owner's subscription (not an API key). Summaries are ephemeral: only the latest is kept, on the thread, never in history.
- 2026-11-25: Claude Code approvals from the card use a blocking `PermissionRequest` hook that waits for the owner's answer in Axiom, falling back to the terminal prompt after a timeout.
- 2026-11-25: Sort orders: "Ready first" puts topics where the owner is next on top (waiting for them, stopped with a question, in review); "Fixed" is the owner's drag order. Favourites are always first in both.
- 2026-11-25: Hiding a topic hides it from the Desk only; it stays in the tracker.
- 2026-11-25: The owner can approve or deny a thread's permission prompt from its card.
- 2026-11-25: The composer always shows where the message goes: a `This thread | New thread` switch (no longer only an option of the thread chip); the thread chip remains for topics with several threads.
- 2026-11-25: The card shows the selected thread's current model, effort and context usage, and the topic's Artifacts menu (plan D9, D10).
- 2026-11-25: The card shows the selected thread's working subagents (count on the run line, a list on demand), for T3 and Claude Code threads (plan D11).
- 2026-11-25: A thread started from Axiom (new topic or "New thread") gets an Axiom briefing before the owner's first message: that it is tracked and attached, the topic (slug, title, status, goal, status note), its open tasks, where the work lives, and the commands to use. History keeps only the owner's words.
- 2026-11-25: "Steward" is the proactive agent (03), shown on the Desk as an on/off toggle. It is built later; the toggle comes with it.

## Open questions

1. What is on screen at once?
   - Answered 2026-11-25: a grid of topic cards (the Desk).
2. Can the owner watch and steer a running agent from Axiom?
   - Answered 2026-11-25: yes: read the summary and full reply, and send replies or start new threads from the card. Approving permissions from Axiom: open (Q12).
3. How is attention managed across many tasks?
   - Partly answered 2026-11-25: the tracker's "requires attention" view, the topic highlight, the notifications pane (01); on the Desk, the "Ready first" sort (Q9) and the "Now" summary.
4. Desktop only, or must it work on a phone too?
5. How does it relate to T3 Code? Replace it, embed it, or sit next to it?
   - Partly answered 2026-11-25: the Desk sends messages to agent threads itself, so for day-to-day steering it takes over from T3's UI; T3 (or Claude Code) still runs the agents. See Q7.
6. Until the multi-task UI exists, where do agents run and create topics from?
   - Answered by the first build: Claude Code and T3 sessions using the `axiom` CLI and skill.
7. **How does Axiom send a message?** For T3 threads, through T3's API (`orchestration.dispatchCommand` / `launchThread`), which needs an authenticated connection (Axiom only reads T3's database today, ADR 0005). For direct Claude Code sessions, `claude -p --resume <session>` in the session's folder, which clashes with a session still open in a terminal. Which providers can be replied to in the first Desk build?
   - Answered 2026-11-25: both. Open: T3's API needs an authenticated connection (research before building); a Claude Code session still open in a terminal cannot safely be resumed elsewhere (proposal: the card offers the resume command instead while the session is open).
8. **The Haiku summary:** when is it made (every time a thread stops), how (a `claude -p --model haiku` call on the owner's subscription, or the API with a key), what goes in (the last reply only, or recent history), and is it stored as a history entry? Which provider supplies the reply text (T3's database has messages; Claude Code transcripts are files)?
   - Partly answered 2026-11-25: made each time a thread stops, on the subscription (`claude -p --model haiku`). Proposal: the latest summary is kept on the thread (not as a history entry, so history isn't flooded); confirm.
9. **Sort orders:** what do "Ready first" and "Fixed" mean exactly? A guess: Ready first = topics where the owner is next (hitl, stopped with a question, review) on top; Fixed = the owner's manual drag order. Are favourites always first?
   - Answered 2026-11-25: yes, as guessed; favourites always first.
10. **Hide:** is "hidden" a Desk-only filter (the topic stays in the tracker), and how does a hidden topic come back?
   - Answered 2026-11-25: Desk only. (Coming back: the top bar's "N hidden" opens the list to unhide.)
11. **Cards and statuses:** the reference shows a workflow pill (`doing`, `review`, `blocked`) next to a run pill (`idle`). Are these the topic status (01) and the selected thread's status, with Axiom's names?
12. **Approvals:** when a thread waits on a permission prompt, can the owner approve or deny from the card?
   - Answered 2026-11-25: yes.
13. **New topic:** does `+ New topic` create a topic and start its first thread with a first message (provider, project folder, model, effort)?
14. **The ctx meter:** context-window usage of the selected thread; where does it come from (T3 has it; Claude Code transcripts have token counts)?
   - Answered 2026-11-25 (owner asked for it): T3's provider turns carry `tokenUsage` (used, max); Claude Code's transcript carries `usage` per reply, with a 1M window for Claude 5 models. Shown with the model and effort on the thread row (plan D9).
15. **"Steward":** is that the proactive agent of 03, shown as an on/off toggle on the Desk?
   - Answered 2026-11-25: yes; implemented later with 03.
16. Reply box: hidden behind a "Reply" button on the card. Does it close again after sending, and do drafts survive a refresh?
