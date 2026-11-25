#!/usr/bin/env bash
# Installs Axiom from this checkout, on Linux or macOS. Safe to re-run: it is also the update step
# (after `git pull`). Written for bash 3.2, the version macOS ships.
#
#   scripts/install.sh [--yes] [--no-hooks] [--no-skill] [--service] [--bin-dir DIR]
#
#   --yes        don't ask before adding Axiom's hooks to ~/.claude/settings.json (a backup is made)
#   --no-hooks   leave ~/.claude/settings.json alone
#   --no-skill   don't link the axiom skill into ~/.claude/skills
#   --service    also write the server's user service (systemd / launchd); it is never enabled
#   --bin-dir    where the `axiom` and `axiom-server` links go (default: ~/.local/bin)
#
# Never starts the server, enables a service or touches ~/.t3.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
HOOKS="ask"
SKILL=1
SERVICE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes | -y) HOOKS="yes" ;;
    --no-hooks) HOOKS="no" ;;
    --no-skill) SKILL=0 ;;
    --service) SERVICE=1 ;;
    --bin-dir)
      [ $# -ge 2 ] || { echo "--bin-dir needs a folder" >&2; exit 2; }
      BIN_DIR="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
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
  if [ -t 0 ]; then
    printf '  Add them now? A backup of the settings file is made first. [y/N] '
    read -r answer
    case "$answer" in [yY]*) HOOKS=yes ;; *) HOOKS=no ;; esac
  else
    HOOKS=no
  fi
fi
if [ "$HOOKS" = yes ]; then
  "$AXIOM" hooks install | sed 's/^/  /'
else
  warn "skipped; run 'axiom hooks install' later (undo with 'axiom hooks uninstall')"
fi

# ---- server ---------------------------------------------------------------------------------
if [ "$SERVICE" = 1 ]; then
  step "Server service"
  "$AXIOM" server install | sed 's/^/  /'
fi

step "Done"
echo "  Start the server:  axiom server        (then open http://127.0.0.1:4477)"
if [ "$SERVICE" = 0 ]; then
  echo "  Run it as a service instead:  axiom server install   (writes the file; you enable it)"
fi
echo "  Update later:  git pull && scripts/install.sh   (then restart the server)"
