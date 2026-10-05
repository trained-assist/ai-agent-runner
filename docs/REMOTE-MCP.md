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
    "transportProfileId":"sandbox-integrator-google",
    "allowedTools":["gdrive_create_spreadsheet","gdrive_read_sheet","gdrive_write_sheet"]
  }
}
```

Each descriptor must match the host's exact server ID, URL, binding reference and tool policy. Configured headers accept only opaque-token environment placeholders, optionally prefixed with `Bearer `. Runner generates `X-MCP-User-Task-Id`, `X-MCP-Profile` and `X-MCP-Run-Id` automatically after trusted resolution; neither caller nor policy can override these headers. `X-MCP-Profile` is the explicitly approved transport profile, or the actor profile when no alias is configured. Root keys and SA credentials are never header values.

The trusted host hook `RemoteMcpBindingResolver(bindingRef, context)` receives generated run ID, actor profile, task, conversation, owner generation, operation, engine, server ID, expected URL, tools, timeout and an abort signal. Supply it through `createExternalWorkers(config, log, resolveBinding)` or the local process configuration below. Resolution has the bounded launch deadline and must stop before minting if aborted. Readiness is established from the real host binding, not a caller-provided verified flag. No new mint endpoint, broker or controller is introduced.

The resolver returns `RemoteMcpBinding`: exact context identities except operation ID, plus host-declared `scope`, permitted tools, expiry, opaque token and optionally host-approved `transportProfileId`. `profileId` remains the admission actor, never a vault alias. Missing, mismatched or insufficiently long-lived bindings are refused before worker contact. Expiry must cover the run timeout. Wrapper targets still require separate owner approval.

For pre-registered bindings, the default process resolver reads `AGENT_API_REMOTE_MCP_BINDINGS_FILE`, a private mode-0600 JSON map keyed by binding reference. Each value has the above binding shape, including the **actual generated** `runId`. A guessed or generic run ID fails closed. This file fallback does not mint tokens and cannot pre-authorize unknown future run IDs; fresh Submit flows require the trusted host hook or an existing host registration integration. Keep private runtime files outside the repository. Missing configuration or binding never silently launches without MCP.

## Existing documents HTTP host integration

Documents PR #20, source `8b14251`, exports `mintBinding({runtime,userTaskId,profile,runId,expiresAt})` and `readBinding(runtime)` from `scripts/sandbox/google-mcp-http.cjs`. Mint is a **host-only function/operator CLI**, not an HTTP endpoint. It exclusively creates a random opaque token in private `http-binding.json`; an existing registration must be inspected and read, never overwritten or minted twice. Expiry must be future and no more than 24 hours away. Profile is pinned to `sandbox-integrator-google`.

Use `registeredDocumentsBindingResolver(registrations, readBinding)` for read-only registration. For opt-in local minting use `localDocumentsBindingResolver(registrations, {readBinding,mintBinding})`, reusing the actual exported functions on the documents domain host with the same private registry. No remote mint service is called. Process wiring accepts `AGENT_API_DOCUMENTS_MCP_MODULE`, the trusted absolute path to `scripts/sandbox/google-mcp-http.cjs`, and `AGENT_API_DOCUMENTS_MCP_REGISTRATIONS`, a host-owned JSON map:

```json
{
  "documents-approved": {
    "runtime":"/absolute/private/dedicated-runtime",
    "serverId":"documents",
    "url":"https://mcp.example.test/mcp",
    "scope":"documents:owner-target",
    "allowedTools":["gdrive_create_spreadsheet","gdrive_read_sheet","gdrive_write_sheet"],
    "userTaskId":"OPERATOR_APPROVED_TASK",
    "actorProfileId":"integration-v1",
    "transportProfileId":"sandbox-integrator-google",
    "mintOnResolve":false
  }
}
```

The map must be explicitly provisioned for the operator-approved task and exact actor. The only v1 actor-to-vault mapping supported here is `integration-v1` to `sandbox-integrator-google`; all other actors refuse before binding access. The physical credential folder/child `USER_ID` stays `sandbox-integrator-google`. It is not the admission owner. Wrapper `profile`/`X-MCP-Profile` describes its transport/vault profile; actual actor ownership remains checked by Runner's explicit host registration. No old tasks are moved or admission ownership changed.

`mintOnResolve` is disabled by default. After separate owner authorization, the operator may enable it: on a genuinely missing binding (`ENOENT`) Runner calls the existing local `mintBinding` once with the generated UUID, pinned task, transport profile and bounded expiry (run timeout plus one minute, at most 24 hours). No SA is read by mint, no Google operation is performed and no host is started. Invalid/expired/mismatched records are never replaced. An exclusive-create race (`EEXIST`) is followed by exact tuple verification. Repeat resolution for the same run reads the same opaque token; a new run needs its own isolated registry/host and owner target approval. An aborted resolver cannot start a late mint.

The native `{runId,userTaskId,profile,expiresAt,authToken}` record is converted to the full scoped binding only after exact run/task/transport-profile checks. Runtime paths never enter the worker wire. Do not enable mint or start the listener before owner authorization/target input. The code and tests are not a live-ready claim.

The wrapper requires `Authorization` and all three scope headers on every RPC. Its exact tool names are `gdrive_create_spreadsheet`, `gdrive_read_sheet`, `gdrive_write_sheet`. Its loopback listener needs separately approved TLS forwarding that preserves local Host and scope/auth headers.

For remote-MCP Submit only, Runner generates a fresh bare canonical UUID and forwards that identical ID to the worker, binding and headers. Non-MCP ID generation is unchanged. No prefix is stripped from an existing run and CP's input run ID is never substituted. This matches documents source `8b14251` without relaxing its UUID checks. Cross-host deployment without a shared private registry is unsupported here; no broker or transport is invented to bridge it.

## Existing worker wire contract

Runner converts the descriptor array to `LaunchRequest.mcp.servers[serverId] = {type:'remote',url,headers,enabled:true}`. Only the host-resolved opaque token is passed in `LaunchRequest.mcpSecrets[tokenEnvName]`; it does not enter ordinary `env`, Submit receipts or persisted descriptors. The native worker injects `mcpSecrets` into the engine environment and renders its existing OpenCode remote-server configuration. Service-account material stays exclusively in the documents host wrapper.

The external worker does not implement stdio attachment; stdio descriptors still work in the existing local Runner path, but fail closed in the external HTTP adapter rather than being dropped.

`allowedTools` is a host admission restriction, **not proof of engine-side filtering**. The wrapper endpoint's three-tool whitelist and owner-approved target gate are the actual authorization boundary. The native engine retains its other built-in capabilities. `toolTimeoutMs` is preserved in RunSpec/Submit, but the inspected native worker contract has no timeout field: it is not forwarded or claimed as enforced remotely.

## Validation boundary

`npm run typecheck` and `npm test -- test/remote-mcp.test.ts` validate local contracts, normalization, scoped resolution, refusal before worker contact, wire shape and rejected-token redaction. These are fixtures, not live engine or Sheets evidence. No live Runner job is required or launched by these tests. Deployment, wrapper host-hook wiring, owner target approval and real agent tool execution remain separate integration acceptance steps.
