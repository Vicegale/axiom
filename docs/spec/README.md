# Axiom spec

Each section is one file with **Intent**, **Decisions** and **Open questions**. Status is `stub` → `draft` → `review` → `settled`; only the owner settles a section.

| # | Section | Covers | Status |
| --- | --- | --- | --- |
| 00 | [Vision](00-vision.md) | What Axiom is, who it is for, goals and non-goals | settled |
| 01 | [Tracker](01-tracker.md) | Topics, tickets, epics, threads, specs, tasks; statuses; fields | settled |
| 02 | [Multi-task UI](02-multi-task-ui.md) | The Desk: many topics and their agents on one screen | draft |
| 03 | [Faux-always-on agent (Steward)](03-ambient-agent.md) | The agent that seems always present: triggers, memory, voice, jobs | settled |
| 04 | [Agent connectors](04-agent-connectors.md) | Talking to agents through their services and CLIs | settled |
| 05 | [Data model and storage](05-data-model.md) | The internal database | settled |
| 06 | [Architecture](06-architecture.md) | Local app + web view, process model, stack | settled |
| 07 | [Work-log migration](07-work-log-migration.md) | Replacing GPT Command Center's `docs/work/` | stub |
| 08 | [History](08-history.md) | What a topic's history is made of, now that there is no log | settled |
| 09 | [Visual design](09-visual-design.md) | Look, layout and density of the UI | settled |

Suggested order: 01 next (it is v1: settle the topic core fields, status rules, specs and tasks), then 03's autonomy rule, then 04 and 05 (needed to build v1), then 06, 02, 07.
