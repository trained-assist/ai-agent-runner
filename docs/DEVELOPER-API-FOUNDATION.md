# Developer API foundation and release checklist

The Cloudflare Runner now has an opt-in developer route for a free-form prompt, a server-provisioned OpenAI connection and an optional terminal webhook. It uses the existing task-keyed Durable Object for admission, idempotency, launch reconciliation, status, events, result, artifacts and cancellation. The current Control Plane contract at `/v1/runs` is unchanged. This is a working API path for trusted sandbox principals, not a self-service paid service: the current VM accepts `isolation.mode=none`, and there is no credit ledger or automatic customer onboarding.

## Current request contract

In an isolated sandbox lane, set `RUNNER_DEVELOPER_API_ENABLED=true` and provision a principal with a trusted repository, `runs:read` and `runs:write`, and `developerApi: true`. Existing principals without the flag cannot use these routes. The developer route is disabled when `DEPLOYMENT_ENV=production`, even if the key flag and lane switch are present. The API key remains in the usual hash-only registry. The route creates a stable internal `userTaskId` from the principal, profile and `Idempotency-Key`, then forwards the normalized run to the existing coordinator. A repeated request with the same key and body returns the same receipt; a different body conflicts.

### Local OpenCode sandbox key

`node scripts/setup-developer-sandbox.mjs init` creates a reusable 256-bit sandbox key at `~/.config/opencode/secrets/serverless-agent-api-key` (mode `0600`) without printing it. The local OpenCode MCP config reads that file through `{file:...}`. `init` preserves an existing valid key, so retries do not silently revoke access. The generated principal is fixed to `trained-assist/ai-agent-runner`, `eu-vm-agent-run`, and `runs:read`/`runs:write`; it has `developerApi: true` but no guest or cross-repository access.

Sandbox3 accepts this principal from the separate `RUNNER_API_KEYS_DEVELOPER` secret. The base, additional, and profile registries are left intact; production authentication never reads the developer registry. The `sandbox3-live-profile-auth` workflow deploys the reviewed main SHA, then requires `SANDBOX3_DEVELOPER_API_KEY` from its `sandbox` environment and writes only the SHA-256 key record and `RUNNER_DEVELOPER_API_ENABLED=true` to the sandbox Worker. The local raw key has already been stored as that GitHub environment secret; it must not enter Git, logs, or a PR. The provisioning command checks `/version` against the exact deployed SHA before changing Worker secrets, and probes `GET /v1/developer/capabilities` afterward. `node scripts/setup-developer-sandbox.mjs status` makes the same read-only probe locally and prints only the HTTP status and non-secret capability fields.

Sandbox3 now runs Worker SHA `dfaeda104f9796189c6bbac0f3eca4fc70b4c4ea`, deployed by [workflow run 38740334184](https://github.com/trained-assist/ai-agent-runner/actions/runs/38740334184). The local OpenCode key returns `200` from `GET /v1/developer/capabilities` with `managedAvailable: true`. Signed [VM release `vm-worker-v0.3.17`](https://github.com/trained-assist/ai-agent-runner/releases/tag/vm-worker-v0.3.17) is installed on the France sandbox VM; `/version` reports source `0f052b2a932b400df91590f7e671c8b538823307` and `/readyz` is healthy. A disposable `agent_run_start`/`agent_run_wait` task returned terminal `succeeded` with answer `0.3.17` and `__runner/agent-history.json`. Authenticated artifact download returned `200` and 11,103 bytes; SHA-256 `357247519fc724fa4ae4e533a56823ebd92309bf7a851fcbe1f4d99b2c7ff19f` matches the result manifest. The JSON has schema version 1 and `truncated: false`. The [legacy sandbox3 VM2 canary](https://github.com/trained-assist/ai-agent-runner/actions/runs/38741668475) also passed after the VM update, and the developer key still returns `200` afterward.

```http
GET /v1/developer/capabilities
Authorization: Bearer <runner-api-key>
```

Capabilities show which model modes are configured for this principal and its connection IDs. They also disclose `isolation: none`, the maximum timeout, and that billing and self-service connections are unavailable.

### GitHub token connection through ZeroCreds (sandbox)

The sandbox developer API can create a one-time ZeroCreds form for a GitHub personal access token. This path is separate from model BYOK and from the future trusted MCP methods; no MCP method names or executor allowlist are assumed here. The token is entered in the ZeroCreds page, posted directly to the Runner intake endpoint, checked against `GET /user` on GitHub, then stored as AES-256-GCM ciphertext in a principal-scoped Durable Object. The encryption key is a separate Worker secret. The API returns only a connection ID, GitHub account metadata, and whether that token can read or push to the principal's currently bound repository. It never returns the token. The one-time intake link expires after 15 minutes, rejects a second submission, and revocation deletes the ciphertext.

```http
POST /v1/developer/github/connections
Authorization: Bearer <runner-api-key>
```

The response contains `connectionId`, `status: "pending"`, `formUrl` and `expiresAt`. Open `formUrl` in a browser and enter the token there. Then poll:

```http
GET /v1/developer/github/connections/{connectionId}
Authorization: Bearer <runner-api-key>
```

The response changes to `status: "connected"` with `github.login`, numeric `github.id`, and `github.repositoryAccess` (`push`, `read` or `none`). `DELETE` on the same URL revokes the connection. A different principal/profile/tenant receives 404. Creation requires `runs:write`; status requires `runs:read`.

This increment **binds and verifies** the GitHub token. It does not pass the token into an OpenCode process or accept `githubConnectionId` in a run request yet. The VM currently runs with `isolation.mode=none`, so exposing a customer PAT to its process would cross the trust boundary. A subsequent trusted MCP operation or isolated Git publisher can consume the connection after its scope and audit contract are specified. The existing run contract and repository binding remain unchanged.

For the sandbox lane, bind the new `RUNNER_GITHUB_CONNECTIONS` Durable Object and set `RUNNER_GITHUB_CONNECTION_KEY` to 32 cryptographically random bytes encoded as 64 lowercase hex characters. Set `ZEROCREDS_API_URL` to the exact HTTPS form origin and `ZEROCREDS_INTEGRATOR_TOKEN` as a Worker secret for a dedicated integrator. The Runner creates a ZeroCreds session with an inline `http_post` destination containing the one-time intake capability. ZeroCreds #64 will reject inline destinations by default; before that hardening is deployed, replace this with a reviewed named-destination parameter contract or permit inline destinations only on a dedicated isolated ZeroCreds instance. Do not open a general inline destination switch on a shared production service. The API reports `githubConnectionIntake: false` or 503 if any required binding is missing. Production deployment is disabled by the developer-API gate.

```http
POST /v1/developer/runs
Authorization: Bearer <runner-api-key>
Idempotency-Key: customer-task-001
Content-Type: application/json

{"prompt":"Inspect this repository and explain the failing test","model":{"mode":"managed"},"limits":{"timeoutSeconds":300}}
```

The response is `202` with `runId`, `id`, `statusUrl` and `resultUrl`. Repeat submission returns `200` and the same `runId`. Read `GET /v1/developer/runs/{runId}` for status, `.../result` for terminal result, `.../events` for events, `.../artifacts` for outputs, and `POST .../cancel` to request cancellation. The underlying status and result schema are the established Runner v1 schema; for example result text is in `text`. The usual `unknown` state means execution outcome is uncertain and must be reconciled, not resubmitted automatically.

Status also includes `createdAt`, `startedAt` and `finishedAt` for a client-side elapsed-time display. `startedAt` remains null until the coordinator observes execution; `finishedAt` remains null until a terminal state. Clients should compute elapsed time locally from these server timestamps, stop the timer on a terminal state, and show `unknown` as a separate uncertain state.

Developer runs on a history-capable VM include `agent-history.json` in the terminal result's `artifacts` and `outputRefs`, and in `GET .../artifacts`. Download it through the artifact's URL (or authenticated `.../artifacts?path=__runner%2Fagent-history.json`). It is a versioned JSON document with ordered assistant messages, user-facing questions, stdout/stderr entries, an answer excerpt, timestamps, outcome, and a `truncated` flag. Internal runner diagnostics and private OpenCode checkpoint data are excluded. The VM writes it outside the swept execution workspace and exposes a SHA-256 and byte size. Its content is capped at 8 MiB; `truncated: true` means the timeline was bounded. The separate final answer in `result.text` remains authoritative. Guest history links follow the same 24-hour access TTL as other guest files. An old VM build or a preflight refusal has no history artifact; the ordinary result remains available.

## Accountless trial artifact links

An accountless trial still needs a **server-issued Bearer API key** for admission, status and result; the public cannot start runs without a key. Provision a sandbox developer principal with `developerApi: true`, `developerGuest: true`, a dedicated profile and repository binding, and `runs:read`/`runs:write`. Set `RUNNER_GUEST_DOWNLOAD_SECRET` as a Worker secret of at least 32 characters. Guest admission fails closed if the signing secret is absent. This is operator provisioned, not anonymous self-service. Rate limits, credits and isolated execution are still required before opening it to arbitrary visitors.

For a guest run, the terminal `result` keeps the existing `text` and `outputRefs` fields and additionally provides `artifacts` and `artifactExpiresAt`. Each artifact has its path, name, MIME type, byte size, SHA-256, `downloadUrl` and `expiresAt`. `GET /v1/developer/runs/{runId}/artifacts` returns the same metadata and expiry. The download URL works without an Authorization header, is signed for exactly one run and path, and expires **24 hours after the worker result is collected**. Before expiry the URL proxies the existing verified VM artifact bytes with the filename and checksum headers. After expiry both the signed URL and authenticated guest artifact route return `410 ARTIFACT_EXPIRED`. Legacy principals retain their old result and artifact contract. Files larger than the VM's current 20 MiB response limit return `413`.

The 24-hour TTL is an **access TTL**, not a physical deletion guarantee. The VM export store and any repository publication can outlive it; an object-storage lifecycle/cleanup job and guest publication policy are still needed before claiming ephemeral storage or confidentiality from a public repository. Keep the guest repository private and dedicated in the sandbox. Do not log or publicly share signed URLs: possession grants download access until expiry. Rotating the signing secret revokes all outstanding links. A webhook contains a result URL, not the signed artifact links; the client retrieves them from the authenticated result.

Managed mode requires `LLM_LADDER_TOKEN` and `ALLOWED_ENVIRONMENT_NAMES` to include that name. `RUNNER_DEVELOPER_MANAGED_MODEL` can pin an OpenCode model identifier, for example a tested Ladder model. The intended primary model is Xiaomi MiMo 2.6 Flash; configure its actual supported identifier only after the Ladder/VM model path has been verified. If no identifier is pinned, the existing engine default applies.

BYOK accepts only an opaque connection ID, never a raw key in the request:

```json
{"prompt":"Summarize the change","model":{"mode":"byok","connectionId":"conn_customer_a"}}
```

In the isolated sandbox lane, set `RUNNER_BYOK_ENABLED=true` and provision `RUNNER_MODEL_CONNECTIONS` as JSON metadata with no secret values. Each record has `connectionId`, `principalId`, `profileId`, optional `tenantId`, `provider: "openai"`, an OpenCode `model` such as `openai/gpt-5`, and a `secretBinding` named `RUNNER_MODEL_SECRET_<ID>`. Provision that binding as a Worker secret. Set `ALLOWED_ENVIRONMENT_NAMES` on the API and `VM_WORKER_ALLOWED_ENV` on the VM to include `OPENAI_API_KEY`. Production rejects this binding until per-run isolation is implemented and verified. The coordinator verifies all identity fields, loads only that secret, and places it under `OPENAI_API_KEY` in the encrypted launch body. A different principal or tenant receives `404`. A missing or malformed binding fails closed. The secret is available to the VM execution process; this is hosted BYOK, not zero-access or customer-cloud execution. Operator provisioning and revocation procedures are still needed before customer onboarding.

Example metadata only:

```json
[{"connectionId":"conn_customer_a","principalId":"customer_a","profileId":"customer_a","tenantId":"tenant_a","provider":"openai","model":"openai/gpt-5","secretBinding":"RUNNER_MODEL_SECRET_CUSTOMER_A"}]
```

`credentialBindings: []` in the old request remains accepted. Existing key registries, routes, repository binding, signed profile delegation and worker callback URLs are untouched. The developer route uses the authenticated principal's repository; it does not accept a repository token or an arbitrary checkout target. No direct prompt may override the principal's repository or model connection.

## Terminal webhook and copyable URL

In the isolated sandbox lane, set `RUNNER_WEBHOOKS_ENABLED=true`. Provision `RUNNER_WEBHOOKS` as JSON metadata with `webhookId`, `principalId`, `profileId`, optional `tenantId`, a reviewed HTTPS `url`, and `secretBinding` named `RUNNER_WEBHOOK_SECRET_<ID>`. Provision that binding as a Worker secret of at least 24 characters. The URL must be a public DNS hostname using HTTPS on port 443; redirects are not followed. The API checks the complete principal/profile/tenant identity before accepting a webhook ID. This delivery path is disabled when `DEPLOYMENT_ENV=production`.

`GET /v1/developer/webhooks` returns the caller's registered `{webhookId, url}` entries. An authenticated console can present the URL with a **Copy my webhook** button; the API does not expose other tenants' URLs. Treat webhook URLs with secret path segments as credentials. Webhook registration and rotation are operator-managed in this increment.

```json
{"prompt":"Generate an SDK","model":{"mode":"managed"},"webhookId":"wh_customer_a"}
```

The run uses the existing `Idempotency-Key` rule. On a terminal `succeeded`, `failed` or `cancelled` state, the Durable Object sends one `run.terminal` event to the pinned URL. The payload contains `eventId: terminal:<runId>`, run ID, terminal state, occurrence time, an absolute `resultUrl`, and a result summary. Summary text is capped at 16,000 characters; retrieve the complete result through the authenticated API. An `unknown` run has no terminal event.

The receiver verifies `X-ServerlessAgence-Signature: v1=<hex>` as HMAC-SHA256 over `<X-ServerlessAgence-Timestamp>.<raw JSON body>` using its configured signing secret. It should reject stale timestamps and deduplicate by `X-ServerlessAgence-Delivery` or `eventId`. Any 2xx acknowledges delivery. Other statuses, redirects and timeouts retry with exponential backoff, up to eight attempts. Network ambiguity can produce a duplicate after the receiver accepted the first request. `GET /v1/developer/runs/{runId}/webhook` reports `pending`, `delivered` or `failed`, attempts and last HTTP status. Pending delivery blocks sandbox cleanup; completed or exhausted delivery can be cleaned normally.

## Product and infrastructure work before public beta

- [x] Add a simplified, opt-in run route and capabilities probe without changing the Control Plane route.
- [x] Preserve idempotency, status, result, events and cancellation through the existing coordinator.
- [x] Add server-provisioned, principal-bound OpenAI BYOK connection references. Keep raw secrets out of request bodies and status responses.
- [x] Add targeted compatibility and end-to-end fake VM tests.
- [x] Add principal-bound terminal webhooks with signed payloads, durable retry state and delivery status.
- [x] Add sandbox guest artifact capability URLs with a 24-hour access TTL, preserving the legacy result fields and authenticated downloads.
- [ ] Prove a fresh isolated sandbox for each run with CPU, memory, disk, process, network and time limits. Run cross-tenant negative tests; `isolation=none` blocks public arbitrary-code use.
- [ ] Implement organization accounts, self-service API key issuance/rotation, tenant-scoped connection creation/revocation, and GitHub App installation on selected repositories.
- [ ] Promote the sandbox GitHub token intake only after the ZeroCreds named-destination contract, sandbox deployment, real form submission, GitHub identity check, revocation and legacy CP canary pass. Define trusted MCP/Git publishing operations separately; method names are undecided.
- [ ] Build a transactional credit ledger: reserve before admission, trusted model/compute metering, settle once, hold unknown outcomes for reconciliation, and cap concurrent trial usage. BYOK still pays for platform execution.
- [ ] Add durable file input, independent private artifact storage, lifecycle deletion after guest expiry, and explicit workspace revision/saveback semantics. Do not create a new product user for every run.
- [ ] Add a trusted GitHub publisher that creates a branch and PR using a repository-scoped installation token. The agent should not hold general write credentials.
- [ ] Pilot short-lived OpenAI workload identity federation and customer-cloud gateway/runner. Document exactly who can call the model and incur charges in each mode.
- [ ] Test the exact Xiaomi MiMo 2.6 Flash identifier and provider path in the isolated France sandbox; pin the verified model and confirm usage accounting before using it as the managed default.
- [ ] Exercise duplicate submit, conflicting idempotency, lost callback, revoked BYOK secret, cancellation, timeout, VM refusal, and credit exhaustion against the sandbox deployment. Preserve the existing CP/Telegram canary.
- [ ] Build a real authenticated web console and connect the landing playground only after the public admission, billing and isolation gates pass.
- [ ] Add self-service webhook registration, challenge/verification, rotation and redrive after an exhausted delivery. Show the registered endpoint and **Copy my webhook** in the authenticated console.

## Compatibility and verification gates

For any change to admission, launch or result mapping, run `npm run typecheck`, `npm test`, `npm run build`, and both sandbox Worker dry runs. The focused tests are `test/cloudflare-runner-api.test.ts`, `test/cloudflare-run-coordinator.test.ts` and `test/cloudflare-developer-e2e.test.ts`; existing `test/api-http.test.ts` and `test/e2e-loop.test.ts` cover the older Node API. Check both a legacy CP request and a developer request in the same test cycle. Webhook acceptance additionally checks signature verification, retry after 5xx, tenant denial, endpoint validation, pending cleanup and the eight-attempt limit. Local fake VM tests establish contract compatibility but cannot prove provider execution or VM isolation.

A sandbox deployment needs the repository's signed release and reviewed deployment path. Keep the production worker and legacy agent untouched until the exact sandbox SHA has passed live canaries, including model execution, callback/result delivery and old CP flows. See `docs/CLOUDFLARE-RUNNER-API.md` and `AGENTS.md` for the current environment boundaries.

For a live webhook canary, provision a dedicated sandbox receiver and signing secret, then enable the two sandbox lane switches for one test principal. Submit a managed run with a new idempotency key and `webhookId`; require the same run ID on replay, a terminal status, one verified event ID at the receiver, a valid HMAC and a result URL that returns the same terminal result to the authenticated caller. Make the receiver respond `503` once, then `204`; require the delivery status to change from `pending` to `delivered` with two attempts and the same event ID. Repeat with a foreign principal, a revoked signing secret, a cancelled run and a worker refusal. Run the existing CP/Telegram canary on the same source SHA before treating the change as compatible. Keep the receiver and keys in the isolated sandbox; do not enable the developer route on production while `isolation=none` and billing is absent.
