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
CLI_PATH="$(pwd)/src/cli.js"
NODE_PATH="$(command -v node)"
PORT=48777

cleanup() {
  HOME="$SMOKE_ROOT" "$NODE_PATH" "$CLI_PATH" stop >/dev/null 2>&1 || true
  HOME="$SMOKE_ROOT" "$NODE_PATH" "$CLI_PATH" service uninstall >/dev/null 2>&1 || true
  case "$SMOKE_ROOT" in
    "${TMPDIR:-/tmp}"/agent-host-service-smoke.*) rm -rf "$SMOKE_ROOT" ;;
    *) echo "Refusing to remove unexpected smoke directory: $SMOKE_ROOT" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

HOME="$SMOKE_ROOT" "$NODE_PATH" "$CLI_PATH" init \
  --port "$PORT" \
  --enabled-adapters process
HOME="$SMOKE_ROOT" "$NODE_PATH" "$CLI_PATH" service install
HOME="$SMOKE_ROOT" "$NODE_PATH" "$CLI_PATH" start

attempt=0
until HOME="$SMOKE_ROOT" "$NODE_PATH" "$CLI_PATH" status --json >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "LaunchAgent did not become healthy." >&2
    exit 1
  fi
  sleep 1
done

HOME="$SMOKE_ROOT" "$NODE_PATH" "$CLI_PATH" stop
HOME="$SMOKE_ROOT" "$NODE_PATH" "$CLI_PATH" restart
attempt=0
until HOME="$SMOKE_ROOT" "$NODE_PATH" "$CLI_PATH" status --json >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "LaunchAgent did not recover after restart." >&2
    exit 1
  fi
  sleep 1
done
HOME="$SMOKE_ROOT" "$NODE_PATH" "$CLI_PATH" stop
HOME="$SMOKE_ROOT" "$NODE_PATH" "$CLI_PATH" service uninstall

test -f "$SMOKE_ROOT/.agent-host/config.json"
test -f "$SMOKE_ROOT/.agent-host/token"
echo "agent-host macOS LaunchAgent smoke test passed"
