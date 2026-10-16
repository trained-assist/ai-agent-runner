# Cloudflare Runner API

## Current rollout checkpoint (verified 2026-10-15)

The isolated sandbox Worker at `trained-assist-runner-api-sandbox3.skillset-apply.workers.dev/version`
still reports source `b7c9c7664cadafdad59cdfe40c3b2f9428aaf3be`. The sandbox France VM
`eu-vm2-sandbox` reports worker `0.3.8`, source
`de051f5f2ed63e00d3dcd2db8a54c2965c9f01b1`; its `/readyz` reports ready. Runner API PR
[#321](https://github.com/trained-assist/ai-agent-runner/pull/321) adds process-confirmed
status, heartbeat freshness, and bounded live output snapshots, and is merged on main at
`25244b3`. Its compatible signed VM bundle is published as
[`vm-worker-v0.3.12`](https://github.com/trained-assist/ai-agent-runner/releases/tag/vm-worker-v0.3.12)
from source `cc2396c878c2069891901880033d865e639c32d7`; checksum and GitHub provenance
attestation were verified. The VM bundle is not installed yet, so the sandbox Worker must
remain on its current compatible version until an operator updates the VM to `0.3.12`.
Then deploy the exact reviewed main SHA and run the real sandbox canary before changing
production. Track this rollout and the remaining lifecycle inventory work in
[#320](https://github.com/trained-assist/ai-agent-runner/issues/320). Production was not
changed.

Status (verified 2026-10-10): the isolated `trained-assist-runner-api-sandbox3` Cloudflare
Worker is serverless and dispatches real jobs to the France VM2 execution worker. The VM runs
signed release `vm-worker-v0.3.5` (`dcca4e4b225ad2489748946b5afec6106b337b9d`) at
`https://eu-vm-worker.169-58-15-230.sslip.io`. Its readiness check passes. The sandbox Worker
has `VM_WORKER_URL`, `VM_WORKER_TOKEN`, `LLM_LADDER_TOKEN`, and the additive
`RUNNER_API_KEYS_ADDITIONAL` secret configured alongside its existing secrets; the canary
principal is limited to `trained-assist/ai-agent-runner` and `eu-vm-agent-run`. A live
read-only OpenCode task completed end to end through Cloudflare, VM2, the model ladder, and
the callback path. The expanded canary also verified anonymous rejection (`401`), identical
idempotent replay returning the original receipt, conflicting payload rejection (`409`), and
terminal `succeeded` ([workflow run 38012362767](https://github.com/trained-assist/ai-agent-runner/actions/runs/38012362767)).
Three further independent `ladder/free` OpenCode canaries completed successfully and returned
the expected `package.json` version: [38081266996](https://github.com/trained-assist/ai-agent-runner/actions/runs/38081266996),
[38081438672](https://github.com/trained-assist/ai-agent-runner/actions/runs/38081438672), and
[38081511542](https://github.com/trained-assist/ai-agent-runner/actions/runs/38081511542). Their
durations were 1m49s, 35s, and 43s. A preceding canary had reached terminal `failed` with
`exitCode: null` ([38010575593](https://github.com/trained-assist/ai-agent-runner/actions/runs/38010575593));
the available result did not identify whether Ladder, OpenCode, or the VM caused it. A separate
earlier `401` was an API-key provisioning failure, not a model-provider failure. The missing
upstream diagnostic is tracked in [trained-assist-llm-ladder#231](https://github.com/trained-assist/trained-assist-llm-ladder/issues/231).
These runs verify the direct Runner API → France VM → OpenCode/Ladder → stored result path, not
the complete Control Plane/Telegram user workflow or production readiness.
The canonical Telegram UX Runner Worker now includes a profile-gated cleanup route for E2E
state. The fixture-tool answer path is proven through the sandbox; Telegram delivery and
production readiness remain separate acceptance items.

The canonical CP→Cloudflare Runner API→France VM fixture-tool scenario passed on 2026-10-10.
The live CP task `ut-062b55a7eca0b5f6e5c8` produced successful Runner run
`run_9c5b0757e542980296c9a96356ca03980e155c3f750036797d71f15f815f331e_bdfbcecdd6954266959ccf4d`
and persisted the Registry fixture response `registry-fixture-marker-160-v1`; CP `/trace`
reported task `done` and run `success`. VM release `0.3.6` (source `0f4284f`, release run
[38083959225](https://github.com/trained-assist/ai-agent-runner/actions/runs/38083959225)) now
accepts only the pinned profile/server and passes scoped bearer/proof through memory-only
runtime variables. Runner API merge `00df4a6` fixes the wire shape so `mcp` and `mcpSecrets`
are siblings; sandbox API deployment [38084618775](https://github.com/trained-assist/ai-agent-runner/actions/runs/38084618775)
installed it. Caller-selected MCP endpoints remain rejected.

This proves the test fixture call and answer persistence through CP, Cloudflare Runner API,
France VM2, OpenCode/Ladder and the isolated MCP Host. It does not prove a Telegram message was
sent to a real chat or production readiness. The separate Telegram delivery scenario remains
unverified.

## Runtime boundary

The Control Plane sends authenticated HTTPS requests to its configured Cloudflare Runner API
Worker URL (`RUNNER_API_URL` in the current CP sandbox). That CP config has no execution-VM or
launcher endpoint. The Runner API is a Cloudflare Worker. A task-keyed Durable Object owns
idempotency records, run state, events, and alarms that reconcile dispatch and poll the VM
worker. The France VM runs the OpenCode execution worker; it does not host the Runner API.
The intended boundary is that only Runner knows `VM_WORKER_URL` and `VM_WORKER_TOKEN`. The
current production bootstrap has a documented legacy exception: the France token is also held
in the CP production secret store and passed through the existing bootstrap path. This violates
the target ownership boundary. Do not extend that handoff; move provisioning to Runner-owned
production secrets and remove the CP copy only after Runner readiness and CP authentication are
verified. See architecture [#208](https://github.com/trained-assist/trained-agent-architecture/issues/208).

`eu-vm-agent-run` remains the default and primary execution route. Production, sandbox3 and
the Telegram UX sandbox each configure a GHA/Azure gateway as a secondary route. Capacity
cutover is enabled independently per Worker only when its Runner-owned `GHA_WORKER_TOKEN` is
provisioned. Each environment has a distinct named gateway credential, so sandbox tokens can
be rotated or revoked without touching production or other clients. The provisioning command
installs each generated value in that environment's gateway, Runner API and GitHub Actions
environment, then checks authenticated gateway access without creating a run. Capabilities
continues to list France in `executionRegions` and reports `azure-cloud` separately in
`fallbackExecutionRegions` only when both URL and credential are present. `POST /v1/runs`
accepts optional `routeMode`: `auto` (default; France, then GHA only after a confirmed
pre-admission capacity refusal), `france` (France only), or `gha` (GHA/Azure only). For
`routeMode: "gha"`, `engine.name` must be `azure-cloud`; the authenticated principal must also
allow that engine. Capabilities includes per-route availability under `routes`. In auto mode,
the cutover occurs only after France returns the typed pre-admission refusal
`503 { accepted: false, code: "WORKER_CAPACITY" }`; the same run and operation identity is then
persisted against `azure-cloud` before dispatch. Other refusals do not trigger this cutover. An
accepted or ambiguous France launch is reconciled on France and never started again on GHA.
The production fallback remains disabled until its separately reviewed secret provisioning and
deployment are completed. The isolated `cp-sandbox3` mock-only Worker remains independent and
never advertises or invokes either real worker. The sandbox-only `mock-test` engine returns
fixed `pong` without calling a worker or model.

The three real Worker targets are `sandbox3` (GHA sandbox gateway), `telegram-ux-v1` (GHA
sandbox gateway), and `production` (GHA production gateway). Provision each with a distinct
client ID: `sandbox3_agent_api` / `wrangler.sandbox3.jsonc` / GitHub environment `sandbox`,
`telegram_ux_v1_agent_api` / `wrangler.telegram-ux-v1.jsonc` / `sandbox`, and
`production_agent_api` / `wrangler.production.jsonc` / `production`. The gateway environment is
`sandbox` for the first two and `production` for the base production gateway. `cp-sandbox3` is
deliberately excluded because it is an isolated mock contract test.

## Configuration

### Isolated production target

`wrangler.production.jsonc` defines the dedicated `trained-assist-runner-api-production`
Worker and its own `RunnerRunCoordinator` Durable Object namespace. Its default engine is
France (`eu-vm-agent-run`), mock execution is disabled, and real admission allows the canonical
`trained-assist/ai-agent-runner` repository plus `LLM_LADDER_TOKEN`. CP production pilot and
router gates are enabled for all profiles. Real execution also requires a production API-key
registry, matching CP key/delegation bindings, and ready France worker credentials. A Worker
health response alone does not verify those bindings.

The manual `Deploy isolated production Cloudflare Runner API` workflow runs only from
`main`. The GitHub `production` environment is restricted to `main`. The workflow requires a
successful `sandbox3-live-profile-auth` workflow run for the exact same source SHA, a production
GitHub environment secret named `CF_API_TOKEN`, and an environment variable `CF_ACCOUNT_ID`
identifying the intended Cloudflare account. Before deploying, it checks the exact staging SHA,
secret presence, Cloudflare account, and France `/readyz`. After deployment,
`tools/deploy-cloudflare-production.mjs` derives a one-principal
production registry from the environment-held API key, writes only the declared Runner secrets,
and verifies exact Worker SHA, authenticated capabilities, and delegated-profile authentication
without creating a run. Required production environment secrets are `CF_API_TOKEN`,
`EU_VM_WORKER_TOKEN`, `RUNNER_API_KEY_AGENT_API`, `RUNNER_PROFILE_DELEGATION_SECRET`, and
`RUN_LAUNCH_ENCRYPTION_KEY`; `EU_VM_WORKER_URL` and `LLM_LADDER_TOKEN` come from the Runner
repository secret store. CP keeps its paired API key and delegation secret. The France token
currently duplicated in CP is the legacy exception described above.

The workflow does not route CP traffic or create a CP profile. The first deployment creates a
separate production Durable Object namespace; subsequent code deploys must keep the Worker
name, DO class, namespace, and encryption key stable. Preserve the exact encryption key
together with ciphertext during backup/recovery; restoring either side alone cannot recover
launch bodies. Production cleanup remains disabled.

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
- `RUNNER_API_KEYS_PRODUCTION`: isolated registry used only by the dedicated production
  Worker. It does not overwrite or load the base, additive, or sandbox3 registries.
- `RUNNER_API_KEYS_ADDITIONAL`: independently provisioned additive principals. The sandbox3
  VM2 canary uses this binding; do not replace it when provisioning another sandbox identity.
- `RUNNER_API_KEYS_SANDBOX3`: dedicated additional registry for the live CP profile on the
  `trained-assist-runner-api-sandbox3` Worker. It is separate from both the base registry and
  the canary registry and contains only the sandbox3 CP principal, with its own API-key hash,
  tenant, repository, scopes, and `eu-vm-agent-run` engine grant.
- `AGENT_API_PROFILE_DELEGATION_SECRET`: HMAC secret used only when the trusted Control Plane
  sends the complete `x-agent-profile-*` capability header set. The Worker checks the signature,
  configured API-key tenant, profile ID and short expiry before changing the effective profile.
  Keep the same secret in the paired CP and Runner secret stores; never place it in `vars`, source,
  or request bodies. Without this secret, ordinary API-key profile requests continue to work and
  any partial or delegated capability is rejected.
- `VM_WORKER_URL`: HTTPS address of the France execution worker route.
- `VM_WORKER_TOKEN`: the France worker's current Bearer credential.
- `GHA_WORKER_URL`: non-secret HTTPS address of the GHA/Azure gateway; configured as a Worker var
  for production, sandbox3 and Telegram UX sandbox.
- `GHA_WORKER_TOKEN`: this Runner environment's GHA gateway client Bearer credential, stored as a Runner
  Worker secret. It is distinct from the gateway primary credential and never goes to CP,
  France, or task input. If absent, the API remains France-only.
- `RUN_LAUNCH_ENCRYPTION_KEY`: stable random value of at least 32 characters. The Durable
  Object stores encrypted launch bodies; keep this key stable while any run is active.
- `MCP_TEST_AUTH_TOKEN`: test-only Bearer shared with `trained-assist-mcp-host-test-160`.
- `MCP_TEST_RUNNER_PRIVATE_JWK`: Ed25519 private JWK used to sign a run-bound proof. This
  secret belongs only in the Runner Worker; the matching public JWK belongs in the Host Worker.
- `MCP_TEST_CATALOGUE_VERSION` and `MCP_TEST_EXPIRES_AT`: pinned catalogue version and
  bounded test lease matching the Host Worker.
- `LLM_LADDER_TOKEN`: only if the lane's `envAllowlist` permits it.

The manual `Deploy and pair isolated sandbox3 live profile auth` workflow runs only from
protected `main` after an explicit confirmation input. It deploys the reviewed Worker source,
updates only `RUNNER_API_KEYS_SANDBOX3` and `AGENT_API_PROFILE_DELEGATION_SECRET`, then sends
a signed read-only `GET /v1/capabilities` probe. It does not submit a task or call the VM/model.
The GitHub `sandbox` environment must provide `SANDBOX3_RUNNER_API_KEY` and
`SANDBOX3_PROFILE_DELEGATION_SECRET`; the CP sandbox must use the same pair. Existing base,
canary, mock-only, and Telegram UX registries remain separate.

The Telegram UX test principal is bound in the API key registry to the canonical task repository
`trained-assist/ai-agent-runner`; the request cannot supply or override that binding. The Runner
API does not know or read the private GHA environment/config repository. Only the GHA worker may
check out that separate non-secret configuration repository; it is never a task workspace,
artifact destination, or France-worker dependency. This test principal is limited to profile/principal
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
`RUNNER_API_KEYS_ADDITIONAL`, by the manual canary workflow. The Telegram UX Runner API is a
separate Worker with its own task-keyed Durable Object namespace.

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

`SANDBOX_CLEANUP_PROFILES` enables `POST /v1/sandbox/cleanup-task` for explicitly listed test
profiles. It requires `runs:write`, the signed effective profile to be listed in that variable,
and a safe `userTaskId`; the API derives the same task-keyed Durable Object used by run
submission. The Durable Object atomically refuses active, unknown, foreign, or mismatched state.
For terminal runs it deletes the task's complete stored record (runs, idempotency keys, events,
results, and owner generations) and clears its alarm. An already-empty task key is removed as
well. The canonical Telegram UX Worker enables its dedicated profile, and `wrangler.sandbox3.jsonc`
enables only `sandbox3-vm2-live-canary`; the canary script cleans up only after terminal proof.
Production and the mock-only Runner Worker leave cleanup disabled. The CP E2E cleanup script
calls this route before deleting corresponding CP rows.

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
When mapping a France result, it preserves the worker's explicit `exitObserved` fact separately
from exit code/signal; older worker results remain compatible through the legacy inference.
Durable Objects are sharded by principal, profile, and task hash.

### Live lifecycle and OpenCode output stream

`GET /v1/runs/{runId}/events` keeps its JSON page contract and also accepts
`Accept: text/event-stream`. An SSE request without a cursor starts with a `snapshot` event;
reconnect with `Last-Event-ID` (or `?cursor=`) to replay later events. Event IDs are the
per-run sequence. Delivery can repeat an event, so clients deduplicate by ID. When a cursor
falls outside the retained journal, the API emits `reset` with the current status snapshot and
its new sequence instead of claiming complete replay. JSON pages return `hasMore` and
`resetRequired` accurately. Capabilities declare JSON/SSE, the 128-event replay window and
15-second idle heartbeat.

The stream reports durable queue/dispatch/state transitions, OpenCode startup phases, changed
worker progress timestamps, redacted stdout/stderr chunks, finalizing, and terminal result.
Heartbeat and real output remain separate signals; no percentage is inferred. The Coordinator
polls worker status/log cursors every second while at least one SSE subscriber is connected,
otherwise every five seconds. It stores bounded per-run output events before waking listeners;
slow consumers have a one-frame stream buffer and can reconnect from their last sequence.
Closing a stream only removes that listener and never cancels the run. The existing JSON
polling path and Node API SSE behavior are unchanged.

### Cancel when the submit receipt is missing

`POST /v1/runs/cancel-by-idempotency-key` accepts `{ userTaskId, idempotencyKey, ownerGeneration }`
under `runs:write`. It routes to the same task Durable Object as submit. If admission already
exists, it validates the exact task and generation, requests cancellation, and returns the exact
`runId` with `stop_pending` (or terminal state). If admission does not yet exist, it writes a
principal-scoped cancellation fence atomically with the lookup and returns
`cancelled_before_admission`; any later submit with that key and generation is rejected before
dispatch. Repeated matching cancellation is idempotent, while task/generation mismatches fail
closed. Sandbox cleanup retains these fences so it cannot reopen a delayed-submit race.

## Current acceptance gaps

The sandbox3 Worker supports only the pinned test Registry MCP descriptor for the exact
Telegram UX principal/profile with its exact API-key `mcpBindings` grant. It creates the EdDSA
proof after allocating `runId`, bounds it by `MCP_TEST_EXPIRES_AT`, and keeps the Host Bearer
inside the encrypted launch and `mcpSecrets`. Other MCP descriptors fail closed.

Profile workspace provisioning/saveback, generic input refs, binary artifact download,
GCS log publication, the complete `/v1/capabilities` document, and multi-engine fallback
remain unsupported. Task-scoped `ingressManifest` pins are accepted only in the exact
`cp-input-manifest:<userTaskId>` form with a lowercase SHA-256 version, then enriched with the
admitted profile/run/generation and forwarded to the France VM launch request. The VM must have
the complete trusted `RUNNER_CONTROL_PLANE_*` resolver configuration to fetch and materialize
the manifest; without it, the run fails closed before OpenCode starts. `/readyz` does not
currently report this optional capability, so a healthy response alone does not prove that
file-intake runs are ready. The live sandbox file scenario remains the proof gate for this path.

A live Host fixture call through CP, this Worker, France VM2, OpenCode and Ladder has succeeded
and persisted the expected answer. That run did not send a Telegram message and does not establish
production readiness. Local Worker tests and mock probes do not prove real Agent execution,
repository persistence, or Telegram delivery.

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
