# Trusted credential executors for developer runs

Status: proposed contract for [#360](https://github.com/trained-assist/ai-agent-runner/issues/360); **no executor in this document is enabled for public/customer secrets today**. The current developer sandbox BYOK connection passes an OpenAI key to the VM process, and the VM reports `isolation=none`. This document does not change that route or claim it is safe for arbitrary tenant code. It defines the reviewed allowlist and audit boundary to implement after per-run isolation.

ZeroCreds [collects and writes](https://github.com/Zerocreds-com/zerocreds-server/issues/67) a user's credential into an approved owner-scoped destination. The runner broker resolves the user's `connectionId` and authorizes a **specific executor and action** for a **specific run**. The coding model proposes an action; it cannot select a vault path, create a trusted executor, widen its target list or obtain a raw secret. A handle is an identifier, not permission.

## Registry v1: explicit candidates

All entries start `disabled`. A change from `disabled` to `enabled` is a reviewed deployment change, backed by an implemented adapter, negative tests and a policy digest. Existing host capability/MCP registries do not imply permission to use customer credentials.

| Executor ID | Allowed operation | Credential / target | Execution boundary | Model-visible result |
| --- | --- | --- | --- | --- |
| `model.gateway` | `model.invoke` | Provider connection; pinned provider/model endpoint and per-run spend/token limits | Broker-owned HTTP gateway; no arbitrary base URL or headers | Completion/usage with secret fields stripped |
| `github.publisher` | `github.branch_and_pr` | GitHub App installation for selected repository ID; minimum Contents/PR permissions | Trusted publisher outside coding agent; short-lived installation token | Branch/PR URL and publish status |
| `browser.playwright` | `browser.login_and_act` | Site-specific login/cookie connection; exact HTTPS origin and named high-level action | Dedicated per-run browser service/profile; fixed egress; credential never enters OpenCode process | Redacted action result, sanitized page facts |
| `cloud.gateway` | `cloud.resource_invoke` | Customer role/service account; named resource and method allowlist | Broker-owned gateway using WIF/STS when supported | API result filtered by operation schema |
| `customer.gateway` | `customer.capability_invoke` | Customer-controlled connection and gateway identity; approved capability | Runs in customer's boundary with signed, audience-bound request | Customer-approved result only |

There is **no** `shell`, `arbitrary_http`, `raw_playwright`, `page.evaluate`, generic `browser.navigate`, `export_cookie`, `read_secret`, or `return_credential` executor. A new operation must be added by a reviewed registry version, not by a prompt or untrusted run request. The registry must be loaded from trusted deployment configuration or signed release content, with unknown fields rejected. The release and audit record carry its canonical digest.

## Admission and use

A grant request is a structured tuple:

```json
{
  "tenantId": "tenant_123",
  "projectId": "project_456",
  "principalId": "principal_789",
  "runId": "run_abc",
  "connectionId": "conn_tilda",
  "executorId": "browser.playwright",
  "operation": "browser.login_and_act",
  "target": { "origin": "https://tilda.cc", "action": "update_page" },
  "expiresAt": "<short-lived timestamp>",
  "idempotencyKey": "<stable action key>"
}
```

The authenticated control plane supplies tenant, principal and run identity; the agent does not. The broker checks connection ownership and active version, executor status, exact operation/target, run state, budget and required sandbox capability **before** any vault read. It rejects a request if any policy field is absent, ambiguous or broader than the registered connection. A grant is bound to one run, executor, operation, target and audience. It cannot be exchanged for another credential or origin. Use a short TTL with renewal only while the same run is active; cancellation, timeout, revocation and `unknown` block new grants until reconciliation.

Runtime executors authenticate to the broker as their **own workload identities**. ZeroCreds's write identity cannot read; the runner API, coding process and UI cannot enumerate vault values. Prefer a provider gateway that performs the operation without releasing the raw secret to the run. If an adapter must pass a credential into the run process, mark that mode `credential_visible_to_run`, require proven per-run isolation and do not advertise it as zero-access.

## Playwright boundary

`browser.playwright` is a **service using Playwright**, not unrestricted Playwright available to the coding agent. The service fetches a credential only after broker approval, creates a fresh browser context/profile for the run, navigates only to the approved origin, performs one reviewed high-level action and returns a schema-filtered result. It may enter a password or attach a cookie internally; the service and its host can see the value. The model must not receive the password/cookie, raw CDP endpoint, authenticated storage state, browser filesystem or arbitrary script execution in that context.

Each site adapter specifies its own exact origins, action names, selectors/flows, timeout, allowed uploads/downloads, egress and result redaction. Redirects to a new origin, popup windows, file downloads and MFA/CAPTCHA stop at an explicit policy/human-approval boundary. `page.evaluate`, arbitrary selectors/scripts and free navigation supplied by the model are excluded from credential-bearing actions. Destroy the context, cookie jar and temporary files on terminal completion, cancellation and timeout. Keep a separate non-credentialed browser capability for general web exploration if needed; it does not inherit the login session.

For Tilda, an initial adapter could support a specific login-and-update workflow with an approved Tilda origin and named page operation. The current ZeroCreds Tilda form accepts a cookie string; a future password flow requires an explicit site adapter and possibly a user handoff for 2FA. Neither flow is implemented here.

## Audit contract

Emit a durable, tenant-scoped event for `grant_requested`, `grant_denied`, `grant_issued`, `executor_started`, `executor_completed` or `executor_failed`, and `grant_revoked`. Every event has:

- stable `eventId`, timestamp, trace ID and policy version/digest;
- tenant/project/principal/run references and opaque connection ID/version;
- executor ID, operation, normalized target ID/origin and decision reason or redacted error code;
- provider request ID, duration and metered usage when applicable.

Never include raw credentials, session cookies, vault tokens, prompt, page body/screenshot, provider request/response payload, signed artifact URL or full auth headers. The audit sink must be append-only or otherwise tamper-evident, with documented retention and tenant-scoped read access. A provider's own audit log and a signed execution receipt may corroborate, but do not replace, runner-side grant/use records. Unknown outcomes must remain distinguishable from success and must not trigger blind replay of mutating operations.

## Verification and rollout

1. Unit/contract: unknown/disabled executor and operation, wrong owner, wrong origin, redirect, stale registry digest, revoked connection, expired run and oversized grant all fail **before** vault access. No model-provided field can widen policy.
2. Sandbox integration: a canary credential reaches only its approved executor; it is absent from model-visible tool results, agent history, logs, workspace, artifacts and webhook. Browser context is fresh across two runs; cancellation removes its profile. Audit events correlate with one run and include the release policy digest.
3. Browser-specific: block arbitrary `page.evaluate`, new origins, popups and cookie export; verify MFA handoff, target-specific action schema and redaction of page text containing a canary secret.
4. Compatibility: legacy Control Plane and developer `agent_run_start`/`agent_run_wait` canaries pass on the same SHA. The existing operator-provisioned sandbox BYOK connection works until a gated migration and rollback are verified.
5. Public gate: no customer executor enabled until per-run OS/container/VM isolation, CPU/RAM/disk/process/network limits, cross-tenant negative tests, secret lifecycle, billing and retention policies are proven. `isolation=none` fails closed for public credential use.

This policy is the runner-side complement to the [ZeroCreds intake contract in PR #68](https://github.com/Zerocreds-com/zerocreds-server/pull/68).
