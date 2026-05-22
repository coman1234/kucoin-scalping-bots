#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
#  bot.sh — bot7 ecosystem management script
#  Services: data-producer  kucoin-datalake  scalping-bot7
#            scalping-monitor7  scalping-day7
#
#  Usage: ./bot.sh <command> [args]
#         ./bot.sh            → interactive menu
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
DEPLOY_ROOT=/usr/local/bin

SERVICES=(
  data-producer
  kucoin-datalake
  scalping-bot7
  scalping-monitor7
  scalping-day7
)

PORT_DATALAKE=3010
PORT_BOT7=3001
PORT_MON7=3100
PORT_DAY7=3002

DATALAKE_URL="http://localhost:${PORT_DATALAKE}"

# ── NVM helper ────────────────────────────────────────────────────────────────
nvm_use24() {
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm use 24
}

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m';  GRN='\033[0;32m'; YLW='\033[0;33m'
BLU='\033[0;34m';  CYN='\033[0;36m'; WHT='\033[1;37m'
MAG='\033[0;35m';  DIM='\033[2m';    RST='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────
header()  { echo -e "\n${BLU}══════════════════════════════════════════${RST}"; \
            echo -e "${WHT}  $1${RST}"; \
            echo -e "${BLU}══════════════════════════════════════════${RST}"; }
section() { echo -e "\n${DIM}── $1 ────────────────────────────────${RST}"; }
ok()      { echo -e "${GRN}✓ $*${RST}"; }
warn()    { echo -e "${YLW}⚠ $*${RST}"; }
err()     { echo -e "${RED}✗ $*${RST}"; }
info()    { echo -e "${CYN}  $*${RST}"; }

is_running() { pm2 list 2>/dev/null | grep -q "$1.*online"; }

http_check() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$1" 2>/dev/null || echo "000"
}

# Resolve service name: accepts partial/full name or index (0-4)
resolve_service() {
  local input=$1
  case "$input" in
    0|data-producer)      echo "data-producer" ;;
    1|kucoin-datalake)    echo "kucoin-datalake" ;;
    2|scalping-bot7)      echo "scalping-bot7" ;;
    3|scalping-monitor7)  echo "scalping-monitor7" ;;
    4|scalping-day7)      echo "scalping-day7" ;;
    *)
      err "Unknown service: $input"
      echo "  Known services: ${SERVICES[*]}" >&2
      exit 1 ;;
  esac
}

# ══════════════════════════════════════════════════════════════════════════════
#  START / STOP / RESTART
# ══════════════════════════════════════════════════════════════════════════════

cmd_start() {
  local svc="${1:-}"
  if [ -n "$svc" ]; then
    svc=$(resolve_service "$svc")
    header "Starting $svc"
    pm2 start ecosystem.config.js --only "$svc"
    pm2 save
    ok "$svc started"
  else
    header "Starting all services"
    pm2 start "${DEPLOY_ROOT}/ecosystem.config.js"
    pm2 save
    ok "All services started"
  fi
}

cmd_stop() {
  local svc="${1:-}"
  if [ -n "$svc" ]; then
    svc=$(resolve_service "$svc")
    header "Stopping $svc"
    pm2 stop "$svc" && ok "Stopped $svc" || warn "$svc not running"
  else
    header "Stopping all services"
    for s in "${SERVICES[@]}"; do
      pm2 stop "$s" 2>/dev/null && ok "Stopped $s" || warn "$s not running"
    done
  fi
}

cmd_restart() {
  local svc="${1:-}"
  if [ -n "$svc" ]; then
    svc=$(resolve_service "$svc")
    header "Restarting $svc"
    pm2 restart "$svc" && ok "Restarted $svc"
  else
    header "Restarting all services"
    for s in "${SERVICES[@]}"; do
      pm2 restart "$s" 2>/dev/null && ok "Restarted $s" || warn "$s not running"
    done
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
#  STATUS / LOGS
# ══════════════════════════════════════════════════════════════════════════════

cmd_status() {
  header "PM2 Status"
  pm2 list
  IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
  echo ""
  info "UIs:"
  info "  Bot7     → http://${IP}:${PORT_BOT7}"
  info "  Monitor7 → http://${IP}:${PORT_MON7}"
  info "  Day7     → http://${IP}:${PORT_DAY7}"
  info "  Datalake → http://${IP}:${PORT_DATALAKE}"
}

cmd_logs() {
  local svc="${1:-}"
  header "PM2 Logs${svc:+ — $svc}  (Ctrl+C to stop)"
  if [ -n "$svc" ]; then
    svc=$(resolve_service "$svc")
    pm2 logs "$svc"
  else
    pm2 logs
  fi
}

cmd_errors() {
  local svc="${1:-}"
  header "PM2 Error Logs${svc:+ — $svc}  (Ctrl+C to stop)"
  if [ -n "$svc" ]; then
    svc=$(resolve_service "$svc")
    pm2 logs "$svc" --err
  else
    pm2 logs --err
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
#  HEALTH
# ══════════════════════════════════════════════════════════════════════════════

cmd_health() {
  header "Health Check — all services"
  IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

  _check() {
    local name=$1 url=$2
    if is_running "$name"; then ok "$name  PM2 online"; else err "$name  PM2 NOT running"; fi
    local code
    code=$(http_check "$url")
    if [ "$code" = "200" ] || [ "$code" = "307" ]; then
      ok "$name  HTTP $code at $url"
    else
      warn "$name  HTTP $code at $url"
    fi
    local mem
    mem=$(pm2 list 2>/dev/null | grep "$name" | grep -oP '\d+\.\d+[kmg]b' | head -1 || true)
    info "$name  mem: ${mem:-unknown}"
  }

  section "data-producer"
  if is_running "data-producer"; then ok "data-producer PM2 online"; else err "data-producer PM2 NOT running"; fi

  section "kucoin-datalake"
  _check "kucoin-datalake" "${DATALAKE_URL}/status"

  section "scalping-bot7"
  _check "scalping-bot7" "http://localhost:${PORT_BOT7}"

  section "scalping-monitor7"
  _check "scalping-monitor7" "http://localhost:${PORT_MON7}"

  section "scalping-day7"
  _check "scalping-day7" "http://localhost:${PORT_DAY7}"

  section "Disk"
  df -h /var/lib /dev/shm 2>/dev/null || df -h / 2>/dev/null || true
}

# ══════════════════════════════════════════════════════════════════════════════
#  BUILD / REBUILD
# ══════════════════════════════════════════════════════════════════════════════

rebuild_service() {
  local svc=$1
  local dir="$DEPLOY_ROOT/$svc"
  echo -e "${CYN}Building $svc...${RST}"
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm use 24
  cd "$dir" && npm install && npm run build
  pm2 restart "$svc"
  ok "$svc rebuilt and restarted"
}

cmd_rebuild() {
  local svc="${1:-}"
  if [ -n "$svc" ]; then
    svc=$(resolve_service "$svc")
    header "Rebuild — $svc"
    rebuild_service "$svc"
  else
    header "Rebuild — all Next.js services"
    for s in scalping-bot7 scalping-monitor7 scalping-day7; do
      rebuild_service "$s"
    done
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
#  SETUP (first-time)
# ══════════════════════════════════════════════════════════════════════════════

cmd_setup() {
  header "First-time setup — bot7 ecosystem"
  nvm_use24

  # Create deploy dirs
  for svc in "${SERVICES[@]}"; do
    mkdir -p "${DEPLOY_ROOT}/${svc}"
    ok "Created ${DEPLOY_ROOT}/${svc}"
  done

  # Create log dir
  mkdir -p /var/log/pm2
  ok "Created /var/log/pm2"

  # Create datalake data dir
  mkdir -p /var/lib/kucoin-datalake
  ok "Created /var/lib/kucoin-datalake"

  # Install deps + build for each service
  for svc in "${SERVICES[@]}"; do
    local dir="${DEPLOY_ROOT}/${svc}"
    if [ -f "${dir}/package.json" ]; then
      info "Installing deps for $svc..."
      cd "$dir" && npm install
      if grep -q '"build"' "${dir}/package.json"; then
        npm run build
      fi
      ok "$svc ready"
    else
      warn "$svc: no package.json found — skipping build"
    fi
  done

  # Copy ecosystem config
  cp "$(dirname "$0")/ecosystem.config.js" "${DEPLOY_ROOT}/ecosystem.config.js"
  ok "Copied ecosystem.config.js to ${DEPLOY_ROOT}/"

  # Start PM2
  pm2 start "${DEPLOY_ROOT}/ecosystem.config.js"
  pm2 save

  echo ""
  ok "Setup complete. Run: ./bot.sh status"
}

# ══════════════════════════════════════════════════════════════════════════════
#  DEPLOY  (scp + rebuild)
# ══════════════════════════════════════════════════════════════════════════════

cmd_deploy() {
  local src="${1:-}"
  local dest="${2:-}"
  if [ -z "$src" ] || [ -z "$dest" ]; then
    err "Usage: bot.sh deploy <local-src-dir> <server:dest-dir>"
    err "Example: bot.sh deploy ./scalping-bot7 root@1.2.3.4:/usr/local/bin/scalping-bot7"
    exit 1
  fi
  header "Deploy $src → $dest"
  # Exclude node_modules and .next for speed
  rsync -avz --exclude 'node_modules' --exclude '.next' --exclude '.git' \
    "$src/" "$dest/"
  ok "Sync complete"
  info "Tip: SSH to server and run:  bot.sh rebuild $(basename "$src")"
}

# ══════════════════════════════════════════════════════════════════════════════
#  DATALAKE / OPTIMIZER COMMANDS
# ══════════════════════════════════════════════════════════════════════════════

cmd_optimizer() {
  header "Optimizer status"
  curl -s "${DATALAKE_URL}/status" | jq . 2>/dev/null || \
    curl -s "${DATALAKE_URL}/status"
}

cmd_optimize_now() {
  header "Triggering optimizer run"
  curl -s -X POST "${DATALAKE_URL}/optimizer/start" | jq . 2>/dev/null || \
    curl -s -X POST "${DATALAKE_URL}/optimizer/start"
  echo ""
  ok "Optimizer started — watch with: ./bot.sh optimizer"
}

cmd_learning() {
  local sym="${1:-BTC-USDT}"
  header "Learning state — $sym"
  curl -s "${DATALAKE_URL}/learning/${sym}" | jq . 2>/dev/null || \
    curl -s "${DATALAKE_URL}/learning/${sym}"
}

cmd_regime() {
  local sym="${1:-BTC-USDT}"
  header "Regime — $sym"
  curl -s "${DATALAKE_URL}/regime/${sym}" | jq . 2>/dev/null || \
    curl -s "${DATALAKE_URL}/regime/${sym}"
}

cmd_params() {
  local sym="${1:-BTC-USDT}"
  header "Best params — $sym"
  curl -s "${DATALAKE_URL}/params/${sym}" | jq . 2>/dev/null || \
    curl -s "${DATALAKE_URL}/params/${sym}"
}

cmd_runs() {
  header "Recent optimizer runs"
  curl -s "${DATALAKE_URL}/runs" | jq . 2>/dev/null || \
    curl -s "${DATALAKE_URL}/runs"
}

# ══════════════════════════════════════════════════════════════════════════════
#  ANALYSE  (regime + params + trades for one symbol)
# ══════════════════════════════════════════════════════════════════════════════

cmd_analyse() {
  local sym="${1:-BTC-USDT}"
  header "Analysis — $sym"

  section "Regime"
  curl -s "${DATALAKE_URL}/regime/${sym}" | jq . 2>/dev/null || \
    curl -s "${DATALAKE_URL}/regime/${sym}"

  section "Best Params"
  curl -s "${DATALAKE_URL}/params/${sym}" | jq . 2>/dev/null || \
    curl -s "${DATALAKE_URL}/params/${sym}"

  section "Recent trades (SHM)"
  local shm_trades
  if [ "$(uname)" = "Linux" ]; then
    shm_trades="/dev/shm/datalake/trades/${sym}.json"
  else
    shm_trades="/tmp/datalake/trades/${sym}.json"
  fi

  if [ -f "$shm_trades" ]; then
    python3 -c "
import json, datetime
raw = json.load(open('${shm_trades}'))
if not raw:
    print('  No trades for ${sym}')
    exit()
grn='\033[0;32m'; red='\033[0;31m'; yel='\033[0;33m'; rst='\033[0m'
print(f'  {len(raw)} trades')
for t in raw[-10:]:
    pnl = t.get('pnlUSDT', t.get('pnl', 0))
    dt  = datetime.datetime.fromtimestamp(t.get('exitTime', t.get('ts', 0))/1000).strftime('%m-%d %H:%M')
    c   = grn if pnl >= 0 else red
    print(f'  {dt}  {c}{\"+\" if pnl>=0 else \"\"}{pnl:.2f}{rst}')
" 2>/dev/null || warn "Cannot parse trades file"
  else
    warn "No SHM trades file: $shm_trades"
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
#  UPDATE  (git pull + rebuild all)
# ══════════════════════════════════════════════════════════════════════════════

cmd_update() {
  header "Update — git pull + rebuild all"
  nvm_use24

  for svc in "${SERVICES[@]}"; do
    local dir="${DEPLOY_ROOT}/${svc}"
    if [ -d "${dir}/.git" ]; then
      section "$svc — git pull"
      cd "$dir" && git pull && ok "Pulled $svc"
    else
      info "$svc: no .git dir — skipping git pull"
    fi
    if [ -f "${dir}/package.json" ]; then
      cd "$dir" && npm install
      if grep -q '"build"' "${dir}/package.json"; then
        npm run build && ok "Built $svc"
      fi
      pm2 restart "$svc" 2>/dev/null && ok "Restarted $svc" || warn "$svc not in PM2"
    fi
  done
  ok "Update complete"
}

# ══════════════════════════════════════════════════════════════════════════════
#  VERSION
# ══════════════════════════════════════════════════════════════════════════════

cmd_version() {
  header "Service versions"
  info "Node: $(node --version 2>/dev/null || echo 'not found')"
  info "npm:  $(npm --version 2>/dev/null || echo 'not found')"
  info "PM2:  $(pm2 --version 2>/dev/null || echo 'not found')"
  echo ""
  for svc in "${SERVICES[@]}"; do
    local pkg="${DEPLOY_ROOT}/${svc}/package.json"
    if [ -f "$pkg" ]; then
      local ver
      ver=$(python3 -c "import json; print(json.load(open('$pkg')).get('version','?'))" 2>/dev/null || echo "?")
      info "$svc  v$ver"
    else
      warn "$svc  (no package.json)"
    fi
  done
}

# ══════════════════════════════════════════════════════════════════════════════
#  INTERACTIVE MENU
# ══════════════════════════════════════════════════════════════════════════════

show_menu() {
  echo -e "\n${WHT}  bot7 ecosystem manager${RST}"
  echo -e "${BLU}────────────────────────────────────────────────────${RST}"
  echo -e "${WHT}  SERVICE CONTROL${RST}"
  echo -e "  ${GRN}start [svc]${RST}        Start all or specific service"
  echo -e "  ${GRN}stop [svc]${RST}         Stop all or specific service"
  echo -e "  ${GRN}restart [svc]${RST}      Restart all or specific service"
  echo -e "  ${GRN}rebuild [svc]${RST}      npm install + build + pm2 restart"
  echo -e "  ${GRN}setup${RST}              First-time: install, build, start PM2"
  echo -e "  ${GRN}update${RST}             git pull + rebuild all"
  echo -e "${BLU}────────────────────────────────────────────────────${RST}"
  echo -e "${WHT}  MONITORING${RST}"
  echo -e "  ${GRN}status${RST}             PM2 process list"
  echo -e "  ${GRN}health${RST}             Full health check (HTTP + mem + disk)"
  echo -e "  ${GRN}logs [svc]${RST}         PM2 live logs"
  echo -e "  ${GRN}errors [svc]${RST}       PM2 error logs"
  echo -e "  ${GRN}version${RST}            Show versions"
  echo -e "${BLU}────────────────────────────────────────────────────${RST}"
  echo -e "${WHT}  DATALAKE / OPTIMIZER${RST}"
  echo -e "  ${GRN}optimizer${RST}          GET /status"
  echo -e "  ${GRN}optimize-now${RST}       POST /optimizer/start"
  echo -e "  ${GRN}learning [sym]${RST}     GET /learning/{symbol}"
  echo -e "  ${GRN}regime [sym]${RST}       GET /regime/{symbol}"
  echo -e "  ${GRN}params [sym]${RST}       GET /params/{symbol}"
  echo -e "  ${GRN}runs${RST}               GET /runs"
  echo -e "  ${GRN}analyse [sym]${RST}      regime + params + recent trades"
  echo -e "${BLU}────────────────────────────────────────────────────${RST}"
  echo -e "  ${GRN}deploy [src] [dst]${RST} rsync local dir to server"
  echo -e "  ${GRN}q / quit${RST}           Exit"
  echo -e "${BLU}────────────────────────────────────────────────────${RST}"
  echo -e "  ${DIM}Services: ${SERVICES[*]}${RST}"
}

run_command() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    start)        cmd_start "$@" ;;
    stop)         cmd_stop "$@" ;;
    restart)      cmd_restart "$@" ;;
    status)       cmd_status ;;
    logs)         cmd_logs "$@" ;;
    errors)       cmd_errors "$@" ;;
    health)       cmd_health ;;
    rebuild)      cmd_rebuild "$@" ;;
    setup)        cmd_setup ;;
    deploy)       cmd_deploy "$@" ;;
    optimizer)    cmd_optimizer ;;
    optimize-now) cmd_optimize_now ;;
    learning)     cmd_learning "$@" ;;
    regime)       cmd_regime "$@" ;;
    params)       cmd_params "$@" ;;
    runs)         cmd_runs ;;
    analyse)      cmd_analyse "$@" ;;
    update)       cmd_update ;;
    version)      cmd_version ;;
    q|quit)       echo "Bye."; exit 0 ;;
    "")           show_menu ;;
    *)
      err "Unknown command: $cmd"
      echo ""
      show_menu ;;
  esac
}

# ── Entry point ───────────────────────────────────────────────────────────────
if [ $# -ge 1 ]; then
  run_command "$@"
else
  while true; do
    show_menu
    echo -n "  Command: "
    read -r -a args
    run_command "${args[@]:-}"
  done
fi
