# Remote MCP attachment

Runner preserves the existing stdio RunSpec and additionally accepts remote descriptors in `mcp.servers`:

```json
{
  "credentialBindings": [{"ref":"documents-approved","scope":"documents:owner-target"}],
  "mcp": {"servers":[{
    "serverId":"documents",
    "transport":"remote",
    "url":"https://mcp.example.test/mcp",
    "bindingRef":"documents-approved",
    "allowedTools":["google_sheets_create_spreadsheet","read_sheet","write_sheet"],
    "toolTimeoutMs":30000
  }]}
}
```

This is a descriptor fragment, not a complete Submit request. Public descriptors cannot contain headers, tokens, `mcpSecrets`, command fields or environment values. URLs must be HTTPS without credentials, query or fragment. `bindingRef` must be declared in `credentialBindings`.

## Trusted host configuration

Set `AGENT_API_REMOTE_MCP_SERVERS` to a host-owned JSON map (example values only):

```json
{
  "documents": {
    "url":"https://mcp.example.test/mcp",
    "tokenEnvName":"RUNNER_MCP_DOCUMENTS_TOKEN",
    "headers":{"Authorization":"Bearer {env:RUNNER_MCP_DOCUMENTS_TOKEN}"},
    "allowedTools":["google_sheets_create_spreadsheet","read_sheet","write_sheet"]
  }
}
```

Each descriptor must match the host's exact server ID and URL and request a subset of its tools. Header values are restricted to opaque-token environment placeholders, optionally prefixed with `Bearer `. No literal root keys or service-account credentials are accepted here.

The trusted host hook `RemoteMcpBindingResolver(bindingRef, context)` receives the generated run ID, profile, user task, conversation, owner generation, operation, engine, server ID, expected URL and requested tools. Supply it through `createExternalWorkers(config, log, resolveBinding)` or `ExternalWorkerOptions.remoteMcp.resolveBinding`. It may resolve an already registered token or use the wrapper's existing per-run registration contract. Runner does not introduce a minting endpoint, broker or controller.

The resolver returns `RemoteMcpBinding`: the exact context identity fields except operation ID, plus declared `scope`, permitted `allowedTools`, UTC `expiresAt` and an opaque `token`. Runner refuses missing, mismatched or insufficiently long-lived bindings before contacting the worker. Expiry must cover the run timeout. Wrapper registration must additionally enforce owner-approved profile/task/run and document targets; repeat registration should be deterministic for the same run.

For pre-registered bindings, the default process resolver reads `AGENT_API_REMOTE_MCP_BINDINGS_FILE`, a private mode-0600 JSON map keyed by binding reference. Each value has the above binding shape, including the **actual generated** `runId`. A guessed or generic run ID fails closed. This file fallback does not mint tokens and cannot pre-authorize unknown future run IDs; fresh Submit flows require the trusted host hook or an existing host registration integration. Keep private runtime files outside the repository. Missing configuration or binding never silently launches without MCP.

## Existing worker wire contract

Runner converts the descriptor array to `LaunchRequest.mcp.servers[serverId] = {type:'remote',url,headers,enabled:true}`. Only the host-resolved opaque token is passed in `LaunchRequest.mcpSecrets[tokenEnvName]`; it does not enter ordinary `env`, Submit receipts or persisted descriptors. The native worker injects `mcpSecrets` into the engine environment and renders its existing OpenCode remote-server configuration. Service-account material stays exclusively in the documents host wrapper.

The external worker does not implement stdio attachment; stdio descriptors still work in the existing local Runner path, but fail closed in the external HTTP adapter rather than being dropped.

`allowedTools` is a host admission restriction, **not proof of engine-side filtering**. The wrapper endpoint's three-tool whitelist and owner-approved target gate are the actual authorization boundary. The native engine retains its other built-in capabilities. `toolTimeoutMs` is preserved in RunSpec/Submit, but the inspected native worker contract has no timeout field: it is not forwarded or claimed as enforced remotely.

## Validation boundary

`npm run typecheck` and `npm test -- test/remote-mcp.test.ts` validate local contracts, normalization, scoped resolution, refusal before worker contact, wire shape and rejected-token redaction. These are fixtures, not live engine or Sheets evidence. No live Runner job is required or launched by these tests. Deployment, wrapper host-hook wiring, owner target approval and real agent tool execution remain separate integration acceptance steps.
