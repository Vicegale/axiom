# Axiom

Axiom is part issue tracker, part multi-task UI, part faux-always-on agent.

- **Tracker**: the place where work items, their context and their history live.
- **Multi-task UI**: one view for many concurrent pieces of work, including the agents working on them.
- **Faux-always-on agent**: an agent that feels always present (in the spirit of dots or the Grok bot) without literally running all the time.

Long term, Axiom replaces the work-log system in GPT Command Center (`docs/work/`). It keeps its own internal database and connects to agents directly through their services and CLIs. It runs locally and is used through a web view.

## Status

The tracker (plan [docs/plan/v1-tracker.md](docs/plan/v1-tracker.md)) and the Desk ([docs/plan/desk.md](docs/plan/desk.md)) are built; the Steward (spec 03) and the work-log migration (07) are not started. The spec starts at [docs/spec/README.md](docs/spec/README.md).

## Install (Linux and macOS)

Needs Node 24 or newer (Axiom uses `node:sqlite`) and npm; Claude Code (`claude` on PATH) for Claude Code threads and Desk summaries; T3 Code (`~/.t3/bin/t3`) for T3 threads. Both providers are optional.

```sh
git clone <this repo> ~/projects/axiom   # see "Another machine" below
cd ~/projects/axiom
scripts/install.sh                       # --help for options
axiom server                             # then open http://127.0.0.1:4477
```

The script checks the requirements, runs `npm ci` and the build, links `axiom` and `axiom-server` into `~/.local/bin` (`--bin-dir` to change it; it tells you if that folder isn't on PATH), and links the `axiom` skill into `~/.claude/skills`. Then it asks two questions (both default to no, and are skipped without a terminal):

1. Add Axiom's hooks to `~/.claude/settings.json`? (a backup is made; `--hooks` / `--no-hooks` answer it)
2. Start the server now and at every login? This sets up a user service, systemd on Linux and launchd on macOS (`--service` / `--no-service`). Once set up, every later run restarts it on the new build without asking.

`--yes` answers yes to both. The script never touches `~/.t3`.

**Updating:** `git pull && scripts/install.sh`. The service, if you set one up, is restarted; a server started by hand needs a restart (the web app shows a banner when the server is older than the build).

**Another machine:** the repository is local only. Either clone it over SSH from the machine that has it (`git clone ssh://<host>/home/<you>/projects/axiom`, then `git pull` to update), or carry a bundle: `git bundle create axiom.bundle --all` here, `git clone axiom.bundle ~/projects/axiom` there. Never copy `node_modules`: the install builds it for that system.

**The service by hand:** `axiom server install` writes `~/.config/systemd/user/axiom.service` (Linux) or `~/Library/LaunchAgents/local.axiom.server.plist` (macOS, logs in `~/Library/Logs/axiom/`) and prints the `systemctl --user` / `launchctl` commands to enable it. The service keeps the PATH you installed with, so it finds `claude` and `t3`; re-run it after moving them.

**Paths:** the database is `$AXIOM_DB`, else `$XDG_DATA_HOME/axiom/axiom.db`, else `~/.local/share/axiom/axiom.db` (macOS too). T3's data folder is `~/.t3/userdata` (`AXIOM_T3_DIR` overrides it). The hooks call the `node` that ran the install by its full path: after switching Node versions (nvm, fnm), re-run `scripts/install.sh`.

**Removing:** `axiom hooks uninstall`, then delete the `~/.local/bin/axiom*` and `~/.claude/skills/axiom` links and the service file if you wrote one. The database stays until you delete it.

## Layout

| Path | What lives there |
| --- | --- |
| `docs/spec/` | The specification, one file per area, with an index and per-section status |
| `docs/plan/` | Build plans: [v1-tracker.md](docs/plan/v1-tracker.md), [desk.md](docs/plan/desk.md) |
| `packages/` | `core` (database), `cli` (`axiom`), `server` (API + providers), `web` (the app) |
| `scripts/` | `install.sh`, the demo seed |
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

`~/.local/bin/axiom` and `~/.local/bin/axiom-server` are symlinks to the built entry points (`packages/cli/dist/index.js`, `packages/server/dist/cli.js`), made by `scripts/install.sh`, so keep `main` built (`npm run build`).

- `axiom server` (or `axiom server start --port N`) runs the server in the foreground at http://127.0.0.1:4477.
- `axiom server install [--dry-run] [--platform linux|darwin]` writes the user service (systemd on Linux, launchd on macOS) and prints the commands to enable it. It never enables anything itself.
