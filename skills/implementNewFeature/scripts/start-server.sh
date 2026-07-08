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
rm -f "$SESSION_DIR/server.json"
nohup node "$SCRIPT_DIR/server.cjs" --session-dir "$SESSION_DIR" \
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
