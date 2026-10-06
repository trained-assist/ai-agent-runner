#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Usage: sudo scripts/install-vm-worker.sh <vm-worker-tag> <france|russia>" >&2
  exit 1
fi

release_tag="${1:-}"
region="${2:-}"
if [[ ! "${release_tag}" =~ ^vm-worker-v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Provide an immutable release tag, for example vm-worker-v0.1.0" >&2
  exit 1
fi
if [[ "${region}" != "france" && "${region}" != "russia" ]]; then
  echo "Region must be france or russia" >&2
  exit 1
fi
script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_dir="$(cd "${script_dir}/.." && pwd)"
unit_source="${repo_dir}/deploy/vm-worker/ai-agent-vm-worker.service"
env_source="${repo_dir}/deploy/vm-worker/worker.env.${region}.example"
inventory_source="${repo_dir}/deploy/vm-worker/inventory/${region}.json"
if [[ ! -f "${unit_source}" || ! -f "${env_source}" || ! -f "${inventory_source}" ]]; then
  echo "Missing VM worker service, env template, or binding inventory" >&2
  exit 1
fi
command -v gh >/dev/null || { echo "Install GitHub CLI (gh) before verifying signed releases" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }

if ! id ai-agent >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/ai-agent-runner --create-home --shell /usr/sbin/nologin ai-agent
fi
install -d -o ai-agent -g ai-agent -m 0700 /var/lib/ai-agent-runner
install -d -o ai-agent -g ai-agent -m 0700 /var/lib/ai-agent-runner/capacity
install -d -o root -g root -m 0755 /etc/ai-agent-runner /opt/ai-agent-vm-worker/releases
install -o root -g root -m 0644 "${unit_source}" /etc/systemd/system/ai-agent-vm-worker.service
install -o root -g root -m 0755 "${script_dir}/deploy-vm-worker-release.sh" /usr/local/sbin/ai-agent-vm-worker-update
if [[ ! -e /etc/ai-agent-runner/worker.env ]]; then
  install -o root -g root -m 0600 "${env_source}" /etc/ai-agent-runner/worker.env
fi
if [[ ! -e /etc/ai-agent-runner/worker-bindings.json ]]; then
  install -o root -g root -m 0644 "${inventory_source}" /etc/ai-agent-runner/worker-bindings.json
fi
systemctl daemon-reload

if grep -Eq 'REPLACE_WITH|example\.com' /etc/ai-agent-runner/worker.env; then
  echo "Bootstrap installed. Configure /etc/ai-agent-runner/worker.env and worker-bindings.json, then run:"
  echo "  sudo /usr/local/sbin/ai-agent-vm-worker-update ${release_tag}"
  exit 0
fi
/usr/local/sbin/ai-agent-vm-worker-update "${release_tag}"
systemctl enable ai-agent-vm-worker
