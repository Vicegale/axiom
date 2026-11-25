# Architecture Decision Records

One file per decision, numbered: `0001-short-slug.md`. Copy [0000-template.md](0000-template.md). Write an ADR when a decision has meaningful alternatives or future maintenance cost (stack, storage, process model, connector protocol). Never edit a settled ADR's decision; supersede it with a new one.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-local-server-and-browser.md) | Local server, opened in the browser | accepted |
| [0002](0002-typescript-node-stack.md) | TypeScript on Node 24, React + Vite + Tailwind | accepted |
| [0003](0003-sqlite-storage.md) | SQLite as Axiom's database | accepted |
| [0004](0004-cli-writes-database-directly.md) | The CLI writes to the database directly | accepted |
| [0005](0005-providers-claude-code-and-t3.md) | Two providers: Claude Code directly and the T3 service | accepted |
| [0006](0006-steward-headless-claude.md) | Steward runs as headless Claude Code calls | accepted |
