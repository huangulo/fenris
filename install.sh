#!/bin/sh
# Fenris Installer
# https://github.com/openclaw/fenris
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/openclaw/fenris/main/install.sh | sh
#
# Usage (downloaded):
#   sh install.sh
#
# Environment overrides:
#   FENRIS_DIR        — server install directory (default: ~/.fenris)
#   FENRIS_AGENT_DIR  — agent install directory  (default: ~/.fenris-agent)

set -e

FENRIS_REPO="openclaw/fenris"
FENRIS_BRANCH="main"
FENRIS_SERVER_DIR="${FENRIS_DIR:-$HOME/.fenris}"
FENRIS_AGENT_DIR="${FENRIS_AGENT_DIR:-$HOME/.fenris-agent}"

# ── Colour support ─────────────────────────────────────────────────────────────
# Colours are written to stdout; preserve them if stdout is a TTY.
if [ -t 1 ]; then
  CLR_RED='\033[0;31m'
  CLR_GRN='\033[0;32m'
  CLR_YLW='\033[1;33m'
  CLR_CYN='\033[0;36m'
  CLR_BLD='\033[1m'
  CLR_RST='\033[0m'
else
  CLR_RED=''; CLR_GRN=''; CLR_YLW=''; CLR_CYN=''; CLR_BLD=''; CLR_RST=''
fi

ok()     { printf "${CLR_GRN}✓${CLR_RST} %s\n"     "$*"; }
warn()   { printf "${CLR_YLW}⚠${CLR_RST} %s\n"     "$*"; }
info()   { printf "  %s\n"                           "$*"; }
err()    { printf "${CLR_RED}✗${CLR_RST} %s\n"     "$*" >&2; }
die()    { err "$*"; exit 1; }
step()   { printf "\n${CLR_BLD}${CLR_CYN}── %s${CLR_RST}\n" "$*"; }
banner() { printf "\n${CLR_BLD}${CLR_GRN}%s${CLR_RST}\n" "$*"; }
br()     { printf "\n"; }

# ── Interactive prompt helpers ─────────────────────────────────────────────────
# /dev/tty is used so prompts work even when stdin is the curl pipe.

ask() {
  # $1 = label, $2 = default value
  # Result in $REPLY
  if [ -n "$2" ]; then
    printf "${CLR_CYN}?${CLR_RST} %s ${CLR_BLD}[%s]${CLR_RST}: " "$1" "$2"
  else
    printf "${CLR_CYN}?${CLR_RST} %s: " "$1"
  fi
  if [ -r /dev/tty ]; then
    read -r REPLY </dev/tty || REPLY=""
  else
    REPLY=""
  fi
  [ -z "$REPLY" ] && REPLY="$2"
}

ask_secret() {
  # $1 = label. Hides input. Result in REPLY (empty = should generate).
  printf "${CLR_CYN}?${CLR_RST} %s ${CLR_BLD}(blank to auto-generate)${CLR_RST}: " "$1"
  if [ -r /dev/tty ]; then
    stty -echo </dev/tty 2>/dev/null && _STTY_WAS_SET=1 || _STTY_WAS_SET=0
    read -r REPLY </dev/tty || REPLY=""
    [ "$_STTY_WAS_SET" = "1" ] && stty echo </dev/tty 2>/dev/null
  else
    REPLY=""
  fi
  printf "\n"
}

# ── Random secret generator ────────────────────────────────────────────────────

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    tr -dc 'a-f0-9' </dev/urandom 2>/dev/null | head -c 32
  fi
}

# ── Prerequisite checks ────────────────────────────────────────────────────────

check_os() {
  _OS="$(uname -s 2>/dev/null)"
  case "$_OS" in
    Linux) ok "Linux detected" ;;
    Darwin)
      die "macOS is not supported. Run Fenris in a Linux VM or use Docker Desktop with a Linux container."
      ;;
    CYGWIN*|MINGW*|MSYS*|Windows*)
      die "Windows is not supported. Use WSL2 (Ubuntu) to run Fenris."
      ;;
    *)
      die "Unsupported OS: $_OS. Fenris requires Linux."
      ;;
  esac
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    err "Docker is not installed."
    info "Install it: https://docs.docker.com/engine/install/"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    err "Docker is installed but the daemon is not running (or you lack permission)."
    info "Start Docker:      sudo systemctl start docker"
    info "Add your user:     sudo usermod -aG docker \$USER  (then log out and back in)"
    exit 1
  fi
  _DOCKER_VER="$(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  ok "Docker ${_DOCKER_VER}"
}

check_compose() {
  if ! docker compose version >/dev/null 2>&1; then
    err "Docker Compose v2 (plugin) is required but not found."
    info "Install it: https://docs.docker.com/compose/install/"
    info "Note: 'docker compose' (space, not hyphen) is required."
    exit 1
  fi
  _COMPOSE_VER="$(docker compose version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  ok "Docker Compose ${_COMPOSE_VER}"
}

check_git() {
  if ! command -v git >/dev/null 2>&1; then
    err "git is required to clone the Fenris repository."
    info "Install it:  sudo apt install git  /  sudo dnf install git"
    exit 1
  fi
  ok "git $(git --version | grep -oE '[0-9]+\.[0-9]+' | head -1)"
}

# ── Repository helpers ─────────────────────────────────────────────────────────

clone_or_update() {
  # $1 = destination directory
  _DEST="$1"
  _URL="https://github.com/${FENRIS_REPO}.git"

  if [ -d "$_DEST/.git" ]; then
    info "Updating existing checkout at $_DEST …"
    git -C "$_DEST" fetch --quiet origin
    git -C "$_DEST" reset --quiet --hard "origin/${FENRIS_BRANCH}"
    ok "Repository updated"
  else
    info "Cloning ${_URL} …"
    git clone --quiet --branch "${FENRIS_BRANCH}" --depth 1 "$_URL" "$_DEST"
    ok "Repository cloned"
  fi
}

# ── Docker socket GID ──────────────────────────────────────────────────────────

docker_gid() {
  stat -c '%g' /var/run/docker.sock 2>/dev/null || echo "988"
}

# ── SERVER INSTALL ─────────────────────────────────────────────────────────────

install_server() {
  step "Server Installation"

  _DIR="$FENRIS_SERVER_DIR"

  # Load any existing values so re-runs are non-destructive
  _EXISTING_PORT=""
  _EXISTING_PG_PASS=""
  _EXISTING_API_KEY=""
  if [ -f "$_DIR/.env" ]; then
    _EXISTING_PORT="$(    grep '^FENRIS_PORT='       "$_DIR/.env" 2>/dev/null | cut -d= -f2-)"
    _EXISTING_PG_PASS="$( grep '^POSTGRES_PASSWORD=' "$_DIR/.env" 2>/dev/null | cut -d= -f2-)"
    _EXISTING_API_KEY="$( grep '^API_KEY='           "$_DIR/.env" 2>/dev/null | cut -d= -f2-)"
    warn "Existing installation found — current values shown as defaults."
  fi

  br
  ask "Dashboard port" "${_EXISTING_PORT:-8081}"
  _PORT="$REPLY"

  ask_secret "PostgreSQL password"
  _PG_PASS="$REPLY"
  if [ -z "$_PG_PASS" ]; then
    _PG_PASS="${_EXISTING_PG_PASS:-$(gen_secret)}"
    [ -z "$_EXISTING_PG_PASS" ] && ok "Generated PostgreSQL password"
  fi

  ask_secret "API key (used by dashboard and local agent)"
  _API_KEY="$REPLY"
  if [ -z "$_API_KEY" ]; then
    _API_KEY="${_EXISTING_API_KEY:-$(gen_secret)}"
    [ -z "$_EXISTING_API_KEY" ] && ok "Generated API key"
  fi

  ask "Discord webhook URL (blank to skip)" ""
  _DISCORD="$REPLY"

  ask "Slack webhook URL (blank to skip)" ""
  _SLACK="$REPLY"

  # ── Scaffold directory ───────────────────────────────────────────────────────
  step "Creating files"
  mkdir -p "$_DIR"
  ok "Install directory: $_DIR"

  # Clone / update source
  clone_or_update "$_DIR"

  _DOCKER_GID="$(docker_gid)"

  # Write .env (overwrites on re-run, but values preserved via prompts above)
  cat > "$_DIR/.env" << ENVEOF
# Fenris environment configuration
# Generated by install.sh — keep this file private.

FENRIS_PORT=${_PORT}
POSTGRES_PASSWORD=${_PG_PASS}
API_KEY=${_API_KEY}
VITE_API_KEY=${_API_KEY}
DOCKER_GID=${_DOCKER_GID}
DISCORD_WEBHOOK_URL=${_DISCORD}
SLACK_WEBHOOK_URL=${_SLACK}
ENVEOF
  ok "Wrote .env"

  # Write fenris.yaml (only if it doesn't exist — preserve user edits on re-run)
  if [ ! -f "$_DIR/fenris.yaml" ]; then
    cat > "$_DIR/fenris.yaml" << YAMLEOF
server:
  port: 3200
  database_url: postgresql://fenris:\${POSTGRES_PASSWORD}@postgres:5432/fenris

monitors:
  system:
    enabled: true
    scrape_interval: 30s
    metrics: [cpu, memory, disk, network]

alerts:
  discord:
    enabled: $([ -n "$_DISCORD" ] && echo true || echo false)
    webhook_url: \${DISCORD_WEBHOOK_URL}
    severity_levels: [warning, critical]
  slack:
    enabled: $([ -n "$_SLACK" ] && echo true || echo false)
    webhook_url: \${SLACK_WEBHOOK_URL}
    severity_levels: [warning, critical]
  thresholds:
    cpu:    { warning: 75, critical: 95 }
    memory: { warning: 80, critical: 90 }
    disk:   { warning: 85, critical: 95 }

anomaly_detection:
  enabled: true
  algorithm: zscore
  zscore_threshold: 3.0
  window_size: 100
  min_samples: 60

retention:
  metrics_days: 30
  alerts_days:  90
YAMLEOF
    ok "Wrote fenris.yaml"
  else
    ok "Kept existing fenris.yaml"
  fi

  # Write local agent config
  mkdir -p "$_DIR/agent-local"
  if [ ! -f "$_DIR/agent-local/fenris-agent.yaml" ]; then
    cat > "$_DIR/agent-local/fenris-agent.yaml" << AGENTEOF
server_url: http://server:3200
api_key: ${_API_KEY}
server_name: local
collect_interval: 30s
docker_enabled: true
disk_paths:
  - /
  - /var/lib/docker
  - /var/log
AGENTEOF
    ok "Wrote agent-local/fenris-agent.yaml"
  else
    # Update the api_key in case it changed
    sed -i "s|^api_key:.*|api_key: ${_API_KEY}|" "$_DIR/agent-local/fenris-agent.yaml"
    ok "Updated agent-local/fenris-agent.yaml"
  fi

  # ── Build and start ──────────────────────────────────────────────────────────
  step "Building and starting services"
  cd "$_DIR"

  docker compose pull postgres 2>/dev/null && ok "Pulled postgres image"

  docker compose build --quiet 2>&1 | grep -v '^#' || true
  ok "Built Fenris images"

  docker compose up -d
  ok "Services started"

  # Seed the generated API key into the DB so the dashboard works immediately
  # (before the agent posts its first metrics)
  step "Seeding API key"
  _RETRIES=0
  while [ "$_RETRIES" -lt 15 ]; do
    if docker compose exec -T postgres pg_isready -U fenris -q 2>/dev/null; then
      docker compose exec -T postgres psql -U fenris -d fenris -q \
        -c "INSERT INTO servers (name, ip_address, api_key)
            VALUES ('local', '127.0.0.1', '${_API_KEY}')
            ON CONFLICT (api_key, name) DO NOTHING;" 2>/dev/null && break
    fi
    _RETRIES=$((_RETRIES + 1))
    sleep 2
  done
  ok "API key registered"

  # ── Summary ──────────────────────────────────────────────────────────────────
  br
  printf "${CLR_GRN}${CLR_BLD}┌─────────────────────────────────────────┐${CLR_RST}\n"
  printf "${CLR_GRN}${CLR_BLD}│  Fenris is running!                     │${CLR_RST}\n"
  printf "${CLR_GRN}${CLR_BLD}└─────────────────────────────────────────┘${CLR_RST}\n"
  br
  printf "  ${CLR_BLD}Dashboard:${CLR_RST}  ${CLR_CYN}http://localhost:${_PORT}${CLR_RST}\n"
  printf "  ${CLR_BLD}API:${CLR_RST}        ${CLR_CYN}http://localhost:3200${CLR_RST}\n"
  printf "  ${CLR_BLD}API key:${CLR_RST}    ${CLR_CYN}${_API_KEY}${CLR_RST}\n"
  printf "  ${CLR_BLD}Config dir:${CLR_RST} ${CLR_CYN}${_DIR}${CLR_RST}\n"
  br
  printf "  To add more hosts, run this script on each one and choose ${CLR_BLD}agent${CLR_RST} mode.\n"
  printf "  Logs: ${CLR_CYN}docker compose -f ${_DIR}/docker-compose.yml logs -f${CLR_RST}\n"
  br
}

# ── AGENT INSTALL ──────────────────────────────────────────────────────────────

install_agent() {
  step "Agent Installation"

  _DIR="$FENRIS_AGENT_DIR"

  # Load existing config for idempotent re-runs
  _EXISTING_URL=""
  _EXISTING_KEY=""
  _EXISTING_NAME=""
  if [ -f "$_DIR/fenris-agent.yaml" ]; then
    _EXISTING_URL="$(  grep '^server_url:'   "$_DIR/fenris-agent.yaml" 2>/dev/null | awk '{print $2}')"
    _EXISTING_KEY="$(  grep '^api_key:'      "$_DIR/fenris-agent.yaml" 2>/dev/null | awk '{print $2}')"
    _EXISTING_NAME="$( grep '^server_name:'  "$_DIR/fenris-agent.yaml" 2>/dev/null | awk '{print $2}')"
    warn "Existing agent config found — current values shown as defaults."
  fi

  br
  ask "Fenris server URL" "${_EXISTING_URL:-http://YOUR_SERVER_IP:3200}"
  _SERVER_URL="$REPLY"

  ask_secret "API key (copy from server's API key)"
  _API_KEY="$REPLY"
  if [ -z "$_API_KEY" ]; then
    [ -n "$_EXISTING_KEY" ] && _API_KEY="$_EXISTING_KEY" || die "API key is required."
  fi

  ask "Name for this host" "${_EXISTING_NAME:-$(hostname 2>/dev/null || echo my-host)}"
  _HOST_NAME="$REPLY"

  # ── Scaffold ──────────────────────────────────────────────────────────────────
  step "Creating files"
  mkdir -p "$_DIR"
  ok "Install directory: $_DIR"

  clone_or_update "$_DIR"

  _DOCKER_GID="$(docker_gid)"

  # Write agent config
  cat > "$_DIR/agent-local/fenris-agent.yaml" << AGENTEOF
server_url: ${_SERVER_URL}
api_key: ${_API_KEY}
server_name: ${_HOST_NAME}
collect_interval: 30s
docker_enabled: true
disk_paths:
  - /
  - /var/lib/docker
  - /var/log
AGENTEOF
  ok "Wrote fenris-agent.yaml"

  # Write a .env for the agent compose (docker socket GID)
  cat > "$_DIR/.env" << AGENTENVEOF
DOCKER_GID=${_DOCKER_GID}
AGENTENVEOF
  ok "Wrote .env"

  # ── Build and start ────────────────────────────────────────────────────────
  step "Building and starting agent"
  cd "$_DIR"

  docker compose build --quiet agent 2>&1 | grep -v '^#' || true
  ok "Built agent image"

  docker compose up -d agent
  ok "Agent started"

  # ── Summary ──────────────────────────────────────────────────────────────────
  br
  printf "${CLR_GRN}${CLR_BLD}┌─────────────────────────────────────────┐${CLR_RST}\n"
  printf "${CLR_GRN}${CLR_BLD}│  Fenris Agent is running!               │${CLR_RST}\n"
  printf "${CLR_GRN}${CLR_BLD}└─────────────────────────────────────────┘${CLR_RST}\n"
  br
  printf "  ${CLR_BLD}Host name:${CLR_RST}  ${CLR_CYN}${_HOST_NAME}${CLR_RST}\n"
  printf "  ${CLR_BLD}Reporting to:${CLR_RST} ${CLR_CYN}${_SERVER_URL}${CLR_RST}\n"
  printf "  ${CLR_BLD}Config dir:${CLR_RST} ${CLR_CYN}${_DIR}${CLR_RST}\n"
  br
  printf "  Metrics will appear in the dashboard within 30 seconds.\n"
  printf "  Logs: ${CLR_CYN}docker compose -f ${_DIR}/docker-compose.yml logs -f agent${CLR_RST}\n"
  br
}

# ── MAIN ───────────────────────────────────────────────────────────────────────

main() {
  printf "\n"
  printf "${CLR_BLD}${CLR_CYN}Fenris Installer${CLR_RST}\n"
  printf "${CLR_CYN}Predictive infrastructure monitoring for homelabs${CLR_RST}\n"
  printf "${CLR_CYN}https://github.com/${FENRIS_REPO}${CLR_RST}\n"
  printf "\n"

  step "Checking prerequisites"
  check_os
  check_docker
  check_compose
  check_git

  br
  printf "${CLR_BLD}Install mode:${CLR_RST}\n"
  printf "  ${CLR_BLD}server${CLR_RST} — central server + dashboard + local agent (run once)\n"
  printf "  ${CLR_BLD}agent${CLR_RST}  — metrics collector only (run on each additional host)\n"
  br
  ask "Install mode" "server"
  _MODE="$REPLY"

  case "$_MODE" in
    server) install_server ;;
    agent)  install_agent  ;;
    *)      die "Unknown mode '$_MODE'. Choose 'server' or 'agent'." ;;
  esac
}

main "$@"
