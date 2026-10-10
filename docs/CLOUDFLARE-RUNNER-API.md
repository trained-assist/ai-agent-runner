# Cloudflare Runner API

Status (verified 2026-10-10): the isolated `trained-assist-runner-api-sandbox3` Cloudflare
Worker is serverless and dispatches real jobs to the France VM2 execution worker. The VM runs
signed release `vm-worker-v0.3.5` (`dcca4e4b225ad2489748946b5afec6106b337b9d`) at
`https://eu-vm-worker.169-58-15-230.sslip.io`. Its readiness check passes. The sandbox Worker
has `VM_WORKER_URL`, `VM_WORKER_TOKEN`, `LLM_LADDER_TOKEN`, and the additive
`RUNNER_API_KEYS_ADDITIONAL` secret configured alongside its existing secrets; the canary
principal is limited to `trained-assist/ai-agent-runner` and `eu-vm-agent-run`. A live
read-only OpenCode task completed end to end through Cloudflare, VM2, the model ladder, and
the callback path ([workflow run 38011605830](https://github.com/trained-assist/ai-agent-runner/actions/runs/38011605830)).
This proves one real execution canary, not the complete user workflow or production readiness.
The separate Telegram UX Runner Worker has not been deployed, and the outstanding acceptance
gaps below remain.

## Runtime boundary

The Control Plane calls the Runner API through a private Cloudflare service binding. The
Runner API is a Cloudflare Worker. A task-keyed Durable Object owns idempotency records, run
state, events, and alarms that reconcile dispatch and poll the VM worker. The Worker alone knows
`VM_WORKER_URL` and `VM_WORKER_TOKEN`. The France VM runs the OpenCode execution worker; it
does not host the Runner API. The Control Plane has no VM URL or VM credential.

`eu-vm-agent-run` is the default and only engine in these sandbox configurations. A GHA runner
is not a fallback. If France cannot accept the job, the task reports an error or unknown
outcome; the API does not silently move execution elsewhere. The sandbox-only `mock-test`
engine returns fixed `pong` without calling the VM or a model.

## Configuration

Separate Worker configurations and Durable Object namespaces are defined for sandbox3 and
Telegram UX. A dedicated, mock-only Worker is provisioned for the CP sandbox3 admission
contract so it can have an independent key registry and run store:

- `wrangler.sandbox3.jsonc`
- `wrangler.cp-sandbox3.jsonc`
- `wrangler.telegram-ux-v1.jsonc`

The CP sandbox3 Worker is `trained-assist-runner-api-cp-sandbox3`. Its default engine is
`mock-test`, it has no France worker URL/token, and its only principal is provisioned from
the CP sandbox's derived API key with `runs:read`/`runs:write` and `engines: ["mock-test"]`.
It has its own Durable Object namespace. Do not copy the existing sandbox3 or Telegram UX
key registry into it.

Worker secrets:

- `RUNNER_API_KEYS`: JSON list of principals with `keyHash`, `principalId`, `profileId`,
  optional `repository`, `tenantId`, scopes, allowed engines, and optional `mcpBindings`.
  Repository is authoritative and cannot be overridden by requests; a repository is required
  for real execution except for the exact pinned Telegram UX Registry test principal described
  below. The list stores hashes, never raw API keys.
- `AGENT_API_PROFILE_DELEGATION_SECRET`: HMAC secret used only when the trusted Control Plane
  sends the complete `x-agent-profile-*` capability header set. The Worker checks the signature,
  configured API-key tenant, profile ID and short expiry before changing the effective profile.
  Keep the same secret in the paired CP and Runner secret stores; never place it in `vars`, source,
  or request bodies. Without this secret, ordinary API-key profile requests continue to work and
  any partial or delegated capability is rejected.
- `VM_WORKER_URL`: HTTPS address of the France execution worker route.
- `VM_WORKER_TOKEN`: the France worker's current Bearer credential.
- `RUN_LAUNCH_ENCRYPTION_KEY`: stable random value of at least 32 characters. The Durable
  Object stores encrypted launch bodies; keep this key stable while any run is active.
- `MCP_TEST_AUTH_TOKEN`: test-only Bearer shared with `trained-assist-mcp-host-test-160`.
- `MCP_TEST_RUNNER_PRIVATE_JWK`: Ed25519 private JWK used to sign a run-bound proof. This
  secret belongs only in the Runner Worker; the matching public JWK belongs in the Host Worker.
- `MCP_TEST_CATALOGUE_VERSION` and `MCP_TEST_EXPIRES_AT`: pinned catalogue version and
  bounded test lease matching the Host Worker.
- `LLM_LADDER_TOKEN`: only if the lane's `envAllowlist` permits it.

The Telegram UX test principal is bound in the API key registry to the isolated repository
`vovalikessmoothy-png/cp-telegram-ux-runner-sandbox`; the request cannot supply or override
that binding. This exception is limited to profile/principal
`integration-telegram-ux-v1` with exactly one `mcpBindings` entry:
`registry-mcp-test-160-read`. It only admits the pinned server
`trained-assist-registry-test`, URL, tool `registry.fixture_read`, policy, catalogue and
Registry digest in the Worker code. It grants no other repository or MCP access.

The France worker must allow the corresponding `workers.dev` origin in
`VM_WORKER_ALLOWED_CALLBACK_ORIGINS`, and its approved repository/environment lists must
match the Runner configuration. Check `/readyz` on the France worker before a live canary.

The Wrangler configs use `workers_dev` and SQLite Durable Object migrations. Deployment
creates persistent Cloudflare state. Cloudflare Worker secrets are write-only. Provisioning
must preserve the complete trusted `RUNNER_API_KEYS` source registry and update it atomically;
never overwrite the secret from an unverified local copy. The existing `RUNNER_API_KEYS`
value was preserved; the sandbox3 canary principal is provisioned additively through
`RUNNER_API_KEYS_ADDITIONAL`, by the manual canary workflow. The separate Telegram UX Worker
config still names a service binding to a Worker that does not exist yet.

The dedicated Telegram UX Runner Worker is deployed by
`.github/workflows/deploy-cloudflare-telegram-ux-sandbox.yml` from protected `main` using the
`sandbox` GitHub environment. That workflow verifies the France worker readiness and Cloudflare
account, hashes the environment-held API key into the Worker registry, synchronizes the paired
delegation/encryption/France/model secrets, deploys the pinned config, and verifies Worker
placement, exact source SHA, API authentication, and signed profile delegation. Required
environment secrets are `CF_API_TOKEN`, `RUNNER_API_KEY_AGENT_API`,
`AGENT_API_PROFILE_DELEGATION_SECRET`, and `RUN_LAUNCH_ENCRYPTION_KEY`. France worker URL/token
and `LLM_LADDER_TOKEN` are supplied from the existing repository secrets. Keep the API key and
delegation secret paired with the same-named Control Plane sandbox bindings; neither belongs in
Wrangler vars or source.

## Verification

```bash
npm run typecheck
npx vitest run test/cloudflare-runner-api.test.ts test/cloudflare-run-coordinator.test.ts
npm run build
npm run worker:dry-run:sandbox3
npm run worker:dry-run:telegram-ux
```

The Worker handles authenticated submit, status, result, events, artifact metadata, and cancel.
It encrypts launch data at rest, deduplicates idempotency keys, increments `ownerGeneration`
for later attempts, and reconciles lost launch responses using the same France worker run ID.
Durable Objects are sharded by principal, profile, and task hash.

## Current acceptance gaps

The sandbox3 Worker supports only the pinned test Registry MCP descriptor for the exact
Telegram UX principal/profile with its exact API-key `mcpBindings` grant. It creates the EdDSA
proof after allocating `runId`, bounds it by `MCP_TEST_EXPIRES_AT`, and keeps the Host Bearer
inside the encrypted launch and `mcpSecrets`. Other MCP descriptors fail closed.

Profile workspace provisioning/saveback, ingress manifest materialization, input refs, binary
artifact download, GCS log publication, SSE, the complete `/v1/capabilities` document, and
multi-engine fallback remain unsupported. Do not report Telegram UX ready until the API key
registry and France worker dispatch are provisioned, the dedicated Telegram UX Worker is
deployed, and a live Host fixture call succeeds end to end. Local Worker tests and mock probes
do not prove real Agent execution, repository persistence, or Telegram delivery.

The manual `Deploy Telegram UX Cloudflare Runner sandbox` workflow requires the matching
`MCP_TEST_AUTH_TOKEN` and Ed25519 `MCP_TEST_RUNNER_PRIVATE_JWK` in the `sandbox` GitHub
environment. It renews the pinned catalogue lease through the end of the UTC day 30 days
ahead and installs the private key and bearer as Worker secrets; neither is a Wrangler variable.
Health, key, delegation, and France Worker probes retry for up to two minutes while Cloudflare
propagates a new secret version. Deploy the paired Host Worker on the same UTC date so both
Workers enforce the identical lease. The generated API-key entry binds the Telegram UX profile
to its one isolated sandbox repository; keep the CP RunSpec repository omitted so the Runner's
authenticated binding remains authoritative.

## Retired deployment path

`src/api/main.ts` remains the Node-compatible API implementation used by local tests and older
acceptance fixtures. `scripts/deploy-api-service.sh`, `scripts/prepare-api-sandbox3.py`, and
the old VM API systemd unit describe the previous VM-hosted API topology. Do not use them to
deploy the current Runner API. The VM worker installer and `src/vm-worker/` service remain the
execution plane.
