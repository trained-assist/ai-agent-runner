# Developer API foundation and release checklist

The Cloudflare Runner now has an opt-in developer route for a free-form prompt and a server-provisioned OpenAI connection. It uses the existing task-keyed Durable Object for admission, idempotency, launch reconciliation, status, events, result, artifacts and cancellation. The current Control Plane contract at `/v1/runs` is unchanged. This is a working API path for trusted sandbox principals, not a self-service paid service: the current VM accepts `isolation.mode=none`, and there is no credit ledger or automatic customer onboarding.

## Current request contract

In an isolated sandbox lane, set `RUNNER_DEVELOPER_API_ENABLED=true` and provision a principal with a trusted repository, `runs:read` and `runs:write`, and `developerApi: true`. Existing principals without the flag cannot use these routes. The developer route is disabled when `DEPLOYMENT_ENV=production`, even if the key flag and lane switch are present. The API key remains in the usual hash-only registry. The route creates a stable internal `userTaskId` from the principal, profile and `Idempotency-Key`, then forwards the normalized run to the existing coordinator. A repeated request with the same key and body returns the same receipt; a different body conflicts.

```http
GET /v1/developer/capabilities
Authorization: Bearer <runner-api-key>
```

Capabilities show which model modes are configured for this principal and its connection IDs. They also disclose `isolation: none`, the maximum timeout, and that billing and self-service connections are unavailable.

```http
POST /v1/developer/runs
Authorization: Bearer <runner-api-key>
Idempotency-Key: customer-task-001
Content-Type: application/json

{"prompt":"Inspect this repository and explain the failing test","model":{"mode":"managed"},"limits":{"timeoutSeconds":300}}
```

The response is `202` with `runId`, `id`, `statusUrl` and `resultUrl`. Repeat submission returns `200` and the same `runId`. Read `GET /v1/developer/runs/{runId}` for status, `.../result` for terminal result, `.../events` for events, `.../artifacts` for outputs, and `POST .../cancel` to request cancellation. The underlying status and result schema are the established Runner v1 schema; for example result text is in `text`. The usual `unknown` state means execution outcome is uncertain and must be reconciled, not resubmitted automatically.

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

## Product and infrastructure work before public beta

- [x] Add a simplified, opt-in run route and capabilities probe without changing the Control Plane route.
- [x] Preserve idempotency, status, result, events and cancellation through the existing coordinator.
- [x] Add server-provisioned, principal-bound OpenAI BYOK connection references. Keep raw secrets out of request bodies and status responses.
- [x] Add targeted compatibility and end-to-end fake VM tests.
- [ ] Prove a fresh isolated sandbox for each run with CPU, memory, disk, process, network and time limits. Run cross-tenant negative tests; `isolation=none` blocks public arbitrary-code use.
- [ ] Implement organization accounts, self-service API key issuance/rotation, tenant-scoped connection creation/revocation, and GitHub App installation on selected repositories.
- [ ] Build a transactional credit ledger: reserve before admission, trusted model/compute metering, settle once, hold unknown outcomes for reconciliation, and cap concurrent trial usage. BYOK still pays for platform execution.
- [ ] Add durable file input, downloadable private artifacts and explicit workspace revision/saveback semantics. Do not create a new product user for every run.
- [ ] Add a trusted GitHub publisher that creates a branch and PR using a repository-scoped installation token. The agent should not hold general write credentials.
- [ ] Pilot short-lived OpenAI workload identity federation and customer-cloud gateway/runner. Document exactly who can call the model and incur charges in each mode.
- [ ] Test the exact Xiaomi MiMo 2.6 Flash identifier and provider path in the isolated France sandbox; pin the verified model and confirm usage accounting before using it as the managed default.
- [ ] Exercise duplicate submit, conflicting idempotency, lost callback, revoked BYOK secret, cancellation, timeout, VM refusal, and credit exhaustion against the sandbox deployment. Preserve the existing CP/Telegram canary.
- [ ] Build a real authenticated web console and connect the landing playground only after the public admission, billing and isolation gates pass.

## Compatibility and verification gates

For any change to admission, launch or result mapping, run `npm run typecheck`, `npm test`, `npm run build`, and both sandbox Worker dry runs. The focused tests are `test/cloudflare-runner-api.test.ts`, `test/cloudflare-run-coordinator.test.ts` and `test/cloudflare-developer-e2e.test.ts`; existing `test/api-http.test.ts` and `test/e2e-loop.test.ts` cover the older Node API. Check both a legacy CP request and a developer request in the same test cycle. Local fake VM tests establish contract compatibility but cannot prove provider execution or VM isolation.

A sandbox deployment needs the repository's signed release and reviewed deployment path. Keep the production worker and legacy agent untouched until the exact sandbox SHA has passed live canaries, including model execution, callback/result delivery and old CP flows. See `docs/CLOUDFLARE-RUNNER-API.md` and `AGENTS.md` for the current environment boundaries.
