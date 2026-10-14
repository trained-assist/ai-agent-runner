# Provisioning isolated GHA gateway credentials

Each real Runner API Worker needs a unique GHA gateway client credential. A generated value
is installed in three places: a named client secret on the correct GHA gateway, that Runner
Worker's `GHA_WORKER_TOKEN`, and a GitHub Actions environment secret for the corresponding
repository environment. The command never prints the value, refuses to overwrite any existing
copy, and verifies gateway authentication without creating a run.

| Runner API Worker | Client ID | Runner config | Gateway URL/environment | GitHub environment |
| --- | --- | --- | --- | --- |
| sandbox3 | `sandbox3_agent_api` | `wrangler.sandbox3.jsonc` | sandbox gateway / `sandbox` | `sandbox` |
| Telegram UX sandbox | `telegram_ux_v1_agent_api` | `wrangler.telegram-ux-v1.jsonc` | sandbox gateway / `sandbox` | `sandbox` |
| production | `production_agent_api` | `wrangler.production.jsonc` | production gateway / `production` | `production` |

The gateway URL and gateway environment are validated as a pair. The `production` gateway
environment means the base production Worker (no Wrangler `--env` flag); `sandbox` uses the
isolated sandbox Worker. The mock-only `cp-sandbox3` Worker is deliberately excluded.

Run a read-only inventory first, then repeat without `--dry-run` only after the exact target
environment and credential stores have been reviewed:

```sh
GHA_GATEWAY_REPO_DIR=/path/to/opencode-gha-runner \
  node scripts/provision-gha-client-credential.mjs --client-id sandbox3_agent_api \
  --gateway-env sandbox --runner-config wrangler.sandbox3.jsonc --github-env sandbox --dry-run

GHA_GATEWAY_REPO_DIR=/path/to/opencode-gha-runner \
  node scripts/provision-gha-client-credential.mjs --client-id telegram_ux_v1_agent_api \
  --gateway-env sandbox --runner-config wrangler.telegram-ux-v1.jsonc --github-env sandbox --dry-run

GHA_GATEWAY_REPO_DIR=/path/to/opencode-gha-runner \
  node scripts/provision-gha-client-credential.mjs --client-id production_agent_api \
  --gateway-env production --runner-config wrangler.production.jsonc --github-env production --dry-run
```

The operator needs Cloudflare credentials for the selected gateway and Runner Workers, plus
GitHub Actions environment-secret write access. If a later write or verification fails, the
command removes the copies created in that invocation and reports any cleanup requiring
attention. Existing credentials must use a separately reviewed rotation procedure.

Do not provision production or deploy the production Runner configuration until the reviewed
source is merged and the production deployment workflow's exact-SHA sandbox gate passes. After
provisioning, confirm `/v1/capabilities` reports `executionRegions: ["eu-vm-agent-run"]` and
`fallbackExecutionRegions: ["azure-cloud"]`. That indicates both routes are configured; a
live controlled capacity-refusal canary is still required to prove fallback execution.
