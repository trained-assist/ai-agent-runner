#!/usr/bin/env bash
set -euo pipefail

REPO='trained-assist/ai-agent-runner'
SIGNER_WORKFLOW='trained-assist/ai-agent-runner/.github/workflows/runner-api-sandbox-candidate.yml'
SSH_TARGET='vm2'

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-api-sandbox-candidate.sh /path/to/runner-api-sandbox-candidate.tar.gz

Verifies a GitHub Actions provenance attestation and installs only the isolated
agent-runner-api-mcp-test service on the configured vm2 SSH target.
USAGE
}

die() { printf '[runner-api-sandbox] ERROR: %s\n' "$1" >&2; exit 1; }

die 'VM-hosted Node API deployment is retired; deploy the Cloudflare Worker after its documented gates are cleared'

ARTIFACT="${1:-}"
[[ -n "$ARTIFACT" ]] || { usage >&2; exit 2; }
[[ -f "$ARTIFACT" ]] || die 'candidate archive is missing'
for tool in gh ssh scp sha256sum tar python3; do command -v "$tool" >/dev/null || die "required local tool is missing: $tool"; done
[[ -f "$ARTIFACT.sha256" ]] || die 'candidate checksum file is missing beside the archive'
(cd "$(dirname "$ARTIFACT")" && sha256sum -c "$(basename "$ARTIFACT").sha256" >/dev/null) || die 'candidate checksum verification failed'

gh attestation verify "$ARTIFACT" --repo "$REPO" --signer-workflow "$SIGNER_WORKFLOW" >/dev/null || die 'candidate provenance verification failed'

python3 - "$ARTIFACT" <<'PY'
import json, posixpath, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as tar:
    for member in tar.getmembers():
        name = posixpath.normpath(member.name)
        if name.startswith('/') or name == '..' or name.startswith('../'):
            raise SystemExit('unsafe candidate archive path')
        if member.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
            if member.linkname.startswith('/') or target == '..' or target.startswith('../'):
                raise SystemExit('unsafe candidate archive link')
        elif not (member.isdir() or member.isfile()) or member.mode & 0o6000:
            raise SystemExit('unsupported candidate archive entry')
    manifest_file = tar.extractfile('candidate-manifest.json')
    if manifest_file is None:
        raise SystemExit('candidate manifest is missing')
    manifest = json.load(manifest_file)
    if manifest.get('target') != 'agent-runner-api-mcp-test':
        raise SystemExit('candidate target is not the isolated Runner API test service')
    source_sha = manifest.get('sourceSha', '')
    if not isinstance(source_sha, str) or len(source_sha) != 40 or any(c not in '0123456789abcdef' for c in source_sha):
        raise SystemExit('candidate source SHA is malformed')
PY

SOURCE_SHA="$(python3 - "$ARTIFACT" <<'PY'
import json, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as tar:
    print(json.load(tar.extractfile('candidate-manifest.json'))['sourceSha'])
PY
)"
BUNDLE_SHA="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
REMOTE_BUNDLE="/tmp/runner-api-sandbox-candidate-$SOURCE_SHA.tar.gz"
REMOTE_INSTALLER="/tmp/install-api-sandbox-candidate-$SOURCE_SHA.sh"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

tar -xOf "$ARTIFACT" scripts/install-api-sandbox-candidate.sh > "$TEMP_DIR/install-api-sandbox-candidate.sh" || die 'installer is missing from the verified bundle'
scp -o BatchMode=yes "$ARTIFACT" "$SSH_TARGET:$REMOTE_BUNDLE"
scp -o BatchMode=yes "$TEMP_DIR/install-api-sandbox-candidate.sh" "$SSH_TARGET:$REMOTE_INSTALLER"
ssh -o BatchMode=yes "$SSH_TARGET" "sudo bash '$REMOTE_INSTALLER' '$SOURCE_SHA' '$BUNDLE_SHA' '$REMOTE_BUNDLE'"
ssh -o BatchMode=yes "$SSH_TARGET" "sudo rm -f '$REMOTE_INSTALLER' '$REMOTE_BUNDLE'"

printf '[runner-api-sandbox] verified and deployed candidate %s to isolated test API\n' "$SOURCE_SHA"
