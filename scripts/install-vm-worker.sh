#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo scripts/install-vm-worker.sh /opt/ai-agent-runner" >&2
  exit 1
fi

repo_dir="${1:-/opt/ai-agent-runner}"
repo_dir="$(cd "${repo_dir}" && pwd)"
if [[ "${repo_dir}" != "/opt/ai-agent-runner" ]]; then
  echo "The systemd unit is pinned to /opt/ai-agent-runner; place the checkout there first" >&2
  exit 1
fi
unit_source="${repo_dir}/deploy/vm-worker/ai-agent-vm-worker.service"
env_example="${repo_dir}/deploy/vm-worker/worker.env.example"
if [[ ! -f "${unit_source}" || ! -f "${env_example}" ]]; then
  echo "Not an ai-agent-runner checkout: expected deploy/vm-worker files in ${repo_dir}" >&2
  exit 1
fi

cd "${repo_dir}"
npm ci
npm run build

if ! id ai-agent >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/ai-agent-runner --create-home --shell /usr/sbin/nologin ai-agent
fi
install -d -o ai-agent -g ai-agent -m 0700 /var/lib/ai-agent-runner
install -d -o root -g root -m 0755 /etc/ai-agent-runner
if [[ ! -e /etc/ai-agent-runner/worker.env ]]; then
  install -o root -g root -m 0600 "${env_example}" /etc/ai-agent-runner/worker.env
fi
install -o root -g root -m 0644 "${unit_source}" /etc/systemd/system/ai-agent-vm-worker.service
systemctl daemon-reload

if grep -Eq 'REPLACE_WITH|example\.com|eu-vm-1' /etc/ai-agent-runner/worker.env; then
  echo "Worker files installed. Edit /etc/ai-agent-runner/worker.env (mode 0600), then run:"
  echo "  sudo systemctl enable --now ai-agent-vm-worker"
  exit 0
fi

systemctl enable --now ai-agent-vm-worker
systemctl --no-pager --full status ai-agent-vm-worker
