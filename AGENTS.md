# Repository instructions

## Sandbox-Driven Engineering

Stopping before a safe dev/test run or refusing to test because it may fail is harmful engineering behavior. In a declared isolated sandbox, run realistic inputs, inspect output/logs/state, fix failures and repeat. Do not finish at code inspection when a runnable test exists. Production remains protected and may only be changed through a verified Promotion to Production path.

## Environment Contract

### Development / Test / Staging
**Resources:** local Node 20+; `npm test` runs Vitest unit/integration, including fake-engine and local HTTP E2E. `npm run build` creates the release bundle. The signed VM-worker release workflow runs only for `vm-worker-v*` tags whose commit is reachable from `main`. It does not deploy a candidate to a staging VM. Operations docs state the VM worker is not installed on France/Russia hosts. No stable deployed non-production Runner API/VM worker endpoint is declared.

**Realistic local input:** run focused `npx vitest run test/e2e-loop.test.ts` and `test/api-http.test.ts`; local fixtures/fake engine create a run and assert receipt/status/result/log events. These do not prove provider/VM deployment. Build signed artifacts only from an authorized release tag after PR/main checks.
**Observe:** Vitest output, local API events/result and tests; for a provisioned VM the runbook uses `GET /healthz`, `/readyz`, `/version`, authenticated run status/result/log, and `journalctl -u ai-agent-vm-worker`. Those VM URLs/resources are not presently provisioned.
**Reset/retry:** tests create local temp fixtures; test cleanup is automatic. There is no remote disposable VM state to reset.
**Permissions:** local tests/build and PR/release artifact preparation allowed. Do not install or update services on France/Russia hosts until the sandbox deployment issue is resolved and architecture owner authorizes those hosts. The retiring GCP VM is prohibited by architecture/agent repository rules.

### Production / Promotion
The legacy production agent/API belongs to trained-assist-agent and is not redeployed from this repo. Runner's signed release workflow publishes an attested artifact for a main-reachable `vm-worker-v*` tag; operations docs require a human/operator to invoke verified updater on a chosen host, which atomically updates or rolls back. Because no VM worker deployment is confirmed, this is a release artifact path, not evidence of production service rollout. Agents may build/test locally and prepare a release PR; they must not create a production tag or execute an operator install without explicit release authorization.

### Sandbox Gaps
- **Gap:** no provisioned, isolated non-production Runner API/VM worker exists; local fake-engine tests cannot prove real engine launch, streaming, restart/result persistence, bindings or cleanup. **Safe verification:** full local Vitest/HTTP suite and signed release build. **Owner/issue:** ai-agent-runner#173; related architecture compatibility gate #174; cross-project rollout: trained-agent-architecture#185.
