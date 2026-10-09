#!/usr/bin/env bash
set -euo pipefail

SOURCE_SHA="${1:-}"
BUNDLE_SHA="${2:-}"
BUNDLE_PATH="${3:-}"
ARTIFACT_TARGET=agent-runner-api-sandbox3
case "${4:-}" in
  '') ;;
  --existing-mcp-runtime)
    [[ "$SOURCE_SHA" == ab8e7a3da4efa45c2154d67423542a6974576f22 && "$BUNDLE_SHA" == 42adc29e0ed20125c8703d661694c36fca59667e8294132c723cee0f0080ed4a ]] || exit 1
    ARTIFACT_TARGET=agent-runner-api-mcp-test ;;
  *) exit 1 ;;
esac
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
[[ "$(systemctl show "$SERVICE" -p User --value)" == sandbox3-api ]] || die 'wrong isolated service account'
[[ "$(systemctl show "$SERVICE" -p WorkingDirectory --value)" == "$ROOT/current" ]] || die 'wrong runtime directory'
[[ "$(systemctl show "$SERVICE" -p ExecStart --value)" == *"argv[]=/usr/local/bin/node $ROOT/current/dist/api/main.js ;"* ]] || die 'wrong runtime executable'
if systemctl is-active --quiet "$SERVICE"; then die 'initial install requires an inactive fresh service'; fi
[[ -x /usr/local/bin/node ]] || die 'Node runtime missing'

# The first install requires a clean admission journal. Later updates need a
# separate, explicit reconciliation procedure so an accepted run is never lost.
[[ ! -s "$JOURNAL" ]] || die 'sandbox3 admission journal is not empty; reconcile runs before an update'
python3 - "$ENV_FILE" "$PORT" "$REGISTRY" "$JOURNAL" <<'PY'
import os, pathlib, pwd, stat, sys
path, port, registry, journal = sys.argv[1:]
account = pwd.getpwnam('sandbox3-api')
for value, expected_uid in [(path, 0), (registry, 0), (journal, account.pw_uid)]:
    target = pathlib.Path(value)
    metadata = target.lstat()
    if target.resolve(strict=True) != target or not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise SystemExit('sandbox3 file is not a canonical unique regular file')
    if metadata.st_uid != expected_uid or stat.S_IMODE(metadata.st_mode) not in (0o600, 0o640):
        raise SystemExit('sandbox3 file ownership or permissions mismatch')
    if value == journal and metadata.st_size != 0:
        raise SystemExit('sandbox3 journal is not empty')
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
if values.get('AGENT_API_ENABLE_MOCK_TEST') != 'true' and not (values.get('AGENT_API_WORKERS') or values.get('EXTERNAL_WORKER_URL')):
    raise SystemExit('sandbox3 external worker is not configured')
PY
[[ -f "$REGISTRY" ]] || die 'dedicated sandbox3 key registry missing'
python3 - "$REGISTRY" <<'PY'
import json, sys
records = json.load(open(sys.argv[1], encoding='utf-8')).get('principals', [])
if not any(p.get('principalId') == 'sandbox3-agent-api-principal'
           and p.get('profileId') == 'integration-sandbox3-v1'
           and p.get('tenantId') == 'sandbox3-acceptance-a-20261008'
           and {'runs:read', 'runs:write'}.issubset(set(p.get('scopes', [])))
           for p in records):
    raise SystemExit('sandbox3 principal is missing from dedicated registry')
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

RELEASE="$ROOT/releases/$SOURCE_SHA"
CURRENT="$ROOT/current"
[[ "$(readlink -f "$ROOT")" == "$ROOT" ]] || die 'runtime root aliases another target'
[[ ! -e "$RELEASE" ]] || die 'candidate release already exists'
install -d -m 0755 "$ROOT/releases"
STAGE="$(mktemp -d "$ROOT/releases/.stage.XXXXXX")"
PREVIOUS=""
[[ ! -L "$CURRENT" ]] || PREVIOUS="$(readlink -f "$CURRENT")"
[[ -z "$PREVIOUS" || "$PREVIOUS" == "$ROOT/releases/"* ]] || die 'previous runtime aliases another target'
rollback() {
  status=$?
  if (( status != 0 )); then
    if [[ -s "$JOURNAL" ]]; then
      printf '[sandbox3-api] admissions appeared; preserve current runtime for reconciliation\n' >&2
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
  fi
  [[ ! -d "$STAGE" ]] || rm -rf -- "$STAGE"
  return "$status"
}
trap rollback EXIT
tar -xzf "$BUNDLE_PATH" -C "$STAGE" --no-same-owner
[[ -f "$STAGE/dist/api/main.js" && -d "$STAGE/node_modules" ]] || die 'candidate runtime incomplete'
chown -R root:root "$STAGE"
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
printf '[sandbox3-api] installed %s to dedicated service; artifact target %s\n' "$SOURCE_SHA" "$ARTIFACT_TARGET"
