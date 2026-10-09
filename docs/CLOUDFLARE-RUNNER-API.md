# Cloudflare Runner API

Status: the isolated sandbox3 Cloudflare Worker was deployed on 2026-10-09 with
profile-scoped repository binding and an authenticated `mock-test` probe returning `pong`.
It was updated to version `a98c62ed-38d6-4f8d-987d-8b1d36a78de1`, which includes the pinned
Telegram UX Registry MCP attachment path. `/healthz` and `/version` return 200. The current
Cloudflare secret inventory contains only `RUN_LAUNCH_ENCRYPTION_KEY` and `RUNNER_API_KEYS`;
no new principal, France worker URL/token, or MCP test secrets are provisioned. The separate
Telegram UX Runner Worker has not been deployed. No live CP-to-Runner or real France execution
has been accepted.

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

The repository-less exception is limited to principal and profile
`integration-telegram-ux-v1` with exactly one `mcpBindings` entry:
`registry-mcp-test-160-read`. It only admits the pinned server
`trained-assist-registry-test`, URL, tool `registry.fixture_read`, policy, catalogue and
Registry digest in the Worker code. It does not grant arbitrary MCP access or a repository.

The France worker must allow the corresponding `workers.dev` origin in
`VM_WORKER_ALLOWED_CALLBACK_ORIGINS`, and its approved repository/environment lists must
match the Runner configuration. Check `/readyz` on the France worker before a live canary.

The Wrangler configs use `workers_dev` and SQLite Durable Object migrations. Deployment
creates persistent Cloudflare state. Cloudflare Worker secrets are write-only. Provisioning
must preserve the complete trusted `RUNNER_API_KEYS` source registry and update it atomically;
never overwrite the secret from an unverified local copy. The live sandbox3 registry has not
been inspected and no new principal has been provisioned. The separate Telegram UX Worker
config names a service binding to a Worker that does not exist yet.

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

## Retired deployment path

`src/api/main.ts` remains the Node-compatible API implementation used by local tests and older
acceptance fixtures. `scripts/deploy-api-service.sh`, `scripts/prepare-api-sandbox3.py`, and
the old VM API systemd unit describe the previous VM-hosted API topology. Do not use them to
deploy the current Runner API. The VM worker installer and `src/vm-worker/` service remain the
execution plane.
