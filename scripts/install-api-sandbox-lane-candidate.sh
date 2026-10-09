#!/usr/bin/env bash
set -euo pipefail

LANE="${1:-}"
SOURCE_SHA="${2:-}"
BUNDLE_SHA="${3:-}"
BUNDLE_PATH="${4:-}"
JOURNAL_CHECKER="${5:-}"
[[ "$LANE" =~ ^sandbox[3-5]$ ]] || { echo "invalid sandbox lane" >&2; exit 2; }
PORT=$((18880 + ${LANE#sandbox}))
SERVICE=agent-runner-api-${LANE}.service
ENV_FILE=/etc/agent-runner/agent-runner-api-${LANE}.env
UNIT_FILE=/etc/systemd/system/agent-runner-api-${LANE}.service
ROOT=/opt/sb/ai-agent-runner-api-${LANE}
REGISTRY=/etc/agent-runner/key-registry-${LANE}.json
JOURNAL=/var/lib/agent-runner/${LANE}/admissions.jsonl

die() { printf '[%s-api] ERROR: %s\n' "$LANE" "$1" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die 'root is required'
[[ "$(hostname -s)" == vmi3617957 ]] || die 'unrecognized host'
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ && "$BUNDLE_SHA" =~ ^[0-9a-f]{64}$ ]] || die 'invalid candidate identity'
[[ -f "$BUNDLE_PATH" ]] || die 'candidate bundle missing'
[[ -f "$JOURNAL_CHECKER" ]] || die 'journal checker missing'
[[ -f "$ENV_FILE" && -f "$UNIT_FILE" ]] || die 'dedicated service must be bootstrapped first'
[[ "$(systemctl show "$SERVICE" -p FragmentPath --value)" == "$UNIT_FILE" ]] || die 'wrong service unit'
systemctl show "$SERVICE" -p EnvironmentFiles --value | grep -Fq "$ENV_FILE" || die 'wrong environment file'
[[ -x /usr/local/bin/node ]] || die 'Node runtime missing'

# Preserve the journal across updates. Every accepted run must have a terminal
# record before this process is restarted; a nonempty journal alone is normal.
python3 "$JOURNAL_CHECKER" "$JOURNAL" || die 'admission journal contains unfinished or invalid runs'
python3 - "$ENV_FILE" "$PORT" "$REGISTRY" "$JOURNAL" "$LANE" <<'PY'
import sys
path, port, registry, journal, lane = sys.argv[1:]
values = {}
for line in open(path, encoding='utf-8'):
    if line.startswith('#') or '=' not in line:
        continue
    key, value = line.rstrip('\n').split('=', 1)
    values[key] = value.strip('"\'')
for key, expected in {'AGENT_API_PORT': port, 'AGENT_API_KEY_REGISTRY': registry,
                      'AGENT_API_ADMISSION_LOG': journal,
                      'AGENT_API_PROFILE_WORKSPACE_ROOT': f'/var/lib/agent-runner/{lane}/profiles',
                      'AGENT_API_ENVIRONMENT': 'sandbox'}.items():
    if values.get(key) != expected:
        raise SystemExit(f'{key} does not match dedicated sandbox configuration')
if values.get('AGENT_API_ENABLE_MOCK_TEST') == 'true':
    raise SystemExit('real-agent lane cannot enable mock-test')
if not (values.get('AGENT_API_WORKERS') or values.get('EXTERNAL_WORKER_URL')):
    raise SystemExit('external worker is not configured')
PY
[[ -f "$REGISTRY" ]] || die 'dedicated ${LANE} key registry missing'
python3 - "$REGISTRY" "$LANE" <<'PY'
import json, sys
records = json.load(open(sys.argv[1], encoding='utf-8')).get('principals', [])
if not any(p.get('principalId') == f'integration-{sys.argv[2]}-v1'
           and p.get('profileId') == f'integration-{sys.argv[2]}-v1'
           and {'runs:read', 'runs:write'}.issubset(set(p.get('scopes', [])))
           for p in records):
    raise SystemExit('lane principal is missing from dedicated registry')
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
    if manifest.get('target') != 'agent-runner-api-sandbox' or manifest.get('sourceSha') != sys.argv[2]:
        raise SystemExit('candidate is not for a sandbox lane at the requested SHA')
PY

RELEASE="$ROOT/releases/$SOURCE_SHA"
CURRENT="$ROOT/current"
if [[ -L "$CURRENT" && "$(readlink -f "$CURRENT")" == "$RELEASE" ]]; then
  if ! systemctl is-active --quiet "$SERVICE"; then systemctl restart "$SERVICE"; fi
  curl -fsS --retry 5 --retry-delay 1 --max-time 5 "http://127.0.0.1:$PORT/healthz" >/dev/null || die 'current candidate is unhealthy'
  systemctl is-active --quiet "$SERVICE" || die 'current service is not active'
  printf '[%s-api] current release %s is healthy\n' "$LANE" "$SOURCE_SHA"
  exit 0
fi
[[ ! -e "$RELEASE" ]] || die 'candidate release already exists with a different current pointer'
install -d -m 0755 "$ROOT/releases"
STAGE="$(mktemp -d "$ROOT/releases/.stage.XXXXXX")"
PREVIOUS=""
NEW_RELEASE_CREATED=0
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
    if (( NEW_RELEASE_CREATED == 1 )); then rm -rf -- "$RELEASE"; fi
  fi
  [[ ! -d "$STAGE" ]] || rm -rf -- "$STAGE"
  return "$status"
}
trap rollback EXIT
tar -xzf "$BUNDLE_PATH" -C "$STAGE" --no-same-owner
[[ -f "$STAGE/dist/api/main.js" && -d "$STAGE/node_modules" ]] || die 'candidate runtime incomplete'
chown -R sandbox:sandbox "$STAGE"
mv "$STAGE" "$RELEASE"
NEW_RELEASE_CREATED=1
# Close the race between the first journal check and the code switch. The old
# process cannot accept another run after stop; terminal state remains on disk.
systemctl stop "$SERVICE"
python3 "$JOURNAL_CHECKER" "$JOURNAL" || die 'a new run appeared during deployment'
ln -sfn "$RELEASE" "$CURRENT.next"
mv -Tf "$CURRENT.next" "$CURRENT"
systemctl restart "$SERVICE"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz" >/dev/null; then healthy=1; break; fi
  sleep 1
done
[[ "$healthy" == 1 ]] || die 'API did not become healthy'
systemctl is-active --quiet "$SERVICE" || die 'API service is not active'
trap - EXIT
printf '[%s-api] installed %s to dedicated service\n' "$LANE" "$SOURCE_SHA"
