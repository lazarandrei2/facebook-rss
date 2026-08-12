#!/usr/bin/env bash
# Manual background feed runner. Does not survive reboot / logout.
#
#   ./bin/run-loop.sh start    # background, every 3h
#   ./bin/run-loop.sh logs     # follow log
#   ./bin/run-loop.sh status
#   ./bin/run-loop.sh stop

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG="${LOG:-$ROOT/feed-runner.log}"
PIDFILE="${PIDFILE:-$ROOT/feed-runner.pid}"
INTERVAL="${INTERVAL:-10800}" # seconds (3h)
NODE="${NODE:-$(command -v node || true)}"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

log() {
  printf '[%s] %s\n' "$(stamp)" "$*" | tee -a "$LOG"
}

# Prefix each stdin line with the same stamp as log().
stamp_stream() {
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '[%s] %s\n' "$(stamp)" "$line"
  done
}

is_running() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null
}

run_once() {
  log "fetch --push starting"
  local status=0
  set +e
  "$NODE" --disable-warning=ExperimentalWarning bin/cli.js fetch --push 2>&1 \
    | stamp_stream >>"$LOG"
  status=${PIPESTATUS[0]}
  set -e
  if [[ $status -eq 0 ]]; then
    log "fetch --push ok"
  else
    log "fetch --push failed (exit $status)"
  fi
}

loop() {
  if [[ -z "$NODE" || ! -x "$NODE" ]]; then
    echo "node not found; start from a shell where node works, or set NODE=/path/to/node" >&2
    exit 1
  fi
  log "runner started (pid=$$ interval=${INTERVAL}s node=$NODE)"
  while true; do
    run_once
    log "sleeping ${INTERVAL}s"
    sleep "$INTERVAL"
  done
}

cmd_start() {
  if is_running; then
    echo "already running (pid $(cat "$PIDFILE"))"
    echo "follow: ./bin/run-loop.sh logs"
    exit 0
  fi
  if [[ -z "$NODE" || ! -x "$NODE" ]]; then
    echo "node not found; start from a shell where node works, or set NODE=/path/to/node" >&2
    exit 1
  fi
  # Detach so closing the terminal does not kill the loop; reboot still stops it.
  nohup "$0" _loop >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  disown $! 2>/dev/null || true
  echo "started (pid $(cat "$PIDFILE")) every ${INTERVAL}s"
  echo "logs:   ./bin/run-loop.sh logs"
  echo "status: ./bin/run-loop.sh status"
  echo "stop:   ./bin/run-loop.sh stop"
}

cmd_stop() {
  if ! is_running; then
    rm -f "$PIDFILE"
    echo "not running"
    exit 0
  fi
  local pid
  pid="$(cat "$PIDFILE")"
  kill "$pid" 2>/dev/null || true
  # Give the sleep/fetch a moment; escalate if needed.
  for _ in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  log "runner stopped (pid $pid)"
  echo "stopped"
}

cmd_status() {
  if is_running; then
    echo "running (pid $(cat "$PIDFILE")) interval=${INTERVAL}s log=$LOG"
  else
    rm -f "$PIDFILE"
    echo "not running"
  fi
}

cmd_logs() {
  touch "$LOG"
  echo "following $LOG (ctrl-c to detach; runner keeps going)"
  tail -n 50 -f "$LOG"
}

usage() {
  cat <<EOF
Usage: ./bin/run-loop.sh <start|stop|status|logs>

Runs fetch --push every 3 hours in the background.
Does not install a login/boot service — a restart stops it.

Env overrides:
  INTERVAL=10800  # seconds between runs
  NODE=/path/to/node
  LOG=/path/to/feed-runner.log
EOF
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  _loop) loop ;;
  -h|--help|"") usage; exit 1 ;;
  *) echo "unknown command: $1" >&2; usage; exit 1 ;;
esac
