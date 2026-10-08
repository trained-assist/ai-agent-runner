#!/usr/bin/env bash
set -euo pipefail

SOURCE_SHA="${1:-}"
EXPECTED_HOST="vmi3617957"
SERVICE="agent-runner-api-mcp-test.service"
ENV_FILE="/etc/agent-runner/agent-runner-api-mcp-test.env"
UNIT_FILE="/etc/systemd/system/agent-runner-api-mcp-test.service"
ROOT="/opt/sb/ai-agent-runner-api-mcp-test"
CURRENT="$ROOT/current"

die() { printf '[runner-api-sandbox] ERROR: %s\n' "$1" >&2; exit 1; }
log() { printf '[runner-api-sandbox] %s\n' "$1"; }

[[ $EUID -eq 0 ]] || die 'rollback requires root'
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'candidate SHA is malformed'
[[ "$(hostname -s)" == "$EXPECTED_HOST" ]] || die 'refusing to roll back on an unrecognized host'
[[ -f "$ENV_FILE" ]] || die 'isolated MCP test EnvironmentFile is missing'
[[ "$(systemctl show "$SERVICE" -p FragmentPath --value)" == "$UNIT_FILE" ]] || die 'service unit is not the isolated MCP test unit'
STATE="$ROOT/rollback/$SOURCE_SHA"
[[ -f "$STATE/unit.before" ]] || die 'rollback state for this candidate is missing'

systemctl stop "$SERVICE"
cp -p "$STATE/unit.before" "$UNIT_FILE"
if [[ -f "$STATE/current.before" ]]; then
  previous="$(cat "$STATE/current.before")"
  [[ "$previous" == /opt/sb/ai-agent-runner-api-mcp-test/releases/* && -d "$previous" ]] || die 'saved prior release is invalid'
  ln -sfn "$previous" "$ROOT/current.rollback"
  mv -Tf "$ROOT/current.rollback" "$CURRENT"
else
  rm -f "$CURRENT"
fi
systemctl daemon-reload
systemctl restart "$SERVICE"

PORT="$(sed -n 's/^AGENT_API_PORT=//p' "$ENV_FILE" | tail -n 1)"
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz" >/dev/null; then HEALTHY=1; break; fi
  sleep 1
done
[[ "$HEALTHY" == 1 ]] || die 'rolled-back isolated service did not become healthy'
log "rolled back the isolated Runner API candidate $SOURCE_SHA"
