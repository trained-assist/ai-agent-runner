# Remote MCP attachment

Runner preserves the existing stdio RunSpec and additionally accepts remote descriptors in `mcp.servers`:

```json
{
  "mcp": {"servers":[{
    "serverId":"documents",
    "transport":"remote",
    "url":"https://mcp.example.test/mcp",
    "bindingRef":"documents-approved",
    "allowedTools":["gdrive_create_spreadsheet","gdrive_read_sheet","gdrive_write_sheet"],
    "toolTimeoutMs":30000
  }]}
}
```

This is a descriptor fragment, not a complete Submit request. Public descriptors cannot contain headers, tokens, `mcpSecrets`, command fields or environment values. URLs must be HTTPS without credentials, query or fragment. `bindingRef` must be declared in the trusted host policy's `bindingScopes`. CP need not send `credentialBindings`; caller status/readiness flags never authorize attachment. An optional caller declaration cannot contradict host scope.

## Trusted host configuration

Set `AGENT_API_REMOTE_MCP_SERVERS` to a host-owned JSON map (example values only):

```json
{
  "documents": {
    "url":"https://mcp.example.test/mcp",
    "tokenEnvName":"RUNNER_MCP_DOCUMENTS_TOKEN",
    "headers":{"Authorization":"Bearer {env:RUNNER_MCP_DOCUMENTS_TOKEN}"},
    "bindingScopes":{"documents-approved":"documents:owner-target"},
    "allowedTools":["gdrive_create_spreadsheet","gdrive_read_sheet","gdrive_write_sheet"],
    "startupTimeoutMs":600000
  }
}
```

Each descriptor must match the host's exact server ID, URL, binding reference and tool policy. Configured headers accept only opaque-token environment placeholders, optionally prefixed with `Bearer `. Runner generates all three scope headers from validated context: task, actor profile (`integration-v1` for documents), and unchanged `run_<UUID>`. Neither caller nor policy can override them. Vault identity is never a scope-header alias. Root keys and SA credentials are never header values.

The trusted host hook `RemoteMcpBindingResolver(bindingRef, context)` receives generated run ID, actor profile, task, conversation, owner generation, operation, engine, server ID, expected URL, tools, engine/startup budgets, original admission time, check time, launch/restore mode and an abort signal. Supply it through `createExternalWorkers(config, log, resolveBinding)` or the local process configuration below. Resolution has the bounded launch deadline and must stop before minting if aborted. Readiness is established from the real host binding, not a caller-provided verified flag. No new mint endpoint, broker or controller is introduced.

The resolver returns `RemoteMcpBinding`: exact context identities except operation ID, plus host-declared scope, permitted tools, expiry and opaque token. `profileId` remains the admission actor. Missing, mismatched or insufficiently long-lived bindings are refused before worker contact. Trusted `startupTimeoutMs` is required in host policy (zero only for a host with no startup allowance), not caller limits. Expiry must cover the original admission time plus startup and engine budgets; mint adds one minute, with total lifetime bounded to 24 hours. Wrapper targets still require separate owner approval.

For pre-registered bindings, the default process resolver reads `AGENT_API_REMOTE_MCP_BINDINGS_FILE`, a private mode-0600 JSON map keyed by binding reference. Each value has the above binding shape, including the **actual generated** `runId`. A guessed or generic run ID fails closed. This file fallback does not mint tokens and cannot pre-authorize unknown future run IDs; fresh Submit flows require the trusted host hook or an existing host registration integration. Keep private runtime files outside the repository. Missing configuration or binding never silently launches without MCP.

## Existing documents HTTP host integration

Documents PR #20, source `217a8b4`, exports `mintBinding({runtime,userTaskId,expectedActorProfile,credentialProfile,runId,expiresAt})`, `readBinding(runtime)` and `createHttpHost({runtime,port})` from `scripts/sandbox/google-mcp-http.cjs`. Mint is host-local, not an HTTP endpoint. Actor is `integration-v1`, credential profile is `sandbox-integrator-google`, and run ID must preserve `run_<UUID>`. Mint exclusively creates a random opaque token; existing registrations are never overwritten. Expiry must be future and at most 24 hours away.

Use `registeredDocumentsBindingResolver(registrations, readBinding)` for metadata-only reading; this alone does not establish HTTP readiness. The configured local resolver reuses `{readBinding,mintBinding,createHttpHost}` on the same domain host/private registry. It refuses before mint/read if startup is not explicitly enabled with a fixed local port and the actual startup export. After exact registration, it awaits real domain startup (including the wrapper's three-tool discovery) and a listening socket before returning attachment. No remote mint service is called. Process wiring accepts `AGENT_API_DOCUMENTS_MCP_MODULE`, the trusted absolute path to the existing module, and `AGENT_API_DOCUMENTS_MCP_REGISTRATIONS`, a host-owned JSON map:

```json
{
  "documents-approved": {
    "runtime":"/absolute/private/dedicated-runtime",
    "serverId":"documents",
    "url":"https://mcp.example.test/mcp",
    "scope":"documents:owner-target",
    "allowedTools":["gdrive_create_spreadsheet","gdrive_read_sheet","gdrive_write_sheet"],
    "userTaskId":"OPERATOR_APPROVED_TASK",
    "conversationId":"OPERATOR_APPROVED_CONVERSATION",
    "ownerGeneration":1,
    "engine":"dynamic-ip-azure-agent-run",
    "expectedActorProfile":"integration-v1",
    "credentialProfile":"sandbox-integrator-google",
    "mintOnResolve":false,
    "startOnResolve":false,
    "port":8791
  }
}
```

Provision registrations after CP intake has supplied the task ID, before routing/submitting its agent attempt. The only v1 actor-to-vault mapping supported is explicit `expectedActorProfile: integration-v1` to `credentialProfile: sandbox-integrator-google`; all other actors refuse. Native `binding.profile`, scope headers and owner-target profile are the actor. Native `binding.credentialProfile` and the physical folder/child `USER_ID` are the vault. No admission ownership changes, old task migration or caller-controlled vault selection occurs.

Mint and startup opt-ins default off. After owner authorization, enabling both permits missing-file (`ENOENT`) local mint followed by `createHttpHost`. Mint receives the exact actor/vault pair, pinned task, unchanged canonical run ID and bounded expiry (original admission plus startup budget, engine timeout and one minute, at most 24 hours). Invalid/expired/mismatched records are never replaced; `EEXIST` triggers exact verification. Same-run repeats reuse token and started host; changed scope requires a new isolated runtime/host. Startup errors are cached, not automatically retried. Deadline abort closes late-starting hosts; Runner disposal closes started hosts. Startup uses the existing SA on its host, but no mint/startup function calls Google artifact tools.

Journal replay first queries native status for the already-dispatched run. A terminal status retrieves the existing result without reading, minting or restoring an MCP binding/domain, even when its lease has expired or its file is missing. Only nonterminal runs require restoration before continued polling. Restore passes the original admission time and exact canonical run/task/conversation/generation/engine tuple; it never mints or launches another job. Lease checks use the remaining original budget, not a fresh startup/engine budget measured from recovery. Missing, expired or mismatched nonterminal scope/domain produces explicit `mcp_restore_tool_outcome_unknown`, not successful tool evidence or an automatic rerun.

The local startup export must return `{server,close,isReady}`; `isReady()` must reflect live stdio child/RPC health as well as a listening socket. An unready cached host is closed and cannot automatically restart. Documents source `0eb98ce` supplies this hook and closes its listener on child/RPC failure; older `217a8b4` lacks the hook and is intentionally refused. This resolves the source-level interface dependency, not deployment, TLS reachability or live restart/child-crash acceptance.

Native `{runId,userTaskId,profile,credentialProfile,expiresAt,authToken}` is converted only after exact run/task/actor/vault checks. Runtime paths and vault identity never enter engine headers. Do not enable mint/startup before owner authorization/target input. Fixtures are not live-ready proof.

The wrapper requires `Authorization` and all three scope headers on every RPC. Its exact tool names are `gdrive_create_spreadsheet`, `gdrive_read_sheet`, `gdrive_write_sheet`. Its loopback listener needs separately approved TLS forwarding that preserves local Host and scope/auth headers.

Runner retains `newApiId('run')`: canonical `run_<UUID>` is identical in its receipt, worker request, private binding, owner-target metadata and scope headers. There is no bare-UUID normalization or prefix stripping. Deploy the existing documents host module and Runner resolver on the same VM with a shared private registry; no cross-host mint broker is needed or implemented. Remaining composition requires approved runtime/targets and a TLS route preserving the wrapper's local Host header, followed by live verification. Startup success alone is not proof that the external engine can reach that TLS route or access owner-approved Sheets targets.

## Test-only registry fixture binding

The opt-in process resolver supports only profile `integration-telegram-ux-v1`, server
`trained-assist-registry-test`, binding `registry-mcp-test-160-read`, and the single tool
`registry.fixture_read`. Its remote descriptor must include `policyVersion` and
`catalogueVersion`; both must match the trusted server policy and configured catalogue
version. The trusted server policy must pin `policyVersion` to
`registry-fixture-policy-v1` and scope the binding to `registry:fixture-read`, matching
the CP and Host fixture contract. Other
profiles continue through the configured documents resolver or private binding-file
fallback. The test profile never falls back to either resolver.

Enable it only through host process configuration using `AGENT_API_TEST_MCP_BEARER`, one of
`AGENT_API_TEST_MCP_ED25519_PRIVATE_KEY` (PEM) or
`AGENT_API_TEST_MCP_ED25519_PRIVATE_KEY_B64` (PKCS#8 DER),
`AGENT_API_TEST_MCP_CATALOGUE_VERSION`, and `AGENT_API_TEST_MCP_REGISTRY_DIGEST`.
All four are required together. The digest is pinned
in code to `129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9`; a fixture
catalog change requires an explicit policy revision. Supply a secret Bearer and Ed25519
PKCS#8 private key through the runtime secret manager; do not place their values in source,
logs, or RunSpec. The matching public JWK belongs in Host configuration.

After API admission assigns the actual `run_<UUID>`, Runner resolves the trusted binding
and signs a compact EdDSA JWS in `X-MCP-Run-Binding`. Its claims bind the receipt run ID,
task, profile/principal, server, binding ref, tool, policy/catalog versions and pinned
catalog digest. The Bearer is still sent for transport, but it does not create this
run-binding proof. Missing or mismatched config, descriptor, scope, or proof fails closed
before worker contact. This is an offline contract path; it does not configure a live
trusted store or establish live endpoint reachability.

## Existing worker wire contract

Runner converts the descriptor array to `LaunchRequest.mcp.servers[serverId] = {type:'remote',url,headers,enabled:true}`. Only the host-resolved opaque token is passed in `LaunchRequest.mcpSecrets[tokenEnvName]`; it does not enter ordinary `env`, Submit receipts or persisted descriptors. The native worker injects `mcpSecrets` into the engine environment and renders its existing OpenCode remote-server configuration. Service-account material stays exclusively in the documents host wrapper.

The external worker does not implement stdio attachment; stdio descriptors still work in the existing local Runner path, but fail closed in the external HTTP adapter rather than being dropped.

`allowedTools` is a host admission restriction, **not proof of engine-side filtering**. The wrapper endpoint's three-tool whitelist and owner-approved target gate are the actual authorization boundary. The native engine retains its other built-in capabilities. `toolTimeoutMs` is preserved in RunSpec/Submit, but the inspected native worker contract has no timeout field: it is not forwarded or claimed as enforced remotely.

## Validation boundary

`npm run typecheck` and `npm test -- test/remote-mcp.test.ts` validate local contracts, normalization, scoped resolution, refusal before worker contact, wire shape and rejected-token redaction. These are fixtures, not live engine or Sheets evidence. No live Runner job is required or launched by these tests. Deployment, wrapper host-hook wiring, owner target approval and real agent tool execution remain separate integration acceptance steps.

## Sandbox delegation to the MCP Host user catalog (issue #35)

The product user catalog can be attached to a trusted sandbox profile with a dedicated binding resolver. It is pinned to the user sandbox Worker URL, server `mem-gpt`, binding `mem-gpt-user-sandbox`, scope `mcp:user-agent-run`, policy `mem-gpt-user-run-v1`, and the exact catalogue digest/version. Set `runnerProof: true` in that host policy. Runner resolves the subject only from `AGENT_API_USER_MCP_PROFILE_USERS` (a trusted JSON profile-to-userId map); RunSpec has no userId field and cannot choose another user. Per-run JWS claims bind the generated Run ID, task, profile, owner generation, endpoint, catalogue, scope, and the descriptor's requested subset of the three allowed tools. Each attachment also gets the fixed invocation/scope headers. User proof lifetime is at most two hours and must cover the original run deadline, including during restore.

Sandbox-only runtime settings are `RUNNER_MCP_USER_TOKEN`, `RUNNER_MCP_USER_SIGNING_KEY_B64` (PKCS#8 Ed25519 private key; PEM alternative `RUNNER_MCP_USER_SIGNING_KEY`), and `AGENT_API_USER_MCP_PROFILE_USERS`. The user Worker receives the matching transport token as `MCP_RUNNER_AUTH_TOKEN`, the public JWK as `MCP_RUNNER_PUBLIC_JWK`, and `MCP_USER_CATALOGUE_VERSION`. The user personal API key is never used by this route. Keep the private key and shared transport token out of RunSpec, prompt, checked-in vars, and logs. Production requires a separate reviewed profile mapping, keys, and end-to-end proof; these sandbox settings do not authorize it.

### Cloudflare Telegram UX sandbox route

The dedicated Cloudflare Runner API uses the same fixed `mem-gpt` server contract but issues the grant inside its Durable Object because that route does not pass through Node Agent API configuration. Its trusted Wrangler variables pin the one sandbox profile to `trained-assist-product-owner`, catalogue version, and digest; its secrets are `MCP_USER_AUTH_TOKEN` and an Ed25519 private JWK in `MCP_USER_RUNNER_PRIVATE_JWK`. It accepts this descriptor only for the pinned profile/principal, refuses a grant longer than two hours before admission, encrypts the launch with its existing launch-encryption key, and sends the proof and transport token as `mcpSecrets` to the France VM. The VM accepts only the product user endpoint or the existing test fixture, and injects secrets through environment placeholders into OpenCode's runtime config. The profile the grant carries is the run's disposable identity, `sbx_<sha256(runId)[0:32]>`, and not the lane profile: the user gateway authenticates the profile in the run binding proof, and the VM worker derives the same value from the run id, so a run can neither borrow another run's identity nor fall back to the lane profile. Arbitrary or multi-server descriptors remain rejected on that route.

OpenCode's headless `run --format json` rejects permission requests unless an explicit rule allows them. For this pinned product server only, the VM config allows exactly the seven catalog tools under their canonical OpenCode ids: `mem-gpt_identity_whoami`, `mem-gpt_google_docs_connect`, `mem-gpt_google_docs_get_document`, `mem-gpt_zerocreds_wallet_form_create`, `mem-gpt_zerocreds_wallet_form_status`, `mem-gpt_zerocreds_wallet_connection_status`, and `mem-gpt_zerocreds_wallet_connection_revoke`; it does not enable blanket auto-approval or a wildcard MCP rule.
