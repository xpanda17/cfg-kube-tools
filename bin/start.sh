#!/usr/bin/env bash
#
# Starts kube-tools, clearing a stale instance off the port first.
#
# Only ever kills a process whose command line is this repo's bin/cli.js. If
# anything else is holding the port, it says so and stops rather than guessing.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$REPO/bin/cli.js"
DEFAULT_PORT=14777

# Mirrors the parsing in cli.js: "--port N", not "--port=N".
port="$DEFAULT_PORT"
for ((i = 1; i <= $#; i++)); do
  if [[ "${!i}" == "--port" ]]; then
    next=$((i + 1))
    port="${!next:-}"
  fi
done

if ! [[ "$port" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
  echo "Invalid --port value: $port" >&2
  exit 1
fi

# PIDs listening on the port. Never matches on a command-line pattern: a pgrep
# for "cli.js" also matches the shell running this script.
listeners() {
  lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true
}

pids="$(listeners)"

if [[ -n "$pids" ]]; then
  for pid in $pids; do
    cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"

    if [[ "$cmd" != *"$ENTRY"* ]]; then
      echo "Port $port is held by PID $pid, which is not kube-tools:" >&2
      echo "  ${cmd:-<unreadable: owned by another user?>}" >&2
      echo "Refusing to kill it. Free the port, or start with --port <other>." >&2
      exit 1
    fi
  done

  echo "Port $port already in use by kube-tools (PID $(echo "$pids" | tr '\n' ' ' | sed 's/ $//')); stopping it."

  # SIGTERM, not SIGKILL: cli.js traps it and shuts down its port-forward child
  # processes, which would otherwise keep their own ports open.
  kill $pids 2>/dev/null || true

  for _ in $(seq 1 50); do
    [[ -z "$(listeners)" ]] && break
    sleep 0.1
  done

  remaining="$(listeners)"

  if [[ -n "$remaining" ]]; then
    echo "Still up after 5s; sending SIGKILL." >&2
    kill -9 $remaining 2>/dev/null || true
    sleep 0.5
  fi
fi

exec node "$ENTRY" "$@"
