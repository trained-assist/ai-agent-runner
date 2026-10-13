#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run with sudo: update-opencode-binary.sh <release-tag> <version> <sha256>" >&2
  exit 1
fi

tag="${1:-}"
version="${2:-}"
sha="${3:-}"
[[ "$tag" =~ ^mem-preview-[A-Za-z0-9.-]+$ ]] || { echo "Expected immutable mem-preview release tag" >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Expected stable semantic version" >&2; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "Expected 64-character SHA-256" >&2; exit 1; }

repo=gpt-mem/opencode-mem
service=ai-agent-vm-worker
config="${VM_WORKER_CONFIG_FILE:-/etc/ai-agent-runner/worker.env}"
public="$(sed -n 's/^VM_WORKER_PUBLIC_URL=//p' "$config" | tail -n 1 | tr -d '"')"
[[ "$public" =~ ^https?://[^/]+/?$ ]] || { echo "Invalid VM_WORKER_PUBLIC_URL" >&2; exit 1; }
public="${public%/}"
[[ "$(grep -c '^OPENCODE_BIN=' "$config")" == 1 ]] || { echo "Expected one OPENCODE_BIN setting" >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo "Linux x86_64 only" >&2; exit 1; }

dir="/opt/opencode/releases/$tag"
binary="$dir/opencode"
tmp="$(mktemp -d)"
changed=false
backup=
edited=
cleanup() { [[ -z "$edited" ]] || rm -f "$edited"; rm -rf "$tmp"; }
rollback() {
  local rc=$?
  trap - ERR
  if [[ "$changed" == true ]]; then
    cp -p "$backup" "$config"
    systemctl restart "$service" || true
    echo "Update failed; previous OpenCode path restored" >&2
  fi
  cleanup
  exit "$rc"
}
trap cleanup EXIT

before_ready="$(curl --retry 3 --retry-all-errors -fsS --max-time 5 "$public/readyz")"
jq -e '.ready == true and .checks.engine == true' <<<"$before_ready" >/dev/null || {
  echo "Refusing to update a worker that is not ready" >&2; exit 1;
}
curl --retry 3 --retry-all-errors -fsS --max-time 5 "$public/healthz" -o /dev/null
[[ "$(jq -r '.checks.capacity.activeReservations' <<<"$before_ready")" == 0 ]] || {
  echo "Refusing to restart a worker with active reservations" >&2; exit 1;
}
before_version="$(curl --retry 3 --retry-all-errors -fsS --max-time 5 "$public/version")"
worker_version="$(jq -er '.build.version' <<<"$before_version")"
worker_source="$(jq -er '.build.sourceCommit' <<<"$before_version")"

mkdir -p "$tmp/download"
if [[ -x "$binary" ]]; then
  [[ "$(sha256sum "$binary" | cut -d' ' -f1)" == "$sha" ]] || {
    echo "Versioned binary exists with a different hash; refusing overwrite" >&2; exit 1;
  }
else
  curl --retry 3 --retry-all-errors -fLsS "https://github.com/$repo/releases/download/$tag/opencode-linux-x64" -o "$tmp/download/opencode-linux-x64"
  curl --retry 3 --retry-all-errors -fLsS "https://github.com/$repo/releases/download/$tag/SHA256SUMS" -o "$tmp/download/SHA256SUMS"
  (cd "$tmp/download" && grep "^$sha  opencode-linux-x64$" SHA256SUMS | sha256sum --check -)
  chmod 0755 "$tmp/download/opencode-linux-x64"
  [[ "$("$tmp/download/opencode-linux-x64" --version)" == "$version" ]] || {
    echo "Downloaded binary version mismatch" >&2; exit 1;
  }
  install -d -m 0755 "$dir"
  install -m 0755 "$tmp/download/opencode-linux-x64" "$binary"
fi
[[ "$("$binary" --version)" == "$version" && "$(sha256sum "$binary" | cut -d' ' -f1)" == "$sha" ]] || {
  echo "Installed binary version or hash mismatch" >&2; exit 1;
}

current="$(sed -n 's/^OPENCODE_BIN=//p' "$config" | tail -n 1 | tr -d '"')"
if [[ "$current" != "$binary" ]]; then
  backup="$config.before-opencode-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$config" "$backup"
  chmod 0600 "$backup"
  edited="$(mktemp "${config}.XXXXXX")"
  awk -v bin="$binary" 'BEGIN { n=0 } /^OPENCODE_BIN=/ { print "OPENCODE_BIN=" bin; n++; next } { print } END { if (n != 1) exit 1 }' "$config" > "$edited"
  chmod --reference="$config" "$edited"
  chown --reference="$config" "$edited"
  changed=true
  trap rollback ERR
  mv "$edited" "$config"
  systemctl restart "$service"
fi

healthy=false
for _ in $(seq 1 40); do
  if systemctl is-active --quiet "$service" \
    && curl -fsS --max-time 3 "$public/healthz" -o /dev/null \
    && curl -fsS --max-time 3 "$public/readyz" -o "$tmp/readyz.json" \
    && jq -e '.ready == true and .checks.engine == true' "$tmp/readyz.json" >/dev/null \
    && curl -fsS --max-time 3 "$public/version" -o "$tmp/version.json" \
    && jq -e --arg source "$worker_source" --arg version "$worker_version" \
      '.build.sourceCommit == $source and .build.version == $version' "$tmp/version.json" >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
[[ "$healthy" == true ]] || rollback
trap - ERR
printf 'OpenCode updated: version=%s release=%s sha256=%s\n' "$version" "$tag" "$sha"
printf 'worker=%s sourceCommit=%s ready=true activeReservations=%s\n' "$worker_version" "$worker_source" \
  "$(jq -r '.checks.capacity.activeReservations' "$tmp/readyz.json")"
[[ -z "$backup" ]] || printf 'previous-config=%s\n' "$backup"
