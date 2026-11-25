#!/usr/bin/env bash
# Installs Axiom from this checkout, on Linux or macOS. Safe to re-run: it is also the update step
# (after `git pull`). Written for bash 3.2, the version macOS ships.
#
#   scripts/install.sh [--yes] [--no-hooks] [--no-service] [--no-skill] [--bin-dir DIR]
#
#   --yes         answer yes to both questions: add the hooks, run the server as a service
#   --hooks       add Axiom's hooks to ~/.claude/settings.json without asking (a backup is made)
#   --no-hooks    leave ~/.claude/settings.json alone
#   --service     run the server now and at every login (systemd / launchd) without asking
#   --no-service  don't set up the service (start it by hand: axiom server)
#   --no-skill    don't link the axiom skill into ~/.claude/skills
#   --bin-dir     where the `axiom` and `axiom-server` links go (default: ~/.local/bin)
#
# Without a terminal to ask in, the questions default to no. A service set up before is restarted
# on every run, so it serves the new build. Never touches ~/.t3.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
HOOKS="ask"
SKILL=1
SERVICE="ask"
PORT="${AXIOM_PORT:-4477}"

while [ $# -gt 0 ]; do
  case "$1" in
    --yes | -y) HOOKS="yes" SERVICE="yes" ;;
    --hooks) HOOKS="yes" ;;
    --no-hooks) HOOKS="no" ;;
    --service) SERVICE="yes" ;;
    --no-service) SERVICE="no" ;;
    --no-skill) SKILL=0 ;;
    --bin-dir)
      [ $# -ge 2 ] || { echo "--bin-dir needs a folder" >&2; exit 2; }
      BIN_DIR="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
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

# ---- build ----------------------------------------------------------------------------------
step "Installing dependencies and building"
cd "$REPO"
npm ci --no-audit --no-fund --loglevel=error
LOG="$(mktemp)"
if ! npm run build >"$LOG" 2>&1; then
  tail -40 "$LOG" >&2
  die "build failed (full log: $LOG)"
fi
rm -f "$LOG"
CLI="$REPO/packages/cli/dist/index.js"
SERVER="$REPO/packages/server/dist/cli.js"
[ -f "$CLI" ] && [ -f "$SERVER" ] || die "build finished without $CLI or $SERVER"
ok "built $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo "(not a git checkout)")"

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
if [ "$SKILL" = 1 ]; then
  step "Linking the axiom skill for Claude Code"
  SKILLS="$HOME/.claude/skills"
  dest="$SKILLS/axiom"
  mkdir -p "$SKILLS"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    warn "$dest exists and is not a link; left alone"
  else
    ln -sfn "$REPO/skills/axiom" "$dest"
    ok "~/.claude/skills/axiom -> $REPO/skills/axiom"
  fi
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
  echo "  Update later:  git pull && scripts/install.sh   (restarts the service)"
else
  echo "  Start the server:  axiom server        (then open $URL)"
  echo "  Or as a service:   scripts/install.sh --service"
  echo "  Update later:  git pull && scripts/install.sh   (then restart the server)"
fi
