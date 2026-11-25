# 02. Multi-task UI

- Status: stub

## Intent

Axiom is part multi-task UI, used through a web view of a locally run app. It is the main place the owner works. The agents working there create Axiom topics (see 01).

## Decisions

- 2026-11-25: The multi-task view is a separate vertical of the application, not a layout of the tracker (09).
- 2026-11-25: There is a notifications pane (see 01 for what raises notifications). It has settings to mute kinds of notification; a single topic can also be muted.
- 2026-11-25: The multi-task UI is the owner's main workspace, but it is not part of the first usable version (that is the tracker, see 00).

## Open questions

1. What is on screen at once: a board of work items, a set of live agent sessions, or both side by side?
2. Can the owner watch and steer a running agent from Axiom (read output, send messages, approve permissions), or only see its status?
3. How is attention managed across many tasks: notifications, an inbox, a "needs you" queue?
   - Partly answered 2026-11-25: the tracker's "requires attention" view is the main signal (see 01). When an agent stops, its topic is highlighted until the owner clicks it (01). There is also a notifications pane listing them.
4. Desktop only, or must it work on a phone too (for example over the LAN or a tunnel)?
5. How does it relate to T3 Code, which already runs multiple threads: replace it, embed it, or sit next to it?
6. Until the multi-task UI exists, where do agents run and create topics from: Claude Code / T3 sessions calling the v1 tooling?
