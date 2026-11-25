# Axiom

**Axiom keeps track of everything you and your coding agents are working on.** It is your command center: every agent on one screen, the state of every piece of work in one place, and the things that need you at the top.

Axiom runs on your own machine: a small local server with its own SQLite database, used through your browser. It connects to your agents through the tools they already run on: Claude Code and T3 Code. There are no accounts, and your data stays on your machine.

## What it does

### The tracker

Every piece of work is a **topic**: a goal, a status, a one-line status note, and a history of what happened.

- **Agents record their own work.** An agent in Claude Code or T3 uses the `axiom` CLI (and the bundled skill) to create its topic, attach its session, and write history as it goes: notes, decisions, findings, verifications and next steps.
- **Statuses that follow the agents.** A topic is `wip` while its agent runs and settles by itself when the agent stops: `hitl` when it needs you, `review` with a PR, `monitoring`, `blocked`, `done`, or back to `idle`. You can mark old work `stale`.
- **Three views:** what's ongoing, what requires your attention, and what is being monitored.
- **Tasks with dependencies.** Plans become tasks with a status and the tasks they wait on, drawn as a dependency graph.
- **Links and artifacts.** Repositories, branches, worktrees, PRs, specs and artifacts are linked from the topic. Specs and plans open in the app as rendered Markdown (with Mermaid diagrams).
- **Tickets and epics** group topics, and can be linked to their Jira ticket.
- **Notifications** when an agent stops or needs you, with per-kind and per-topic muting.
- Three tracker layouts (Board, Inbox, Console), switchable in settings.

### The Desk

A grid of cards, one per topic, to watch and steer many agents at once.

- **What happened, in one line.** Each time a thread stops, a Haiku summary says what the agent did and what it needs from you next; the full reply is one click away, rendered as Markdown.
- **Live activity:** a running thread shows the step it is on (`$ npm test`, `Reading app.ts`, ...).
- **Reply from the card:** to the selected thread, or as a new thread on the topic, with a model and effort picker.
- **Answer agents from the card:** approve or deny Claude Code permission prompts, and answer T3 questions.
- **New topic:** create a topic and start its first agent thread in one step.
- **Arrange it your way:** favourites, hiding, drag to reorder or sort by "ready first", and choose how many cards per row.

### Coming later

An ambient agent (the "Steward") that wakes on a schedule, watches your topics and their PRs, and tells you about problems before you go looking. It suggests, but never overwrites your work.

## Requirements

- macOS or Linux
- Node.js 24 or newer, with npm
- At least one agent tool:
  - Claude Code, with `claude` on your PATH (it also writes the Desk summaries)
  - T3 Code, with its CLI at `~/.t3/bin/t3`

## Install

```sh
git clone <repository-url> axiom
cd axiom
scripts/install.sh
```

The installer checks the requirements, builds Axiom, puts `axiom` and `axiom-server` on your PATH (in `~/.local/bin`; it tells you if that folder isn't on PATH yet), and installs the `axiom` skill for your agents: in `~/.claude/skills` for Claude Code (and T3 Code's Claude threads), and in `~/.codex/skills` and `~/.agents/skills` when those tools' folders exist. It then asks two questions:

1. **Add Axiom's hooks to Claude Code?** They let Axiom see your Claude Code sessions, show their live step, and route their permission prompts to the Desk. Your settings file is backed up first.
2. **Start the server now and at every login?** This sets it up as a user service (systemd on Linux, launchd on macOS).

Then open **http://127.0.0.1:4477**.

Run `scripts/install.sh --help` for the options: `--yes` answers yes to both questions, `--hooks` / `--no-hooks` and `--service` / `--no-service` answer one of them, and `--bin-dir` changes where the commands go.

**Updating:** `git pull && scripts/install.sh`. The service restarts on the new build; restart a server you started by hand. The app shows a banner when the server is older than the build.

**Without the service:** run `axiom server` (add `--port N` to change the port) whenever you want Axiom up.

## Using it with your agents

Axiom only tracks projects that opt in. Add this line to a project's `AGENTS.md` or `CLAUDE.md`:

> Track work in Axiom (see the `axiom` skill).

Agents working in that project then keep their topic up to date on their own. Threads you start from the Desk are attached to their topic automatically.

You can also use the CLI yourself:

```sh
axiom topic list                 # what's going on
axiom topic show <slug>          # a topic: status, goal, links, recent history
axiom topic new <slug> --title "…" --goal "…"
axiom entry note "…"             # also: decision, finding, verification, next-steps
axiom task list                  # tasks and what they wait on
axiom --help                     # everything else; add --json to any command
```

## Your data

Everything lives in one SQLite database: `~/.local/share/axiom/axiom.db`, on macOS too. Set `AXIOM_DB` to put it elsewhere. The server keeps a daily backup of the last seven days in `backups/` next to it.

Axiom reads T3 Code's own database (`~/.t3/userdata`, or `AXIOM_T3_DIR`) but never writes to it. Agent summaries keep only the latest one per thread.

## Uninstall

```sh
axiom hooks uninstall
systemctl --user disable --now axiom.service                 # Linux, if you set up the service
launchctl bootout gui/$(id -u)/local.axiom.server             # macOS, if you set up the service
rm ~/.local/bin/axiom ~/.local/bin/axiom-server
rm -f ~/.claude/skills/axiom ~/.codex/skills/axiom ~/.agents/skills/axiom
```

Then delete the service file (`~/.config/systemd/user/axiom.service` or `~/Library/LaunchAgents/local.axiom.server.plist`) and, if you no longer want your data, `~/.local/share/axiom`.

## Development

Axiom is a TypeScript monorepo (npm workspaces): `packages/core` (the database), `packages/cli` (the `axiom` command), `packages/server` (the local API and agent providers) and `packages/web` (the React app).

```sh
npm install        # dependencies
npm run build      # build every package
npm test           # tests
npm run lint       # Biome
npm run typecheck  # type-check every package
npm run dev        # web dev server
```

The design lives in [`docs/spec/`](docs/spec/README.md), the architecture decisions in [`docs/adr/`](docs/adr/README.md), and the vocabulary in [`CONTEXT.md`](CONTEXT.md).
