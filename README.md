# Axiom

Axiom is part issue tracker, part multi-task UI, part faux-always-on agent.

- **Tracker**: the place where work items, their context and their history live.
- **Multi-task UI**: one view for many concurrent pieces of work, including the agents working on them.
- **Faux-always-on agent**: an agent that feels always present (in the spirit of dots or the Grok bot) without literally running all the time.

Long term, Axiom replaces the work-log system in GPT Command Center (`docs/work/`). It keeps its own internal database and connects to agents directly through their services and CLIs. It runs locally and is used through a web view.

## Status

Spec phase, with the first build planned in [docs/plan/v1-tracker.md](docs/plan/v1-tracker.md). There is no code yet. Start at [docs/spec/README.md](docs/spec/README.md).

## Layout

| Path | What lives there |
| --- | --- |
| `docs/spec/` | The specification, one file per area, with an index and per-section status |
| `docs/plan/` | Build plans; the first is [v1-tracker.md](docs/plan/v1-tracker.md) |
| `docs/plan/` | Build plans; the first is [v1-tracker.md](docs/plan/v1-tracker.md) |
| `docs/adr/` | Architecture Decision Records for decisions with real alternatives |
| `CONTEXT.md` | Glossary: the words Axiom uses and what they mean |
| `AGENTS.md` | Rules for agents working in this repo |

## Development

Requires Node 24 and npm (npm workspaces: `packages/core`, `cli`, `server`, `web`).

```sh
npm install        # install all workspace dependencies
npm run build      # build every package (tsc -b, then vite build)
npm test           # vitest over all packages
npm run lint       # biome check
npm run format     # biome format --write
npm run typecheck  # type-check every package
npm run dev        # start the web dev server
```

### Commands on PATH

`~/.local/bin/axiom` and `~/.local/bin/axiom-server` are symlinks to the built entry points (`packages/cli/dist/index.js`, `packages/server/dist/cli.js`), so keep `main` built (`npm run build`).

- `axiom server` (or `axiom server start --port N`) runs the server in the foreground at http://127.0.0.1:4477.
- `axiom server install [--dry-run]` writes `~/.config/systemd/user/axiom.service` and prints the `systemctl --user` commands to enable it. It never enables anything itself.
