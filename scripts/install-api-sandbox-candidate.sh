#!/usr/bin/env bash
set -euo pipefail

SOURCE_SHA="${1:-}"
BUNDLE_SHA="${2:-}"
BUNDLE_PATH="${3:-}"
EXPECTED_HOST="vmi3617957"
SERVICE="agent-runner-api-mcp-test.service"
ENV_FILE="/etc/agent-runner/agent-runner-api-mcp-test.env"
UNIT_FILE="/etc/systemd/system/agent-runner-api-mcp-test.service"
ROOT="/opt/sb/ai-agent-runner-api-mcp-test"
CURRENT="$ROOT/current"
API_PORT="18882"

die() { printf '[runner-api-sandbox] ERROR: %s\n' "$1" >&2; exit 1; }
log() { printf '[runner-api-sandbox] %s\n' "$1"; }

[[ $EUID -eq 0 ]] || die 'installer requires root'
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'source SHA is malformed'
[[ "$BUNDLE_SHA" =~ ^[0-9a-f]{64}$ ]] || die 'bundle SHA is malformed'
[[ -f "$BUNDLE_PATH" ]] || die 'candidate bundle is missing'
[[ "$(hostname -s)" == "$EXPECTED_HOST" ]] || die 'refusing to install on an unrecognized host'
[[ -f "$ENV_FILE" ]] || die 'isolated MCP test EnvironmentFile is missing'
[[ "$(systemctl show "$SERVICE" -p FragmentPath --value)" == "$UNIT_FILE" ]] || die 'service unit is not the isolated MCP test unit'
systemctl show "$SERVICE" -p EnvironmentFiles --value | grep -Fq "$ENV_FILE" || die 'service does not use the isolated MCP test EnvironmentFile'
[[ -x /usr/local/bin/node ]] || die 'expected Node runtime is missing'
[[ "$(sed -n 's/^AGENT_API_PORT=//p' "$ENV_FILE" | tail -n 1)" == "$API_PORT" ]] || die 'test API port does not match the isolated target'

ACTUAL_BUNDLE_SHA="$(sha256sum "$BUNDLE_PATH" | awk '{print $1}')"
[[ "$ACTUAL_BUNDLE_SHA" == "$BUNDLE_SHA" ]] || die 'candidate bundle checksum mismatch'
python3 - "$BUNDLE_PATH" "$SOURCE_SHA" <<'PY'
import json, posixpath, sys, tarfile
archive, expected = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as tar:
    members = tar.getmembers()
    for member in members:
        name = posixpath.normpath(member.name)
        if name.startswith('/') or name == '..' or name.startswith('../'):
            raise SystemExit('unsafe archive path')
        if member.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
            if member.linkname.startswith('/') or target == '..' or target.startswith('../'):
                raise SystemExit('unsafe archive link')
        elif not (member.isdir() or member.isfile()) or member.mode & 0o6000:
            raise SystemExit('unsupported archive entry')
    manifest_file = tar.extractfile('candidate-manifest.json')
    if manifest_file is None:
        raise SystemExit('candidate manifest is missing')
    manifest = json.load(manifest_file)
    if manifest.get('target') != 'agent-runner-api-mcp-test' or manifest.get('sourceSha') != expected:
        raise SystemExit('candidate manifest does not match the isolated target and source')
PY

RELEASE="$ROOT/releases/$SOURCE_SHA"
STAGE="$ROOT/releases/.stage-$SOURCE_SHA"
STATE="$ROOT/rollback/$SOURCE_SHA"
install -d -m 0755 -o root -g root "$ROOT/releases" "$ROOT/rollback" "$STATE"
if [[ -L "$CURRENT" && "$(readlink -f "$CURRENT")" == "$RELEASE" ]]; then
  log 'candidate is already current; verifying service health'
  install -m 0755 -o root -g root "$RELEASE/scripts/provision-api-sandbox-principal.sh" /usr/local/sbin/runner-api-mcp-test-provision-principal
  MOCK_MODE_STATE="$(python3 "$RELEASE/scripts/enable-api-sandbox-mock-test.py" "$ENV_FILE")" || die 'could not enable sandbox mock-test mode'
  [[ "$MOCK_MODE_STATE" == mock_test_sandbox_mode_already_enabled ]] || systemctl restart "$SERVICE"
  HEALTHY=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$API_PORT/healthz" >/dev/null; then HEALTHY=1; break; fi
    sleep 1
  done
  [[ "$HEALTHY" == 1 ]] || die 'current candidate health check failed'
  grep -Fxq 'AGENT_API_ENVIRONMENT=sandbox' "$ENV_FILE" || die 'mock-test sandbox environment is not enabled'
  grep -Fxq 'AGENT_API_ENABLE_MOCK_TEST=true' "$ENV_FILE" || die 'mock-test sandbox engine is not enabled'
  exit 0
fi

[[ ! -e "$RELEASE" ]] || die 'release directory already exists with a different current pointer'
rm -rf -- "$STAGE"
install -d -m 0755 -o root -g root "$STAGE"
tar -xzf "$BUNDLE_PATH" -C "$STAGE" --no-same-owner
[[ -f "$STAGE/dist/api/main.js" && -f "$STAGE/dist/ops/sandbox-principal-provisioner-cli.js" && -d "$STAGE/node_modules" && -f "$STAGE/scripts/install-api-sandbox-candidate.sh" && -f "$STAGE/scripts/rollback-api-sandbox-candidate.sh" && -f "$STAGE/scripts/provision-api-sandbox-principal.sh" && -f "$STAGE/scripts/enable-api-sandbox-mock-test.py" ]] || die 'candidate bundle is incomplete'
chown -R sandbox:sandbox "$STAGE"
mv "$STAGE" "$RELEASE"
install -m 0755 -o root -g root "$RELEASE/scripts/rollback-api-sandbox-candidate.sh" /usr/local/sbin/runner-api-mcp-test-rollback
install -m 0755 -o root -g root "$RELEASE/scripts/provision-api-sandbox-principal.sh" /usr/local/sbin/runner-api-mcp-test-provision-principal

if [[ -e "$UNIT_FILE" ]]; then cp -p "$UNIT_FILE" "$STATE/unit.before"; fi
cp -p "$ENV_FILE" "$STATE/env.before"
PREVIOUS_TARGET=''
if [[ -L "$CURRENT" ]]; then PREVIOUS_TARGET="$(readlink -f "$CURRENT")"; fi
if [[ -n "$PREVIOUS_TARGET" ]]; then printf '%s\n' "$PREVIOUS_TARGET" > "$STATE/current.before"; fi

rollback() {
  local status=$?
  if (( status == 0 )) || [[ "${ROLLBACK_ACTIVE:-0}" != 1 ]]; then return; fi
  ROLLBACK_ACTIVE=0
  trap - EXIT
  log 'candidate startup failed; restoring the prior test service files'
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  if [[ -f "$STATE/unit.before" ]]; then cp -p "$STATE/unit.before" "$UNIT_FILE"; fi
  if [[ -f "$STATE/env.before" ]]; then cp -p "$STATE/env.before" "$ENV_FILE"; fi
  if [[ -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]]; then
    ln -sfn "$PREVIOUS_TARGET" "$ROOT/current.rollback"
    mv -Tf "$ROOT/current.rollback" "$CURRENT"
  elif [[ -L "$CURRENT" ]]; then
    rm -f "$CURRENT"
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl restart "$SERVICE" >/dev/null 2>&1 || true
  exit "$status"
}
ROLLBACK_ACTIVE=1
trap rollback EXIT

python3 "$RELEASE/scripts/enable-api-sandbox-mock-test.py" "$ENV_FILE" >/dev/null || die 'could not enable sandbox mock-test mode'

systemctl stop "$SERVICE"
cat > "$UNIT_FILE.tmp" <<EOF
[Unit]
Description=Isolated Registry MCP Test Agent Runner API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sandbox
Group=sandbox
WorkingDirectory=$CURRENT
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/node $CURRENT/dist/api/main.js
Restart=always
RestartSec=2
TimeoutStopSec=20
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agent-runner-api-mcp-test

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT_FILE.tmp"
mv "$UNIT_FILE.tmp" "$UNIT_FILE"
ln -sfn "$RELEASE" "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$CURRENT"
systemctl daemon-reload
systemctl restart "$SERVICE"

HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$API_PORT/healthz" >/dev/null; then HEALTHY=1; break; fi
  sleep 1
done
[[ "$HEALTHY" == 1 ]] || die 'test API did not become healthy'

grep -Fxq 'AGENT_API_ENVIRONMENT=sandbox' "$ENV_FILE" || die 'mock-test sandbox environment is not enabled'
grep -Fxq 'AGENT_API_ENABLE_MOCK_TEST=true' "$ENV_FILE" || die 'mock-test sandbox engine is not enabled'

python3 <<'PY'
import json
registry_path = '/etc/agent-runner/key-registry-mcp-test.json'
records = json.load(open(registry_path, encoding='utf-8')).get('principals', [])
required = {'runs:read', 'runs:write'}
if not any(record.get('profileId') == 'integration-telegram-ux-v1'
           and record.get('principalId') == 'integration-telegram-ux-v1'
           and required.issubset(set(record.get('scopes', []))) for record in records):
    raise SystemExit('test API registry lacks the scoped Telegram UX principal')
PY

ROLLBACK_ACTIVE=0
trap - EXIT
log "installed and health-checked isolated candidate $SOURCE_SHA; scoped test principal is present"
