#!/usr/bin/env bash
set -euo pipefail

SOURCE_SHA="${1:-}"
BUNDLE_SHA="${2:-}"
BUNDLE_PATH="${3:-}"
SERVICE=agent-runner-api-sandbox3.service
ENV_FILE=/etc/agent-runner/agent-runner-api-sandbox3.env
UNIT_FILE=/etc/systemd/system/agent-runner-api-sandbox3.service
ROOT=/opt/sb/ai-agent-runner-api-sandbox3
PORT=18883
REGISTRY=/etc/agent-runner/key-registry-sandbox3.json
JOURNAL=/var/lib/agent-runner/sandbox3/admissions.jsonl

die() { printf '[sandbox3-api] ERROR: %s\n' "$1" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die 'root is required'
[[ "$(hostname -s)" == vmi3617957 ]] || die 'unrecognized host'
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ && "$BUNDLE_SHA" =~ ^[0-9a-f]{64}$ ]] || die 'invalid candidate identity'
[[ -f "$BUNDLE_PATH" ]] || die 'candidate bundle missing'
[[ -f "$ENV_FILE" && -f "$UNIT_FILE" ]] || die 'dedicated sandbox3 service must be bootstrapped first'
[[ "$(systemctl show "$SERVICE" -p FragmentPath --value)" == "$UNIT_FILE" ]] || die 'wrong service unit'
systemctl show "$SERVICE" -p EnvironmentFiles --value | grep -Fq "$ENV_FILE" || die 'wrong environment file'
[[ -x /usr/local/bin/node ]] || die 'Node runtime missing'

# The first install requires a clean admission journal. Later updates need a
# separate, explicit reconciliation procedure so an accepted run is never lost.
[[ ! -s "$JOURNAL" ]] || die 'sandbox3 admission journal is not empty; reconcile runs before an update'
python3 - "$ENV_FILE" "$PORT" "$REGISTRY" "$JOURNAL" <<'PY'
import sys
path, port, registry, journal = sys.argv[1:]
values = {}
for line in open(path, encoding='utf-8'):
    if line.startswith('#') or '=' not in line:
        continue
    key, value = line.rstrip('\n').split('=', 1)
    values[key] = value.strip('"\'')
for key, expected in {'AGENT_API_PORT': port, 'AGENT_API_KEY_REGISTRY': registry,
                      'AGENT_API_ADMISSION_LOG': journal,
                      'AGENT_API_ENVIRONMENT': 'sandbox'}.items():
    if values.get(key) != expected:
        raise SystemExit(f'{key} does not match dedicated sandbox3 configuration')
if values.get('AGENT_API_ENABLE_MOCK_TEST') == 'true':
    raise SystemExit('sandbox3 real-agent lane cannot enable mock-test')
if not (values.get('AGENT_API_WORKERS') or values.get('EXTERNAL_WORKER_URL')):
    raise SystemExit('sandbox3 external worker is not configured')
PY
[[ -f "$REGISTRY" ]] || die 'dedicated sandbox3 key registry missing'
python3 - "$REGISTRY" <<'PY'
import json, sys
records = json.load(open(sys.argv[1], encoding='utf-8')).get('principals', [])
if not any(p.get('principalId') == 'integration-sandbox3-v1'
           and p.get('profileId') == 'integration-sandbox3-v1'
           and {'runs:read', 'runs:write'}.issubset(set(p.get('scopes', [])))
           for p in records):
    raise SystemExit('sandbox3 principal is missing from dedicated registry')
PY
[[ "$(sha256sum "$BUNDLE_PATH" | cut -d' ' -f1)" == "$BUNDLE_SHA" ]] || die 'bundle checksum mismatch'
python3 - "$BUNDLE_PATH" "$SOURCE_SHA" <<'PY'
import json, posixpath, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive.getmembers():
        name = posixpath.normpath(member.name)
        if name.startswith('/') or name == '..' or name.startswith('../') or not (member.isfile() or member.isdir()):
            raise SystemExit('unsafe candidate archive entry')
        if member.issym() or member.islnk() or member.mode & 0o6000:
            raise SystemExit('unsafe candidate archive metadata')
    manifest = json.load(archive.extractfile('candidate-manifest.json'))
    if manifest.get('target') != 'agent-runner-api-sandbox3' or manifest.get('sourceSha') != sys.argv[2]:
        raise SystemExit('candidate is not for sandbox3 at the requested SHA')
PY

RELEASE="$ROOT/releases/$SOURCE_SHA"
CURRENT="$ROOT/current"
[[ ! -e "$RELEASE" ]] || die 'candidate release already exists'
install -d -m 0755 "$ROOT/releases"
STAGE="$(mktemp -d "$ROOT/releases/.stage.XXXXXX")"
PREVIOUS=""
[[ ! -L "$CURRENT" ]] || PREVIOUS="$(readlink -f "$CURRENT")"
rollback() {
  status=$?
  if (( status != 0 )); then
    if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
      ln -sfn "$PREVIOUS" "$CURRENT.rollback"
      mv -Tf "$CURRENT.rollback" "$CURRENT"
      systemctl restart "$SERVICE" >/dev/null 2>&1 || true
    else
      rm -f "$CURRENT"
      systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    fi
  fi
  [[ ! -d "$STAGE" ]] || rm -rf -- "$STAGE"
  return "$status"
}
trap rollback EXIT
tar -xzf "$BUNDLE_PATH" -C "$STAGE" --no-same-owner
[[ -f "$STAGE/dist/api/main.js" && -d "$STAGE/node_modules" ]] || die 'candidate runtime incomplete'
chown -R sandbox:sandbox "$STAGE"
mv "$STAGE" "$RELEASE"
ln -sfn "$RELEASE" "$CURRENT.next"
mv -Tf "$CURRENT.next" "$CURRENT"
systemctl restart "$SERVICE"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz" >/dev/null; then healthy=1; break; fi
  sleep 1
done
[[ "$healthy" == 1 ]] || die 'sandbox3 API did not become healthy'
trap - EXIT
printf '[sandbox3-api] installed %s to dedicated service\n' "$SOURCE_SHA"
