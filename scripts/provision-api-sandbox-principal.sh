#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOST='vmi3617957'
SERVICE='agent-runner-api-mcp-test.service'
ENV_FILE='/etc/agent-runner/agent-runner-api-mcp-test.env'
UNIT_FILE='/etc/systemd/system/agent-runner-api-mcp-test.service'
REGISTRY='/etc/agent-runner/key-registry-mcp-test.json'
CLI='/opt/sb/ai-agent-runner-api-mcp-test/current/dist/ops/sandbox-principal-provisioner-cli.js'

[[ $EUID -eq 0 ]] || { printf '[sandbox-principal] root_required\n' >&2; exit 1; }
[[ "$(hostname -s)" == "$EXPECTED_HOST" ]] || { printf '[sandbox-principal] target_host_mismatch\n' >&2; exit 1; }
[[ "$(systemctl show "$SERVICE" -p FragmentPath --value)" == "$UNIT_FILE" ]] || { printf '[sandbox-principal] target_service_mismatch\n' >&2; exit 1; }
systemctl show "$SERVICE" -p EnvironmentFiles --value | grep -Fq "$ENV_FILE" || { printf '[sandbox-principal] target_environment_mismatch\n' >&2; exit 1; }
[[ -f "$REGISTRY" && ! -L "$REGISTRY" ]] || { printf '[sandbox-principal] target_registry_missing\n' >&2; exit 1; }
[[ -f "$CLI" ]] || { printf '[sandbox-principal] provisioner_unavailable\n' >&2; exit 1; }
grep -Fxq 'AGENT_API_ENVIRONMENT=sandbox' "$ENV_FILE" || { printf '[sandbox-principal] sandbox_mode_not_enabled\n' >&2; exit 1; }
grep -Fxq 'AGENT_API_ENABLE_MOCK_TEST=true' "$ENV_FILE" || { printf '[sandbox-principal] mock_test_not_enabled\n' >&2; exit 1; }

exec /usr/local/bin/node "$CLI"
