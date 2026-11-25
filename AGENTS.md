# Agent guidance for Axiom

## Phase: spec first

Axiom is in the spec phase. Do not write application code, pick dependencies or scaffold a framework until the owner settles the relevant spec section and its stack decision is recorded as an ADR.

## Working on the spec

- The spec lives in `docs/spec/`, one file per area. `docs/spec/README.md` is the index and holds each section's status.
- Section status is one of `stub`, `draft`, `review`, `settled`. Only the owner moves a section to `settled`.
- Each section keeps three parts: **Intent** (what the owner has said, kept close to their words), **Decisions** (settled, dated), and **Open questions** (numbered, never renumbered; mark answered ones with the answer and date instead of deleting them).
- Do not invent features or decisions. When something is unclear, add it as an open question and ask.
- A decision with real alternatives or long-term cost also gets an ADR in `docs/adr/` (copy `docs/adr/0000-template.md`), linked from the section.
- New terms go into `CONTEXT.md` the first time a section uses them.

## Cross-session context

Session history for this project is kept in GPT Command Center: `~/Documents/notes/GPTCommandCenter/docs/work/axiom-spec.md`. Axiom is meant to replace that system; until it does, keep logging there.
