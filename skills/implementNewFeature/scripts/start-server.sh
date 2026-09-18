#!/usr/bin/env bash
set -euo pipefail
SESSION_DIR=""
OPEN=0
# One fixed URL, so the browser tab and everything it remembers for that origin
# survive a restart. The override exists for tooling that must not fight a live run.
PORT=9999
while [ $# -gt 0 ]; do
  case "$1" in
    --session-dir) SESSION_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --open) OPEN=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -n "$SESSION_DIR" ] || { echo "usage: start-server.sh --session-dir <dir> [--port <n>] [--open]" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SESSION_DIR"
# The old instance has to go first: it holds the port, and the new one refuses to
# start anywhere else. Two servers would otherwise share this session's state file
# while the user's open tab talks to the one the orchestrator no longer polls.
if [ -f "$SESSION_DIR/server.json" ]; then
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
nohup node "$SCRIPT_DIR/server.cjs" --session-dir "$SESSION_DIR" --port "$PORT" \
  > "$SESSION_DIR/server.log" 2>&1 &
NODE_PID=$!
# A taken port makes the server exit instead of moving, so waiting out the full
# timeout would hide the one line that says what is on it.
for _ in $(seq 1 75); do
  [ -f "$SESSION_DIR/server.json" ] && break
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "server exited before it was listening:" >&2
    cat "$SESSION_DIR/server.log" >&2
    exit 1
  fi
  sleep 0.2
done
[ -f "$SESSION_DIR/server.json" ] || { echo "server did not start" >&2; exit 1; }
PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).port)" "$SESSION_DIR/server.json")
if [ "$OPEN" = 1 ]; then
  (xdg-open "http://127.0.0.1:$PORT/" || open "http://127.0.0.1:$PORT/") >/dev/null 2>&1 || true
fi
echo "{\"port\":$PORT}"
