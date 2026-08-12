#!/bin/sh
set -eu

if [ "${AGENT_HOST_RUN_SERVICE_SMOKE:-}" != "1" ]; then
  echo "Set AGENT_HOST_RUN_SERVICE_SMOKE=1 to run the reversible LaunchAgent smoke test." >&2
  exit 2
fi
if [ "$(uname -s)" != "Darwin" ]; then
  echo "This smoke test requires macOS." >&2
  exit 2
fi
if launchctl print "gui/$(id -u)/dev.agent-host" >/dev/null 2>&1; then
  echo "dev.agent-host is already loaded; refusing to disturb an existing service." >&2
  exit 2
fi

SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-host-service-smoke.XXXXXX")"
CLI_PATH="${AGENT_HOST_CLI_PATH:-$(pwd)/src/cli.js}"
NODE_PATH="$(command -v node)"
PORT=48777

run_host() {
  if [ -n "${AGENT_HOST_CLI_PATH:-}" ]; then
    HOME="$SMOKE_ROOT" "$CLI_PATH" "$@"
  else
    HOME="$SMOKE_ROOT" "$NODE_PATH" "$CLI_PATH" "$@"
  fi
}

cleanup() {
  run_host stop >/dev/null 2>&1 || true
  run_host service uninstall >/dev/null 2>&1 || true
  case "$SMOKE_ROOT" in
    "${TMPDIR:-/tmp}"/agent-host-service-smoke.*) rm -rf "$SMOKE_ROOT" ;;
    *) echo "Refusing to remove unexpected smoke directory: $SMOKE_ROOT" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

run_host init \
  --port "$PORT" \
  --enabled-adapters process
run_host service install
run_host start

attempt=0
until run_host status --json >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "LaunchAgent did not become healthy." >&2
    exit 1
  fi
  sleep 1
done

run_host stop
run_host restart
attempt=0
until run_host status --json >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "LaunchAgent did not recover after restart." >&2
    exit 1
  fi
  sleep 1
done
run_host stop
run_host service uninstall

test -f "$SMOKE_ROOT/.agent-host/config.json"
test -f "$SMOKE_ROOT/.agent-host/token"
echo "agent-host macOS LaunchAgent smoke test passed"
