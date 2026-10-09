#!/usr/bin/env bash
set -euo pipefail

LANE="${1:-}"
ENV_SOURCE="${2:-}"
REGISTRY_SOURCE="${3:-}"
INHERIT_WORKER_FROM="${4:-}"
[[ "$LANE" =~ ^sandbox[3-5]$ ]] || { echo "invalid sandbox lane" >&2; exit 2; }
if [[ -n "$INHERIT_WORKER_FROM" ]]; then
  [[ ( "$INHERIT_WORKER_FROM" =~ ^sandbox[3-5]$ || "$INHERIT_WORKER_FROM" == mcp-test ) && "$INHERIT_WORKER_FROM" != "$LANE" ]] || { echo "invalid worker credential source lane" >&2; exit 2; }
fi
PORT=$((18880 + ${LANE#sandbox}))
SERVICE=agent-runner-api-${LANE}.service
ENV_FILE=/etc/agent-runner/agent-runner-api-${LANE}.env
REGISTRY=/etc/agent-runner/key-registry-${LANE}.json
UNIT_FILE=/etc/systemd/system/agent-runner-api-${LANE}.service
ROOT=/opt/sb/ai-agent-runner-api-${LANE}
STATE=/var/lib/agent-runner/${LANE}

die() { printf '[%s-bootstrap] ERROR: %s\n' "$LANE" "$1" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die 'root is required'
[[ "$(hostname -s)" == vmi3617957 ]] || die 'unrecognized host'
[[ -f "$ENV_SOURCE" && -f "$REGISTRY_SOURCE" ]] || die 'bootstrap inputs missing'
[[ ! -e "$ENV_FILE" && ! -e "$REGISTRY" && ! -e "$UNIT_FILE" && ! -e "$ROOT" ]] || die 'service already exists; refusing to replace credentials or state'
[[ -x /usr/local/bin/node ]] || die 'Node runtime missing'
id sandbox >/dev/null || die 'sandbox service user missing'

if [[ -n "$INHERIT_WORKER_FROM" ]]; then
  SOURCE_ENV="/etc/agent-runner/agent-runner-api-${INHERIT_WORKER_FROM}.env"
  [[ -f "$SOURCE_ENV" ]] || die 'source lane environment missing'
  MERGED_ENV="$(mktemp)"
  chmod 0600 "$MERGED_ENV"
  trap 'rm -f "$MERGED_ENV"' EXIT
  python3 - "$ENV_SOURCE" "$SOURCE_ENV" "$MERGED_ENV" <<'PY'
import sys
target_path, source_path, output_path = sys.argv[1:]
target = open(target_path, encoding='utf-8').read().splitlines(keepends=True)
source = open(source_path, encoding='utf-8').read().splitlines(keepends=True)
def key(line):
    return line.split('=', 1)[0] if '=' in line and not line.startswith('#') else ''
present = {key(line) for line in target}
allowed = {'AGENT_API_WORKERS', 'EXTERNAL_WORKER_URL', 'EXTERNAL_WORKER_TOKEN',
           'EXTERNAL_WORKER_ENGINE', 'AGENT_API_ENV', 'LLM_LADDER_TOKEN'}
copied = [line for line in source if key(line) in allowed and key(line) not in present]
with open(output_path, 'w', encoding='utf-8') as output:
    output.writelines(target)
    if target and not target[-1].endswith('\n'):
        output.write('\n')
    output.writelines(copied)
PY
  ENV_SOURCE="$MERGED_ENV"
fi

python3 - "$ENV_SOURCE" "$REGISTRY_SOURCE" "$LANE" "$PORT" <<'PY'
import json, sys
env_path, registry_path, lane, port = sys.argv[1:]
values = {}
for line in open(env_path, encoding='utf-8'):
    if line.startswith('#') or not line.strip():
        continue
    if '=' not in line:
        raise SystemExit('invalid sandbox EnvironmentFile line')
    key, value = line.rstrip('\n').split('=', 1)
    values[key] = value.strip('"\'')
required = {
    'AGENT_API_PORT': port,
    'AGENT_API_KEY_REGISTRY': f'/etc/agent-runner/key-registry-{lane}.json',
    'AGENT_API_ADMISSION_LOG': f'/var/lib/agent-runner/{lane}/admissions.jsonl',
    'AGENT_API_PROFILE_WORKSPACE_ROOT': f'/var/lib/agent-runner/{lane}/profiles',
    'AGENT_API_ENVIRONMENT': 'sandbox',
}
for key, expected in required.items():
    if values.get(key) != expected:
        raise SystemExit(f'{key} does not match the dedicated sandbox target')
if values.get('AGENT_API_ENABLE_MOCK_TEST') == 'true':
    raise SystemExit('mock-test is not a real-agent sandbox target')
if not (values.get('AGENT_API_WORKERS') or values.get('EXTERNAL_WORKER_URL')):
    raise SystemExit('real external worker is not configured')
if not values.get('AGENT_API_PROFILE_DELEGATION_SECRET'):
    raise SystemExit('profile delegation secret is missing')
records = json.load(open(registry_path, encoding='utf-8')).get('principals', [])
if not any(p.get('principalId') == f'integration-{lane}-v1'
           and p.get('profileId') == f'integration-{lane}-v1'
           and {'runs:read', 'runs:write'}.issubset(set(p.get('scopes', [])))
           for p in records):
    raise SystemExit('dedicated key registry lacks the lane principal')
PY

# Bootstrap writes only new lane paths. Optional inheritance copies worker and
# provider access, while CP principal/delegation and run state stay separate.
install -d -o root -g root -m 0755 /etc/agent-runner
install -d -o sandbox -g sandbox -m 0700 "$STATE"
install -d -o root -g root -m 0755 "$ROOT"
install -m 0600 -o root -g root "$ENV_SOURCE" "$ENV_FILE"
install -m 0600 -o sandbox -g sandbox "$REGISTRY_SOURCE" "$REGISTRY"
cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Isolated ${LANE} Agent Runner API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sandbox
Group=sandbox
WorkingDirectory=/opt/sb/ai-agent-runner-api-${LANE}/current
EnvironmentFile=/etc/agent-runner/agent-runner-api-${LANE}.env
ExecStart=/usr/local/bin/node /opt/sb/ai-agent-runner-api-${LANE}/current/dist/api/main.js
Restart=always
RestartSec=2
TimeoutStopSec=20
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agent-runner-api-${LANE}

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$UNIT_FILE"
systemctl daemon-reload
printf '[%s-bootstrap] dedicated unit and config prepared; no service started\n' "$LANE"
