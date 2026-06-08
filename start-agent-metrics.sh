#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA_ROOT="${AGENT_METRICS_DATA_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/Agent Metrics/agent-metrics-data}"
CORE_PORT="${AGENT_METRICS_CORE_PORT:-45183}"
DASHBOARD_PORT="${AGENT_METRICS_DASHBOARD_PORT:-4173}"
CORE_URL="http://127.0.0.1:$CORE_PORT/api/overview"
DASHBOARD_URL="http://127.0.0.1:$DASHBOARD_PORT"
DASHBOARD_API_URL="$DASHBOARD_URL/api/overview"
RUNTIME_DIR="$REPO_ROOT/.runtime"
CLI_WORKING_DIR="$REPO_ROOT/apps/cli"
CORE_WORKING_DIR="$REPO_ROOT/apps/core"
DASHBOARD_WORKING_DIR="$REPO_ROOT/apps/dashboard"
CLI_ENTRY="$CLI_WORKING_DIR/dist/index.js"
CORE_ENTRY="$CORE_WORKING_DIR/dist/server.js"
VITE_ENTRY="$REPO_ROOT/node_modules/vite/bin/vite.js"

HOOK_WATCHER_PID_PATH="$RUNTIME_DIR/hook-watcher.pid"
PARSER_PID_PATH="$RUNTIME_DIR/parser.pid"
CORE_PID_PATH="$RUNTIME_DIR/core.pid"
DASHBOARD_PID_PATH="$RUNTIME_DIR/dashboard.pid"

REBUILD=false
NO_BROWSER=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rebuild) REBUILD=true; shift ;;
    --no-browser) NO_BROWSER=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

log()  { echo "==> $*"; }
info() { echo "    $*"; }
warn() { echo "    [!] $*"; }

ensure_command() {
  if ! command -v "$1" &>/dev/null; then
    echo "Missing required command: $1"
    exit 1
  fi
}

is_healthy() {
  local url="$1"
  local out
  out="$(curl -sf --max-time 3 "$url" 2>/dev/null)" || return 1
  echo "$out" | node -e "
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof d.sessionCount !== 'number' ||
        typeof d.turnCount !== 'number' ||
        typeof d.totalTokens !== 'number' ||
        !Array.isArray(d.tokensByModel)) process.exit(1);
    process.exit(0);
  } catch { process.exit(1); }
});
" 2>/dev/null
}

is_dashboard_healthy() {
  local html
  html="$(curl -sf --max-time 3 "$DASHBOARD_URL" 2>/dev/null)" || return 1
  echo "$html" | grep -q '<title>Agent Metrics</title>' || return 1
  is_healthy "$DASHBOARD_API_URL"
}

wait_until_healthy() {
  local name="$1" url="$2" log_path="$3" validator="$4"
  local deadline=60 i=0
  while (( i < deadline )); do
    if $validator "$url"; then
      return 0
    fi
    sleep 0.5
    (( i += 1 )) || true
  done
  if [[ -f "$log_path" ]]; then
    echo ""
    warn "$name log tail:"
    tail -40 "$log_path"
  fi
  echo "ERROR: $name did not become healthy in time."
  return 1
}

port_is_listening() {
  local port="$1"
  lsof -i ":$port" -sTCP:LISTEN -P 2>/dev/null | grep -q LISTEN
}

read_pid() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    echo ""
    return
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
    rm -f "$pid_file"
    echo ""
    return
  fi
  echo "$pid"
}

is_process_running() {
  local pid="$1" match="$2"
  if [[ -z "$pid" ]]; then
    return 1
  fi
  if ! ps -p "$pid" -o pid= &>/dev/null; then
    return 1
  fi
  if [[ -n "$match" ]]; then
    local cmdline
    cmdline="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if echo "$cmdline" | grep -q "$match"; then
      return 0
    fi
    return 1
  fi
  return 0
}

stop_process() {
  local pid_file="$1" match="$2"
  local pid
  pid="$(read_pid "$pid_file")"
  if [[ -n "$pid" ]] && is_process_running "$pid" "$match"; then
    log "Stopping $match (PID $pid)"
    kill "$pid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$pid_file"
}

start_background() {
  local pid_file="$1" label="$2" working_dir="$3"
  local out_log="$4" err_log="$5"
  shift 5
  if [[ -f "$pid_file" ]]; then
    local existing_pid
    existing_pid="$(read_pid "$pid_file")"
    if [[ -n "$existing_pid" ]] && is_process_running "$existing_pid" ""; then
      log "$label already running with PID $existing_pid"
      return 0
    fi
    rm -f "$pid_file"
  fi
  log "Starting $label"
  nohup bash -lc '
    cd "$1"
    shift
    exec "$@"
  ' bash "$working_dir" "$@" >"$out_log" 2>"$err_log" &
  local pid=$!
  echo "$pid" > "$pid_file"
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo ""
    warn "$label log tail (stderr):"
    tail -40 "$err_log" 2>/dev/null || true
    echo "ERROR: $label did not stay running."
    return 1
  fi
  info "$label started with PID $pid"
}

# ----------------------------------------------------------------
# Bootstrap
# ----------------------------------------------------------------
ensure_command node
ensure_command corepack
ensure_command curl

mkdir -p "$RUNTIME_DIR"
mkdir -p "$DATA_ROOT/data/hooks/raw"
mkdir -p "$DATA_ROOT/data/events"
mkdir -p "$DATA_ROOT/data/hooks/state"
mkdir -p "$DATA_ROOT/data/sqlite"

if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  log "Installing workspace dependencies"
  (cd "$REPO_ROOT" && corepack pnpm install)
fi

if [[ "$REBUILD" == true || ! -f "$CLI_ENTRY" || ! -f "$CORE_ENTRY" || ! -f "$VITE_ENTRY" ]]; then
  log "Building workspace packages"
  (cd "$REPO_ROOT" && corepack pnpm build)
fi

# ----------------------------------------------------------------
# Claude hooks
# ----------------------------------------------------------------
log "Ensuring Claude hooks"
(cd "$CLI_WORKING_DIR" && node "$CLI_ENTRY" hooks ensure --scope global --repo-root "$DATA_ROOT" --cli-path "$CLI_ENTRY")

# ----------------------------------------------------------------
# Hook watcher
# ----------------------------------------------------------------
start_background \
  "$HOOK_WATCHER_PID_PATH" "Hook watcher" "$CLI_WORKING_DIR" \
  "$RUNTIME_DIR/hook-watcher.out.log" "$RUNTIME_DIR/hook-watcher.err.log" \
  node "$CLI_ENTRY" hooks watch --scope global --repo-root "$DATA_ROOT" --cli-path "$CLI_ENTRY"

# ----------------------------------------------------------------
# Parser
# ----------------------------------------------------------------
start_background \
  "$PARSER_PID_PATH" "Parser" "$CLI_WORKING_DIR" \
  "$RUNTIME_DIR/parser.out.log" "$RUNTIME_DIR/parser.err.log" \
  node "$CLI_ENTRY" hooks parse --follow --repo-root "$DATA_ROOT"

# ----------------------------------------------------------------
# Core API
# ----------------------------------------------------------------
if is_healthy "$CORE_URL"; then
  log "Core API already running at $CORE_URL"
else
  if port_is_listening "$CORE_PORT"; then
    stop_process "$CORE_PID_PATH" "dist/server.js"
  fi
  start_background \
    "$CORE_PID_PATH" "Core API" "$CORE_WORKING_DIR" \
    "$RUNTIME_DIR/core.out.log" "$RUNTIME_DIR/core.err.log" \
    env \
      "AGENT_METRICS_DB_PATH=$DATA_ROOT/data/sqlite/metrics.sqlite" \
      "AGENT_METRICS_EVENT_LOG_PATH=$DATA_ROOT/data/events/events.jsonl" \
      "AGENT_METRICS_REPO_ROOT=$DATA_ROOT" \
      node "$CORE_ENTRY"
  wait_until_healthy "Core API" "$CORE_URL" "$RUNTIME_DIR/core.err.log" is_healthy
fi

# ----------------------------------------------------------------
# Dashboard
# ----------------------------------------------------------------
if is_dashboard_healthy; then
  log "Dashboard already running at $DASHBOARD_URL"
else
  if port_is_listening "$DASHBOARD_PORT"; then
    stop_process "$DASHBOARD_PID_PATH" "vite"
  fi
  start_background \
    "$DASHBOARD_PID_PATH" "Dashboard" "$DASHBOARD_WORKING_DIR" \
    "$RUNTIME_DIR/dashboard.out.log" "$RUNTIME_DIR/dashboard.err.log" \
    node "$VITE_ENTRY" --host 127.0.0.1 --port "$DASHBOARD_PORT"
  wait_until_healthy "Dashboard" "$DASHBOARD_API_URL" "$RUNTIME_DIR/dashboard.err.log" is_dashboard_healthy
fi

# ----------------------------------------------------------------
# Summary
# ----------------------------------------------------------------
echo ""
info "Hooks:     ensured + watcher active"
info "Parser:    raw hook bus -> normalized events"
info "Dashboard: $DASHBOARD_URL"
info "API:       $CORE_URL"
info "Data:      $DATA_ROOT"
info "Logs:      $RUNTIME_DIR"
echo ""
info "Next step: open Claude Code in a test workspace and trigger Read, Search/Grep, Edit, and Bash."
info "Expected logs:"
info "  $DATA_ROOT/data/hooks/raw/claude-code.jsonl"
info "  $DATA_ROOT/data/events/events.jsonl"
info "  $DATA_ROOT/data/hooks/state/parser-state.json"

if [[ "$NO_BROWSER" != true ]] && command -v open &>/dev/null; then
  open "$DASHBOARD_URL"
fi
