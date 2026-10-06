# VM worker configuration and secret inventory

The checked-in France and Russia inventories under `deploy/vm-worker/inventory/` record
binding names and metadata only. They must never contain values. `/version` reports
whether required process-environment bindings are present, their configured source,
owner, rotation date, and whether the binding is secret; it never returns a value.

The current templates deliberately mark owners `UNASSIGNED`. This means we have not
verified the actual France/Russia secret stores or assigned people responsible for
rotation. Replace those entries with the confirmed owner, exact secret manager/path,
and last rotation time before treating the inventory as complete. A missing owner or
rotation date produces warnings; a missing required binding makes readiness fail.

| Binding | Purpose | Intended location / note |
|---|---|---|
| `VM_WORKER_TOKEN` | Authenticates central Agent API → VM worker | Worker-local secret binding in `/etc/ai-agent-runner/worker.env`, mode 0600; central API must hold the matching value. Confirm the actual manager and rotation owner. |
| `RUNNER_GIT_TOKEN` | Optional private repository clone credential | Same host secret path; least-privilege read access only. It is not passed to OpenCode. |
| `GCP_PROJECT` | Optional project selection | Non-secret configuration; GCS access should use attached VM workload identity rather than a downloaded service-account key. |
| GCS workload identity | Writes run/artifact data to `GCS_BUCKET` | Cloud IAM principal attached to the VM, not a process env secret. Record the actual cloud principal/roles with the host inventory. |
| `GH_TOKEN` used by updater | Downloads and verifies the public GitHub release/attestation | Operator-only, transient update environment; it is not loaded by the worker service. Use the minimum read permissions and do not persist it in `worker.env`. |
| `EU_VM_WORKER_URL`, `EU_VM_WORKER_TOKEN`, `RU_VM_WORKER_URL`, `RU_VM_WORKER_TOKEN` | CI drift/health probes | GitHub Actions repository secrets. Names are wired in `.github/workflows/vm-worker-deployment-drift.yml`; verify actual secret presence in GitHub settings without reading values. |
| `LLM_LADDER_TOKEN` | OpenCode provider credential | The central Agent API passes it in the authenticated per-run launch env when allowlisted. It is runtime task input to the worker process and must not be copied into inventory or logged. Record its source and owner in the central API's own binding inventory. |

This document is a registry template, not evidence that any production secret is already
stored at the intended location. The release drift workflow reports worker configuration
presence and GitHub Actions reports missing worker probe secrets; it cannot inspect
Cloud IAM or read a provider's secret store.
