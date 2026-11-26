#!/usr/bin/env bash
# Installs Axiom on Linux or macOS from a release copy of this checkout. Safe to re-run: it is also
# the update step (`axiom update` pulls main, then runs it). Written for bash 3.2, the version
# macOS ships.
#
#   scripts/install.sh [--ref COMMIT] [--app-dir DIR] [--yes] [--no-hooks] [--no-allow-agents]
#                      [--no-service] [--no-skill] [--bin-dir DIR]
#
#   --ref         the commit, branch or tag of this repository to install (default: main)
#   --app-dir     where the release copy lives (default: ~/.local/share/axiom/app, or $AXIOM_APP_DIR)
#   --yes         answer yes to every question: hooks, agent access, service
#   --hooks       add Axiom's hooks to ~/.claude/settings.json without asking (a backup is made)
#   --no-hooks    leave ~/.claude/settings.json alone
#   --allow-agents     let agents run `axiom` without asking (Claude Code allow rule, Codex sandbox)
#   --no-allow-agents  leave agents' permissions alone
#   --service     run the server now and at every login (systemd / launchd) without asking
#   --no-service  don't set up the service (start it by hand: axiom server)
#   --no-skill    don't install the axiom skill (~/.claude/skills, and ~/.codex or ~/.agents if present)
#   --bin-dir     where the `axiom` and `axiom-server` links go (default: ~/.local/bin)
#
# The live Axiom (the `axiom` command, the hooks, the service) runs from the release copy: a detached
# git worktree of this repository at --ref, with its own node_modules and build. Working in this
# checkout (builds, new migrations, uncommitted or untracked files) never reaches it; only
# committed work does, when you run this script again. The script refuses to move a release copy
# that has local changes.
#
# Without a terminal to ask in, the questions default to no. A service set up before is restarted
# on every run, so it serves the new build. Never touches ~/.t3.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
APP="${AXIOM_APP_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/axiom/app}"
REF="main"
HOOKS="ask"
ACCESS="ask"
SKILL=1
SERVICE="ask"
PORT="${AXIOM_PORT:-4477}"

while [ $# -gt 0 ]; do
  case "$1" in
    --yes | -y) HOOKS="yes" ACCESS="yes" SERVICE="yes" ;;
    --allow-agents) ACCESS="yes" ;;
    --no-allow-agents) ACCESS="no" ;;
    --hooks) HOOKS="yes" ;;
    --no-hooks) HOOKS="no" ;;
    --service) SERVICE="yes" ;;
    --no-service) SERVICE="no" ;;
    --no-skill) SKILL=0 ;;
    --ref)
      [ $# -ge 2 ] || { echo "--ref needs a commit, branch or tag" >&2; exit 2; }
      REF="$2"
      shift
      ;;
    --app-dir)
      [ $# -ge 2 ] || { echo "--app-dir needs a folder" >&2; exit 2; }
      APP="$2"
      shift
      ;;
    --bin-dir)
      [ $# -ge 2 ] || { echo "--bin-dir needs a folder" >&2; exit 2; }
      BIN_DIR="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then B=$'\e[1m' D=$'\e[2m' Y=$'\e[33m' R=$'\e[31m' G=$'\e[32m' X=$'\e[0m'; else B= D= Y= R= G= X=; fi
step() { printf '\n%s==> %s%s\n' "$B" "$1" "$X"; }
ok() { printf '  %s✓%s %s\n' "$G" "$X" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$X" "$1"; }
die() { printf '%serror:%s %s\n' "$R" "$X" "$1" >&2; exit 1; }
# ask <question> -> 0 for yes. No terminal to ask in: no.
ask() {
  [ -t 0 ] || return 1
  local answer
  printf '  %s [y/N] ' "$1"
  read -r answer || return 1
  case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

OS="$(uname -s)"
case "$OS" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=darwin ;;
  *) die "unsupported system: $OS (Linux and macOS only)" ;;
esac

# ---- requirements ---------------------------------------------------------------------------
step "Checking requirements ($OS)"

node_hint() {
  if [ "$PLATFORM" = darwin ]; then
    echo "install Node 24 or newer: brew install node   (or fnm / nvm / https://nodejs.org)"
  else
    echo "install Node 24 or newer with your package manager, fnm or nvm (https://nodejs.org)"
  fi
}
command -v node >/dev/null 2>&1 || die "node not found; $(node_hint)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || die "Node $(node -v) is too old (Axiom uses node:sqlite); $(node_hint)"
node -e 'require("node:sqlite")' 2>/dev/null || die "this Node build has no node:sqlite; $(node_hint)"
ok "node $(node -v) ($(command -v node))"
command -v npm >/dev/null 2>&1 || die "npm not found (it ships with Node)"
ok "npm $(npm -v)"

if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null | head -1) (Claude Code threads, Haiku summaries)"
else
  warn "claude not on PATH: Claude Code threads and Desk summaries won't work until it is"
fi
if [ -x "$HOME/.t3/bin/t3" ]; then
  ok "T3 Code CLI at ~/.t3/bin/t3"
else
  warn "no T3 Code CLI at ~/.t3/bin/t3: the T3 provider stays off (set the t3Cli setting if it lives elsewhere)"
fi

# ---- release copy ---------------------------------------------------------------------------
step "Preparing the release copy"
command -v git >/dev/null 2>&1 || die "git not found (the release copy is a git worktree of this checkout)"
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git checkout; clone Axiom with git to install it"
SHA="$(git -C "$REPO" rev-parse --verify --quiet "$REF^{commit}")" || die "no commit '$REF' in $REPO (try --ref <commit-ish>)"
case "$APP" in /*) ;; *) APP="$PWD/$APP" ;; esac
mkdir -p "$(dirname "$APP")"
APP="$(cd "$(dirname "$APP")" && pwd -P)/$(basename "$APP")"
[ "$APP" != "$REPO" ] || die "the release copy can't be the checkout itself ($APP); run this from your development checkout"
case "$APP" in "$REPO"/*) die "the release copy ($APP) is inside the checkout; pick another --app-dir" ;; esac

git -C "$REPO" worktree prune
is_worktree() { git -C "$REPO" worktree list --porcelain | grep -Fxq "worktree $1"; }
if is_worktree "$APP"; then
  if [ -n "$(git -C "$APP" status --porcelain)" ]; then
    git -C "$APP" status --short >&2
    die "the release copy $APP has local changes (above); commit or discard them there, or remove it with: git -C $REPO worktree remove --force $APP"
  fi
  if [ "$(git -C "$APP" rev-parse HEAD)" = "$SHA" ]; then
    ok "release copy at $APP is already at $(git -C "$REPO" rev-parse --short "$SHA")"
  else
    git -C "$APP" checkout --quiet --detach "$SHA"
    ok "release copy at $APP moved to $(git -C "$REPO" rev-parse --short "$SHA")"
  fi
elif [ -e "$APP" ] && [ -n "$(ls -A "$APP" 2>/dev/null)" ]; then
  die "$APP exists but is not a release copy of this checkout; move it away or pick another --app-dir"
else
  git -C "$REPO" worktree add --quiet --detach "$APP" "$SHA"
  ok "release copy created at $APP ($(git -C "$REPO" rev-parse --short "$SHA"))"
fi
warn "only commits are installed: uncommitted and untracked work in $REPO is not in the release copy"

# ---- build ----------------------------------------------------------------------------------
step "Installing dependencies and building"
cd "$APP"
npm ci --no-audit --no-fund --loglevel=error
LOG="$(mktemp)"
if ! npm run build >"$LOG" 2>&1; then
  tail -40 "$LOG" >&2
  die "build failed (full log: $LOG)"
fi
rm -f "$LOG"
CLI="$APP/packages/cli/dist/index.js"
SERVER="$APP/packages/server/dist/cli.js"
[ -f "$CLI" ] && [ -f "$SERVER" ] || die "build finished without $CLI or $SERVER"
ok "built $(git -C "$APP" rev-parse --short HEAD)"

# ---- commands on PATH -----------------------------------------------------------------------
step "Linking commands into $BIN_DIR"
mkdir -p "$BIN_DIR"
link() { # link <target> <name>
  local dest="$BIN_DIR/$2"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    warn "$dest exists and is not a link; left alone"
    return
  fi
  ln -sfn "$1" "$dest"
  ok "$2 -> $1"
}
link "$CLI" axiom
link "$SERVER" axiom-server

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "$BIN_DIR is not on your PATH. Add it, then open a new shell:"
    printf '      zsh:  echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc\n' "$BIN_DIR"
    printf '      bash: echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc\n' "$BIN_DIR"
    printf '      fish: fish_add_path %s\n' "$BIN_DIR"
    ;;
esac
AXIOM="$BIN_DIR/axiom"
"$AXIOM" --version >/dev/null || die "axiom doesn't run: $AXIOM --version failed"
"$AXIOM" topic list --all >/dev/null || die "axiom can't open its database (axiom topic list failed)"
ok "axiom $("$AXIOM" --version) runs; database ready"

# ---- agent skill ----------------------------------------------------------------------------
# The skill teaches agents to record their work with the `axiom` CLI. It goes where each agent tool
# looks for user skills: Claude Code always (T3 Code's Claude threads read it too), Codex and the
# shared ~/.agents folder when that tool's folder exists.
if [ "$SKILL" = 1 ]; then
  step "Installing the axiom skill for your agents"
  link_skill() { # link_skill <skills folder> <tool name>
    local dest="$1/axiom" shown="$1/axiom"
    case "$1" in "$HOME"/*) shown="~${1#"$HOME"}/axiom" ;; esac
    mkdir -p "$1"
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
      warn "$shown exists and is not a link; left alone ($2)"
    else
      ln -sfn "$APP/skills/axiom" "$dest"
      ok "$shown ($2)"
    fi
  }
  link_skill "$HOME/.claude/skills" "Claude Code"
  if [ -d "$HOME/.codex" ]; then link_skill "$HOME/.codex/skills" "Codex"; fi
  if [ -d "$HOME/.agents" ]; then link_skill "$HOME/.agents/skills" "agents sharing ~/.agents"; fi
  printf '  %sThe skill is opt-in: a project uses it when its AGENTS.md says "Track work in Axiom (see the `axiom` skill)."%s\n' "$D" "$X"
fi

# ---- Claude Code hooks ----------------------------------------------------------------------
step "Claude Code hooks"
echo "  Axiom's hooks (in ~/.claude/settings.json) record attached sessions, show their live step,"
echo "  and send their permission prompts to the Desk card."
if [ "$HOOKS" = ask ]; then
  if ask "Add them now? A backup of the settings file is made first."; then HOOKS=yes; else HOOKS=no; fi
fi
if [ "$HOOKS" = yes ]; then
  "$AXIOM" hooks install | sed 's/^/  /'
else
  warn "skipped; run 'axiom hooks install' later (undo with 'axiom hooks uninstall')"
fi

# ---- agent access ---------------------------------------------------------------------------
step "Agent access to the axiom CLI"
# What `axiom agents allow` would change; nothing to ask when it's all in place already.
PENDING="$("$AXIOM" --json agents allow --dry-run | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const d = JSON.parse(s);
    const out = [];
    if (d.claude.changed) out.push("Claude Code");
    if (d.codex && d.codex.changed) out.push("Codex");
    console.log(out.join(" and "));
  });')"
if [ -z "$PENDING" ]; then
  ok "agents can already run axiom without asking"
else
  echo "  Agents run axiom many times per task. Without this, $PENDING ask you each time"
  echo "  (Claude Code: an allow rule for 'Bash(axiom *)'; Codex: its sandbox may write Axiom's data folder)."
  if [ "$ACCESS" = ask ]; then
    if ask "Let agents run axiom without asking? Backups are made first."; then ACCESS=yes; else ACCESS=no; fi
  fi
  if [ "$ACCESS" = yes ]; then
    "$AXIOM" agents allow | sed 's/^/  /'
  else
    warn "skipped; run 'axiom agents allow' later (undo with 'axiom agents disallow')"
  fi
fi

# ---- server ---------------------------------------------------------------------------------
step "Server"
URL="http://127.0.0.1:$PORT"
UID_NUM="$(id -u)"
LABEL="local.axiom.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

healthy() {
  node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(1000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$URL/api/health"
}
wait_healthy() {
  local i=0
  while [ $i -lt 20 ]; do
    healthy && return 0
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}
service_loaded() {
  if [ "$PLATFORM" = darwin ]; then
    launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1
  else
    systemctl --user is-enabled --quiet axiom.service 2>/dev/null ||
      systemctl --user is-active --quiet axiom.service 2>/dev/null
  fi
}
service_logs() {
  if [ "$PLATFORM" = darwin ]; then echo "$HOME/Library/Logs/axiom/server.log"; else echo "journalctl --user -u axiom.service"; fi
}
# Writes the service file (with this PATH and build) and (re)starts it.
start_service() {
  # The service gets the database this install uses ($AXIOM_DB) and its port.
  if [ -n "${AXIOM_DB:-}" ]; then
    "$AXIOM" server install --platform "$PLATFORM" --port "$PORT" --db "$AXIOM_DB" >/dev/null
  else
    "$AXIOM" server install --platform "$PLATFORM" --port "$PORT" >/dev/null
  fi
  if [ "$PLATFORM" = darwin ]; then
    if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
      launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
      local i=0 # bootout returns before the job is gone; bootstrap fails until it is
      while [ $i -lt 25 ] && launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; do
        sleep 0.2
        i=$((i + 1))
      done
    fi
    launchctl bootstrap "gui/$UID_NUM" "$PLIST"
  else
    systemctl --user daemon-reload
    systemctl --user enable axiom.service >/dev/null 2>&1
    systemctl --user restart axiom.service
  fi
}

SERVICE_RUNNING=0
if [ "$PLATFORM" = linux ] && ! systemctl --user show-environment >/dev/null 2>&1; then
  [ "$SERVICE" = no ] || warn "no systemd user session here; start the server by hand: axiom server"
  SERVICE=no
elif service_loaded; then
  if [ "$SERVICE" = no ]; then
    warn "the Axiom service is set up but was left as it is (restart it to serve this build)"
  else
    SERVICE=yes # chosen on an earlier run: keep it, restarted on the new build
  fi
elif [ "$SERVICE" = ask ]; then
  [ -t 0 ] && echo "  The server can run as a user service: started now, and again at every login."
  if ask "Start the Axiom server now and at every login?"; then SERVICE=yes; else SERVICE=no; fi
fi

if [ "$SERVICE" = yes ]; then
  if ! service_loaded && healthy; then
    warn "something already answers on $URL (a server started by hand?)."
    warn "stop it, then run: scripts/install.sh --service"
  elif start_service && wait_healthy; then
    SERVICE_RUNNING=1
    ok "the Axiom service is running at $URL and starts at every login"
    ok "logs: $(service_logs)"
  else
    warn "the service didn't come up at $URL; logs: $(service_logs)"
  fi
fi

step "Done"
if [ "$SERVICE_RUNNING" = 1 ]; then
  echo "  Open $URL"
  if [ "$PLATFORM" = darwin ]; then
    echo "  Stop the service:  launchctl bootout gui/\$(id -u)/$LABEL"
  else
    echo "  Stop the service:  systemctl --user disable --now axiom.service"
  fi
  echo "  Update later:  axiom update   (pulls main into this checkout, reinstalls, restarts the service)"
else
  echo "  Start the server:  axiom server        (then open $URL)"
  echo "  Or as a service:   scripts/install.sh --service"
  echo "  Update later:  axiom update   (pulls main into this checkout and reinstalls; then restart the server)"
fi
