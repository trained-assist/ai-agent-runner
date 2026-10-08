# Repository instructions

## Sandbox-Driven Engineering

Stopping before a safe dev/test run or refusing to test because it may fail is harmful engineering behavior. In a declared isolated sandbox, run realistic inputs, inspect output/logs/state, fix failures and repeat. Do not finish at code inspection when a runnable test exists. Production remains protected and may only be changed through a verified Promotion to Production path.

## Environment Contract

### Development / Test / Staging
**Resources:** local Node 20+; `npm test` runs Vitest unit/integration, including fake-engine and local HTTP E2E. `npm run build` creates the release bundle. The signed VM-worker release workflow runs only for `vm-worker-v*` tags whose commit is reachable from `main`. An isolated, test-only Runner API service exists on SSH target `vm2` (`agent-runner-api-mcp-test.service`, loopback port 18882); it is not the production API or VM worker. The reproducible signed candidate workflow and installer are tracked by ai-agent-runner#173. Do not treat the service as usable until a candidate passes the authenticated API and CP-to-Runner acceptance probes.

**Realistic local input:** run focused `npx vitest run test/e2e-loop.test.ts` and `test/api-http.test.ts`; local fixtures/fake engine create a run and assert receipt/status/result/log events. These do not prove provider/VM deployment. Build signed artifacts only from an authorized release tag after PR/main checks.
An API sandbox may explicitly set `AGENT_API_ENVIRONMENT=sandbox` and `AGENT_API_ENABLE_MOCK_TEST=true` to expose the authenticated `mock-test` executor. It returns the normal receipt/status/result contract with `pong` and makes no external worker/model/profile/repository call. It is absent by default and API startup rejects enabling it with `NODE_ENV=production`. Do not treat a mock-test pass as proof of real Agent execution.
**Observe:** Vitest output and local API events/results. For the isolated test API, use `docs/API-SANDBOX-OPERATIONS.md`; its deploy probe checks `GET /healthz` and an authenticated unknown-run status. A successful test API health check does not establish model execution or MCP invocation. The VM worker health/readiness/version paths are separate and remain unprovisioned here.
**Reset/retry:** local tests clean up their own fixtures. The isolated API candidate installer keeps versioned releases and a target-specific rollback command. Reconcile accepted runs before restarting or retrying; do not resubmit unknown admissions.
**Permissions:** local tests/build and signed candidate artifact preparation are allowed. Install/update only the named isolated test API through `scripts/deploy-api-sandbox-candidate.sh`, after ai-agent-runner#173 is resolved and the architecture owner authorizes that target. Do not install or update production API/VM worker services. The retiring GCP VM is prohibited by architecture/agent repository rules.

### Production / Promotion
The legacy production agent/API belongs to trained-assist-agent and is not redeployed from this repo. Runner's signed release workflow publishes an attested artifact for a main-reachable `vm-worker-v*` tag; operations docs require a human/operator to invoke verified updater on a chosen host, which atomically updates or rolls back. Because no VM worker deployment is confirmed, this is a release artifact path, not evidence of production service rollout. Agents may build/test locally and prepare a release PR; they must not create a production tag or execute an operator install without explicit release authorization.

### Sandbox Gaps
- **Gap:** the isolated test API exists, but its currently installed candidate has not passed the current CP/Host contract; no isolated VM worker has been declared. Local fake-engine tests cannot prove the live external launch/result chain. **Safe verification:** signed candidate workflow plus authenticated submit/result/log/state and cleanup/retry probes against the test API. **Owner/issue:** ai-agent-runner#173; related architecture compatibility gate #174; cross-project rollout: trained-agent-architecture#185.
