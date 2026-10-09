# Cloudflare Runner API

Status: implementation slice added 2026-10-09. The sandbox3 Worker was deployed on
2026-10-09 (version `b5105990-eaee-4ec9-a9ce-d92d688c95dd`) with profile-scoped repository
binding and passed an authenticated Durable Object `mock-test` probe returning `pong`. Its API
key registry is currently empty, so it does not accept runs. France worker credentials are
not configured. Telegram UX and real sandbox acceptance are not deployed.

## Runtime boundary

The Control Plane calls the Runner API through a private Cloudflare service binding. The
Runner API is a Cloudflare Worker. A task-keyed Durable Object owns idempotency records, run
state, events, and alarms that reconcile dispatch and poll the VM worker. The Worker alone knows
`VM_WORKER_URL` and `VM_WORKER_TOKEN`. The France VM runs the OpenCode execution worker;
it does not host the Runner API. The Control Plane has no VM URL or VM credential.

`eu-vm-agent-run` is the default and only engine in these sandbox configurations. A GHA
runner is not a fallback. If France cannot accept the job, the task reports an error or an
unknown outcome; the API does not silently move execution elsewhere.
The sandbox-only `mock-test` engine returns a fixed `pong` without calling the VM or a model.

## Configuration

Separate Worker configurations and Durable Object namespaces are defined for sandbox3 and
Telegram UX:

- `wrangler.sandbox3.jsonc`
- `wrangler.telegram-ux-v1.jsonc`

Each deployment needs these secrets:

- `RUNNER_API_KEYS`: JSON list of principals with `keyHash`, `principalId`, `profileId`,
  `repository` (`owner/name`) for every real execution principal, optional `tenantId`, scopes,
  and allowed engines. The authenticated principal's repository is authoritative; requests
  cannot override it. The repository must also appear in `ALLOWED_REPOSITORIES`. Only a
  `mock-test`-only principal may omit this field. The list contains hashes, never raw API keys.
- `VM_WORKER_URL`: HTTPS address of the existing France VM worker route.
- `VM_WORKER_TOKEN`: the worker's current Bearer credential.
- `RUN_LAUNCH_ENCRYPTION_KEY`: stable random value of at least 32 characters. Run requests
  contain short lived publication/runtime credentials; the Durable Object stores the
  encrypted launch body. Keep this key stable while any run is active.
- `LLM_LADDER_TOKEN`: only if this lane's `envAllowlist` permits it.

The France worker must allow the corresponding `workers.dev` origin in
`VM_WORKER_ALLOWED_CALLBACK_ORIGINS`, and its approved repository/environment lists must
match this Worker configuration. The Telegram UX sandbox allowlist includes its isolated
`vovalikessmoothy-png/cp-telegram-ux-runner-sandbox` repository. Check `/readyz` on the VM
before any live canary.

The current Wrangler configs use `workers_dev` and a SQLite Durable Object migration.
Deployment creates persistent Cloudflare state. The sandbox3 Worker currently has no API
principals configured. Until the runtime gaps below are implemented, it is suitable only for
infrastructure diagnostics and the isolated `mock-test` path; neither proves a live Telegram
run or repository persistence.

## Local verification

```bash
npm run typecheck
npm test -- --reporter=dot test/cloudflare-runner-api.test.ts test/cloudflare-run-coordinator.test.ts
npm run worker:dry-run:sandbox3
npm run worker:dry-run:telegram-ux
```

The Worker currently handles authenticated submit, status, result, events, artifacts
metadata, and cancel. It encrypts launch data at rest, deduplicates the same idempotency key,
increments `ownerGeneration` for a later attempt, and reconciles a lost launch response by
querying the same France worker run ID. Durable Objects are sharded by a stable principal,
profile, and task hash; one task's polling does not serialize unrelated tasks.

## Current contract gaps

This slice does not yet implement remote MCP binding resolution, profile workspace
provisioning/saveback, ingress manifest materialization, input refs, binary artifact download,
GCS log publication, SSE, the complete `/v1/capabilities` document, or multi-engine fallback.
Requests requiring unsupported MCP, workspace, ingress, credential, or input-ref features
fail explicitly before a launch. Do not use this Worker for Telegram UX runs that require
the registry MCP or profile workspace until those paths are ported and tested. The legacy
Node API tests remain useful for the modules they cover, but they do not prove Worker parity.

## Retired deployment path

`src/api/main.ts` remains the Node-compatible API implementation used by local tests and
older acceptance fixtures. `scripts/deploy-api-service.sh`,
`scripts/prepare-api-sandbox3.py`, and the old VM API systemd unit describe the previous
VM-hosted API topology. They must not be used to deploy the current Runner API. The VM worker
installer and its `src/vm-worker/` service remain the execution plane.
