# Repository instructions

## Continuous delivery
- Put code onto a task branch as soon as each coherent change starts; do not leave finished work uncommitted.
- Open a draft PR once tests begin; promote draft to ready only after comparing with user scenarios and finding no contradictions.
- Merge only after all required checks are green and a completed E2E covering our changes exists; manual human approval is not required.
- After merge, deploy immediately and stop only when the deploy is verified; do not merge a PR without a deploy plan/path.
- Do not delete prior work, tasks, commits, PRs, records, or memories without explicit user confirmation.
- Keep docs and configuration changes limited to the requested task; do not add unrelated complexity.

## Prohibitions and restrictions

Самые опасные требования — запреты и ограничения прав. Перед тем как где-то что-то запретить, отключить или ограничить права, агент обязан собрать и показать evidence: что защищается, какие наблюдения/тесты/инциденты это поддерживают, какие альтернативы рассмотрены, что теряется. Правило и источник: [AGENTS.md (architecture)](https://github.com/trained-assist/trained-agent-architecture/blob/main/AGENTS.md).

## Credentials (macOS Keychain)
- GitHub default PAT: service `github.com`, account `kobzevvv`, item `Trained Agent GitHub Token`.
- Azure Cloud / GHA / `zen-rings` PAT: service `github.com`, account `gha-compute-cluster`.
- Cloudflare sandbox token: service `cloudflare.com`, account `trained-assist-sandbox`; expected account `d740a05e9442c1d0feacae2dfc673e93`.
Never print secrets or store them in files; read into memory or a child process environment only.

## Sandbox-Driven Engineering

Stopping before a safe dev/test run or refusing to test because it may fail is harmful engineering behavior. In a declared isolated sandbox, run realistic inputs, inspect output/logs/state, fix failures and repeat. Do not finish at code inspection when a runnable test exists. Production remains protected and may only be changed through a verified Promotion to Production path.

## Environment Contract

### Development / Test / Staging
**Resources:** local Node 20+; `npm test` runs Vitest unit/integration, including fake-engine and local HTTP E2E. `npm run build` creates the release bundle. The signed VM-worker release workflow runs only for `vm-worker-v*` tags whose commit is reachable from `main`. An isolated, test-only Runner API service exists on SSH target `vm2` (`agent-runner-api-mcp-test.service`, loopback port 18882); it is not the production API. EU VM2 at `169.58.15.230` is a separate, verified France sandbox execution worker at `https://eu-vm-worker.169-58-15-230.sslip.io`, currently on signed release `vm-worker-v0.3.5`; do not conflate it with the old API host or production. The user has authorized iterative updates to this sandbox worker as part of the current E2E rollout task. Never install/update production through this authorization.

**Realistic local input:** run focused `npx vitest run test/e2e-loop.test.ts` and `test/api-http.test.ts`; local fixtures/fake engine create a run and assert receipt/status/result/log events. These do not prove provider/VM deployment. Build signed artifacts only from an authorized release tag after PR/main checks.
An API sandbox may explicitly set `AGENT_API_ENVIRONMENT=sandbox` and `AGENT_API_ENABLE_MOCK_TEST=true` to expose the authenticated `mock-test` executor. It returns the normal receipt/status/result contract with `pong` and makes no external worker/model/profile/repository call. It is absent by default and API startup rejects enabling it with `NODE_ENV=production`. Do not treat a mock-test pass as proof of real Agent execution.
The signed isolated API candidate installer sets those two flags only in `/etc/agent-runner/agent-runner-api-mcp-test.env` after validating the exact test service/host and preserves/restores that file on failed install or rollback. It installs `runner-api-mcp-test-provision-principal`, a root-only stdin helper that adds a fixed `mock-test` principal from a key hash to `/etc/agent-runner/key-registry-mcp-test.json`. It does not generate or print the raw key; the CP-owned credential bootstrap must separately store the same key in the exact sandbox Worker secret and prove authenticated reachability before claiming readiness.
**Observe:** Vitest output and local API events/results. For the isolated test API, use `docs/API-SANDBOX-OPERATIONS.md`; its deploy probe checks `GET /healthz` and an authenticated unknown-run status. A successful test API health check does not establish model execution or MCP invocation. The VM worker health/readiness/version paths are separate and remain unprovisioned here.
**Reset/retry:** local tests clean up their own fixtures. The isolated API candidate installer keeps versioned releases and a target-specific rollback command. Reconcile accepted runs before restarting or retrying; do not resubmit unknown admissions.
**Permissions:** local tests/build and signed candidate artifact preparation are allowed. The current user authorization permits test-only deployment to EU VM2 through the signed `vm-worker-v*` release and verified updater, then live sandbox E2E and rollback if needed. Production updates go only through the verified promotion path. The original `mcp-test` API is deployed only through `scripts/deploy-api-sandbox-candidate.sh`, after ai-agent-runner#173 is resolved and the architecture owner authorizes that target. The retiring GCP VM is prohibited by architecture/agent repository rules.
For independently owned sandbox lanes, the reviewed `runner-api-sandbox-deploy.yml` workflow provisions only `sandbox3`–`sandbox5` with separate service, env, registry, journal, and profile workspace paths. The lane owner must authorize its deployment and verify no unfinished admissions before an update. The workflow must not point at the legacy API or shared `mcp-test` service.

### Production / Promotion
Deploy rules, promotion path, and credentials: see [SC-OPS-DEPLOY-01](https://github.com/trained-assist/trained-agent-architecture/blob/main/scenarios/operations/SC-OPS-DEPLOY-01-protected-main-production.md) and the workflows in `.github/workflows/` (`deploy-cloudflare-production.yml`, `vm-worker-release.yml`, `configure-production-ingress.yml`). Credentials and other secrets are defined in those deploy rules / GitHub environments, not here.

### Sandbox Gaps
- **Gap:** the isolated test API candidate and EU VM2 sandbox worker are separate resources. The CP-to-VM2 Runner launch/result path is live, but the current CP fixture-tool probe fails because the VM launch adapter drops MCP attachment data. Local fake-engine tests cannot prove that boundary. **Safe verification:** signed `vm-worker-v*` candidate, verified EU VM2 sandbox update, then the same authenticated CP fixture task, inspect result/events, and clean up exact test state. **Owner/issue:** trained-assist/ai-agent-runner E2E rollout; related API sandbox work ai-agent-runner#173 and architecture compatibility gate #174.
