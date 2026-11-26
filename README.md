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

### Steward

An agent that seems always present: it wakes on a schedule, reads what changed across your topics and their pull requests, and tells you about problems before you go looking. It is **off** until you switch it on in the top bar, and it runs on your Claude Code subscription.

- **Wakes** every 30 minutes in your working hours, and also when a watched PR changes or an agent stops on a topic in `monitoring` or `review`. **Run now** (in its settings) starts one at any time. A cheap model (Haiku) gathers what changed; a stronger one (Sonnet, low effort) decides what to tell you and how loudly.
- **Watches pull requests** with `gh` every 10 minutes, at no token cost: CI failures, changes requested, new comments, a conflict coming with main, no reviewer for days, ready to merge.
- **Findings and questions.** Urgent findings raise a desktop notification; everything lands on the **Steward** page (a third page beside Tracker and Desk) and on the topic's card on the Desk. When it lacks information (a PR with no topic, a topic without a goal, a source it can't reach) it asks you.
- **Prepared fixes, only when worth it.** A finding that deserves it is promoted to a stronger model, by how complex it is (you choose the model per complexity, or "report only"). The fix is built on an `axiom/fix/…` branch in its own worktree and offered only if Axiom's own test run passes. **Adopt** applies it to your branch locally; it never pushes.
- **Keeps branches fresh.** A branch behind main with a conflict coming (or in review) is rebased onto main locally when that is safe: clean checkout, nobody else pushed, a clean rebase. The old tip is saved first and **Undo** restores it. Otherwise it offers a rebased copy. It never pushes.
- **Tidies the tracker** in clear-cut cases (a topic still in `review` after its PR merged becomes `done`), marked as Steward's in the history, with Undo.
- **Memory.** A short core it always reads, notes attached to topics, repositories and people, and a daily tidy-up. You can read and edit it on its own page; your own notes are read-only for Steward.
- **Chat** with it from the top bar: ask what's going on, tell it something to remember, or ask it to check a topic now.
- **Your budget.** Models and efforts per stage, daily token caps per model, and today's token use per model, all on the Steward page.

What Steward may do on its own, and what it never does (push, merge, post anywhere, delete your work), is spelled out in [`docs/spec/03-ambient-agent.md`](docs/spec/03-ambient-agent.md).

## Requirements

- macOS or Linux
- Node.js 24 or newer, with npm
- At least one agent tool:
  - Claude Code, with `claude` on your PATH (it also writes the Desk summaries)
  - T3 Code, with its CLI at `~/.t3/bin/t3`
- For Steward: `claude` on your PATH, and the GitHub CLI `gh`, logged in, to watch pull requests. Slack and Google Drive are read when your Claude Code has those connectors.

## Install

```sh
git clone <repository-url> axiom
cd axiom
scripts/install.sh
```

The installer checks the requirements, makes a **release copy** of Axiom (a detached git worktree of `main` at `~/.local/share/axiom/app`, with its own `npm ci` and build), puts `axiom` and `axiom-server` on your PATH (in `~/.local/bin`; it tells you if that folder isn't on PATH yet), and installs the `axiom` skill for your agents: in `~/.claude/skills` for Claude Code (and T3 Code's Claude threads), and in `~/.codex/skills` and `~/.agents/skills` when those tools' folders exist. It then asks three questions:

1. **Add Axiom's hooks to Claude Code?** They let Axiom see your Claude Code sessions, show their live step, and route their permission prompts to the Desk. Your settings file is backed up first.
2. **Let agents run `axiom` without asking?** Agents call the CLI many times per task. This adds a `Bash(axiom *)` allow rule to Claude Code, and lets Codex's sandbox write Axiom's data folder (`writable_roots` in `~/.codex/config.toml`). Both files are backed up first; `axiom agents disallow` undoes it. Skipped when it's already in place.
3. **Start the server now and at every login?** This sets it up as a user service (systemd on Linux, launchd on macOS).

Then open **http://127.0.0.1:4477**.

Run `scripts/install.sh --help` for the options: `--yes` answers yes to every question; `--hooks` / `--no-hooks`, `--allow-agents` / `--no-allow-agents` and `--service` / `--no-service` answer one of them, and `--bin-dir` changes where the commands go, `--ref <commit-ish>` picks what to install (default `main`) and `--app-dir` (or `AXIOM_APP_DIR`) moves the release copy.

The live `axiom` command, the Claude Code hooks, the skill and the service all run from the release copy, so builds, new migrations and uncommitted or untracked files in your checkout never reach the real database or your agents' hooks. Only committed work does, when you update.

**Updating:** from your checkout, `scripts/install.sh` (add `--ref <commit-ish>` for something other than `main`). It moves the release copy to that commit, rebuilds, re-points the commands, hooks and service, and restarts the service on the new build; it refuses if the release copy has local changes; restart a server you started by hand. The app shows a banner when the server is older than the build.

**Without the service:** run `axiom server` (add `--port N` to change the port) whenever you want Axiom up.

**Restarting:** `axiom server restart` restarts the service (systemd or launchd) and waits until it answers again. A server you started by hand is left alone: stop it and run `axiom server` again.

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

Steward from the command line (agents use the first four; the bundled skill tells them how):

```sh
axiom steward status             # on or off, next and last wake, what's open
axiom steward items --topic <slug>    # its open findings, questions and suggestions
axiom steward memory --topic <slug>   # what it remembers about a topic
axiom steward check <slug>       # ask it to look at a topic now (once per topic every 10 minutes)
axiom steward usage              # tokens today per model, against the caps
axiom steward on | off | run     # yours only, like memory add / edit / retire / delete / restore
```

Agents can read Steward and ask for a check, but never answer its questions, change its memory or switch it on or off; those commands refuse them.

## Your data

Everything lives in one SQLite database: `~/.local/share/axiom/axiom.db`, on macOS too. Set `AXIOM_DB` to put it elsewhere. The server keeps a daily backup of the last seven days in `backups/` next to it.

Axiom reads T3 Code's own database (`~/.t3/userdata`, or `AXIOM_T3_DIR`) but never writes to it. Agent summaries keep only the latest one per thread.

Steward keeps its findings, memory and token use in the same database. Its own branches are named `axiom/…` and live in worktrees under `~/.local/share/axiom/worktrees`; before rebasing one of your branches it saves the old tip as `refs/axiom/backup/<branch>/<time>` in that repository.

## Uninstall

```sh
axiom hooks uninstall
axiom agents disallow
systemctl --user disable --now axiom.service                 # Linux, if you set up the service
launchctl bootout gui/$(id -u)/local.axiom.server             # macOS, if you set up the service
rm ~/.local/bin/axiom ~/.local/bin/axiom-server
git -C <your checkout> worktree remove --force ~/.local/share/axiom/app   # the release copy
rm -f ~/.claude/skills/axiom ~/.codex/skills/axiom ~/.agents/skills/axiom
```

If Steward prepared fixes or rebase copies you never adopted or discarded, remove them from each repository with `git worktree prune` and `git branch -D axiom/…`.

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

The design lives in [`docs/spec/`](docs/spec/README.md), the architecture decisions in [`docs/adr/`](docs/adr/README.md), the build plans in [`docs/plan/`](docs/plan/), and the vocabulary in [`CONTEXT.md`](CONTEXT.md).

Work in this checkout never reaches your live Axiom until you commit it and run `scripts/install.sh`, so you can build, test and add migrations freely.
