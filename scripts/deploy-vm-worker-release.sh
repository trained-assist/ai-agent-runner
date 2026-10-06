#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run with sudo: ai-agent-vm-worker-update vm-worker-vX.Y.Z" >&2
  exit 1
fi
release_tag="${1:-}"
if [[ ! "${release_tag}" =~ ^vm-worker-v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Expected immutable release tag vm-worker-vX.Y.Z" >&2
  exit 1
fi
repo="trained-assist/ai-agent-runner"
workflow="trained-assist/ai-agent-runner/.github/workflows/vm-worker-release.yml"
root="${VM_WORKER_INSTALL_ROOT:-/opt/ai-agent-vm-worker}"
config_file="${VM_WORKER_CONFIG_FILE:-/etc/ai-agent-runner/worker.env}"
updater_path="${VM_WORKER_UPDATER_PATH:-/usr/local/sbin/ai-agent-vm-worker-update}"
archive="ai-agent-vm-worker-linux-x64.tar.gz"
tmp="$(mktemp -d)"
cleanup() { rm -rf "${tmp}"; }
trap cleanup EXIT

command -v gh >/dev/null || { echo "GitHub CLI is required to verify release provenance" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required for post-update health checks" >&2; exit 1; }
gh release download "${release_tag}" --repo "${repo}" --pattern "${archive}" --pattern "${archive}.sha256" --dir "${tmp}"
(
  cd "${tmp}"
  sha256sum --check "${archive}.sha256"
)
gh attestation verify "${tmp}/${archive}" \
  --repo "${repo}" \
  --signer-workflow "${workflow}" \
  --source-ref "refs/tags/${release_tag}" >/dev/null

mkdir -p "${root}/releases"
mkdir "${tmp}/unpack"
tar -xzf "${tmp}/${archive}" -C "${tmp}/unpack"
metadata="${tmp}/unpack/dist/vm-worker/build-info.json"
if [[ ! -f "${metadata}" ]]; then echo "Signed bundle is missing build metadata" >&2; exit 1; fi
source_commit="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sourceCommit)' "${metadata}")"
version="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "${metadata}")"
if [[ ! "${source_commit}" =~ ^[0-9a-f]{40}$ || "${release_tag}" != "vm-worker-v${version}" ]]; then
  echo "Signed release tag, version, or source commit metadata is invalid" >&2
  exit 1
fi
release_dir="${root}/releases/${source_commit}"
if [[ ! -d "${release_dir}" ]]; then
  mv "${tmp}/unpack" "${release_dir}"
  chown -R root:root "${release_dir}"
  chmod -R go-w "${release_dir}"
fi
install -o root -g root -m 0755 "${release_dir}/scripts/deploy-vm-worker-release.sh" "${updater_path}"
old_target="$(readlink -f "${root}/current" 2>/dev/null || true)"
public_url="$(sed -n 's/^VM_WORKER_PUBLIC_URL=//p' "${config_file}" | tail -n 1 | sed 's/^"//;s/"$//')"
if [[ ! "${public_url}" =~ ^https?://[^/]+/?$ ]]; then
  echo "VM_WORKER_PUBLIC_URL must be an http(s) origin in /etc/ai-agent-runner/worker.env" >&2
  exit 1
fi

rollback() {
  echo "Updated worker failed restart or readiness verification; rolling back" >&2
  if [[ -n "${old_target}" && -d "${old_target}" ]]; then
    ln -s "${old_target}" "${root}/.current.rollback.$$"
    mv -Tf "${root}/.current.rollback.$$" "${root}/current"
    systemctl restart ai-agent-vm-worker || true
  else
    systemctl stop ai-agent-vm-worker || true
    rm -f "${root}/current"
  fi
}

ln -s "${release_dir}" "${root}/.current.$$"
mv -Tf "${root}/.current.$$" "${root}/current"
if ! systemctl restart ai-agent-vm-worker; then
  rollback
  exit 1
fi

healthy=false
for _ in $(seq 1 30); do
  if systemctl is-active --quiet ai-agent-vm-worker \
    && curl --silent --show-error --fail --max-time 3 "${public_url%/}/healthz" -o /dev/null \
    && curl --silent --show-error --fail --max-time 3 "${public_url%/}/version" -o "${tmp}/version.json" \
    && node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(v.build?.sourceCommit!==process.argv[2]) process.exit(1)' "${tmp}/version.json" "${source_commit}" \
    && curl --silent --show-error --fail --max-time 3 "${public_url%/}/readyz" -o /dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ "${healthy}" != true ]]; then
  rollback
  exit 1
fi
printf 'VM worker updated: version=%s sourceCommit=%s\n' "${version}" "${source_commit}"
