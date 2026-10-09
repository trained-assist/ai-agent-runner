#!/usr/bin/env bash
set -euo pipefail

LANE="${1:-}"
SOURCE_SHA="${2:-}"
BUNDLE_SHA="${3:-}"
BUNDLE_PATH="${4:-}"
JOURNAL_CHECKER="${5:-}"
CONTRACT_STAGE=0
ARTIFACT_TARGET=agent-runner-api-sandbox
case "${6:-}" in
  '') ;;
  --existing-mcp-runtime)
    [[ "$LANE" == sandbox3 && "$SOURCE_SHA" == ab8e7a3da4efa45c2154d67423542a6974576f22 && "$BUNDLE_SHA" == 42adc29e0ed20125c8703d661694c36fca59667e8294132c723cee0f0080ed4a ]] || exit 1
    CONTRACT_STAGE=1
    ARTIFACT_TARGET=agent-runner-api-mcp-test ;;
  *) exit 1 ;;
esac
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
EXPECTED_USER=sandbox
(( CONTRACT_STAGE == 0 )) || EXPECTED_USER=sandbox3-api
[[ "$(systemctl show "$SERVICE" -p User --value)" == "$EXPECTED_USER" ]] || die 'wrong isolated service account'
[[ "$(systemctl show "$SERVICE" -p WorkingDirectory --value)" == "$ROOT/current" ]] || die 'wrong runtime directory'
[[ "$(systemctl show "$SERVICE" -p ExecStart --value)" == *"argv[]=/usr/local/bin/node $ROOT/current/dist/api/main.js ;"* ]] || die 'wrong runtime executable'
# A terminal snapshot is not an admission fence. This installer never stops an
# active API; updates need a separately proven operator quiescence procedure.
if systemctl is-active --quiet "$SERVICE"; then die 'installation requires an inactive fenced service'; fi
[[ -x /usr/local/bin/node ]] || die 'Node runtime missing'

# Preserve the journal across updates. Every accepted run must have a terminal
# record before this process is restarted; a nonempty journal alone is normal.
python3 "$JOURNAL_CHECKER" "$JOURNAL" || die 'admission journal contains unfinished or invalid runs'
python3 - "$ENV_FILE" "$PORT" "$REGISTRY" "$JOURNAL" "$LANE" "$CONTRACT_STAGE" "$EXPECTED_USER" <<'PY'
import pathlib, pwd, stat, sys
path, port, registry, journal, lane, contract_stage, expected_user = sys.argv[1:]
account = pwd.getpwnam(expected_user)
for value in [path, registry, journal]:
    target = pathlib.Path(value)
    metadata = target.lstat()
    if target.resolve(strict=True) != target or not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise SystemExit('sandbox file is not a canonical unique regular file')
    if stat.S_IMODE(metadata.st_mode) not in (0o600, 0o640):
        raise SystemExit('sandbox file permissions mismatch')
    if value == journal and metadata.st_uid != account.pw_uid:
        raise SystemExit('sandbox journal writer ownership mismatch')
    if contract_stage == '1' and value == journal and metadata.st_size != 0:
        raise SystemExit('initial contract journal is not empty')
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
        raise SystemExit(f'{key} does not match dedicated sandbox configuration')
if contract_stage != '1' and values.get('AGENT_API_PROFILE_WORKSPACE_ROOT') != f'/var/lib/agent-runner/{lane}/profiles':
    raise SystemExit('profile workspace root does not match sandbox target')
if contract_stage != '1' and values.get('AGENT_API_ENABLE_MOCK_TEST') == 'true':
    raise SystemExit('real-agent lane cannot enable mock-test')
if contract_stage != '1' and not (values.get('AGENT_API_WORKERS') or values.get('EXTERNAL_WORKER_URL')):
    raise SystemExit('external worker is not configured')
PY
[[ -f "$REGISTRY" ]] || die 'dedicated ${LANE} key registry missing'
python3 - "$REGISTRY" "$LANE" "$CONTRACT_STAGE" <<'PY'
import json, sys
records = json.load(open(sys.argv[1], encoding='utf-8')).get('principals', [])
principal = 'sandbox3-agent-api-principal' if sys.argv[3] == '1' else f'integration-{sys.argv[2]}-v1'
if not any(p.get('principalId') == principal
           and p.get('profileId') == f'integration-{sys.argv[2]}-v1'
           and {'runs:read', 'runs:write'}.issubset(set(p.get('scopes', [])))
           for p in records):
    raise SystemExit('lane principal is missing from dedicated registry')
PY
[[ "$(sha256sum "$BUNDLE_PATH" | cut -d' ' -f1)" == "$BUNDLE_SHA" ]] || die 'bundle checksum mismatch'
python3 - "$BUNDLE_PATH" "$SOURCE_SHA" "$ARTIFACT_TARGET" <<'PY'
import json, posixpath, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    names = {}
    for member in members:
        name = posixpath.normpath(member.name)
        if name.startswith('/') or name == '..' or name.startswith('../') or name in names:
            raise SystemExit('unsafe or duplicate candidate archive path')
        if not (member.isfile() or member.isdir() or member.issym()) or member.mode & 0o6000:
            raise SystemExit('unsafe candidate archive metadata')
        names[name] = member
    for name, member in names.items():
        ancestors = name.split('/')[:-1]
        if any(names.get('/'.join(ancestors[:i + 1])) and names['/'.join(ancestors[:i + 1])].issym()
               for i in range(len(ancestors))):
            raise SystemExit('candidate path traverses a symlink')
        if member.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
            # npm executable links point to a regular in-archive file. Do not
            # allow link chains, directories, absolute or escaping targets.
            destination = names.get(target)
            if member.linkname.startswith('/') or not destination or not destination.isfile():
                raise SystemExit('unsafe candidate archive link')
            parts = target.split('/')[:-1]
            if any(names.get('/'.join(parts[:i + 1])) and names['/'.join(parts[:i + 1])].issym()
                   for i in range(len(parts))):
                raise SystemExit('candidate link target traverses a symlink')
    manifest_member = names.get('candidate-manifest.json')
    if not manifest_member or not manifest_member.isfile() or manifest_member.size > 65536:
        raise SystemExit('candidate manifest invalid')
    manifest = json.load(archive.extractfile(manifest_member))
    if manifest.get('target') != sys.argv[3] or manifest.get('sourceSha') != sys.argv[2]:
        raise SystemExit('candidate target/source mismatch')
PY

[[ "$(readlink -f "$ROOT")" == "$ROOT" ]] || die 'runtime root aliases another target'
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
[[ -z "$PREVIOUS" || "$PREVIOUS" == "$ROOT/releases/"* ]] || die 'previous runtime aliases another target'
rollback() {
  status=$?
  if (( status != 0 )); then
    if ! python3 "$JOURNAL_CHECKER" "$JOURNAL" >/dev/null 2>&1; then
      printf '[%s-api] admissions unresolved; preserve runtime for reconciliation\n' "$LANE" >&2
      return "$status"
    fi
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
chown -R root:root "$STAGE"
mv "$STAGE" "$RELEASE"
NEW_RELEASE_CREATED=1
# The service was required to be inactive before the first check. Repeat the
# journal check before the switch without stopping any potentially live run.
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
