#!/usr/bin/env bash
set -euo pipefail
SESSION_DIR=""
OPEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --session-dir) SESSION_DIR="$2"; shift 2 ;;
    --open) OPEN=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -n "$SESSION_DIR" ] || { echo "usage: start-server.sh --session-dir <dir> [--open]" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SESSION_DIR"
# Reuse the previous port when restarting, so a browser tab the user still has
# open keeps working; the server falls back to any free port if it is taken.
# The old instance has to go first, or it keeps the port and the new one silently
# lands on a different one: two servers would then share this session's state file
# while the user's open tab talks to the one the orchestrator no longer polls.
PREV_PORT=0
if [ -f "$SESSION_DIR/server.json" ]; then
  PREV_PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).port||0)}catch(e){console.log(0)}" "$SESSION_DIR/server.json")
  PREV_PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pid||0)}catch(e){console.log(0)}" "$SESSION_DIR/server.json")
  if [ "$PREV_PID" != "0" ] && kill -0 "$PREV_PID" 2>/dev/null; then
    kill "$PREV_PID" 2>/dev/null || true
    for _ in $(seq 1 25); do
      kill -0 "$PREV_PID" 2>/dev/null || break
      sleep 0.2
    done
  fi
  rm -f "$SESSION_DIR/server.json"
fi
nohup node "$SCRIPT_DIR/server.cjs" --session-dir "$SESSION_DIR" --port "$PREV_PORT" \
  > "$SESSION_DIR/server.log" 2>&1 &
for _ in $(seq 1 75); do
  [ -f "$SESSION_DIR/server.json" ] && break
  sleep 0.2
done
[ -f "$SESSION_DIR/server.json" ] || { echo "server did not start" >&2; exit 1; }
PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).port)" "$SESSION_DIR/server.json")
if [ "$OPEN" = 1 ]; then
  (xdg-open "http://127.0.0.1:$PORT/" || open "http://127.0.0.1:$PORT/") >/dev/null 2>&1 || true
fi
echo "{\"port\":$PORT}"
