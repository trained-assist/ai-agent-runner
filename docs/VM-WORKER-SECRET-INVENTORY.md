# VM worker configuration and secret inventory

> API-side paths later in this inventory describe the retired Node API. Current Runner API
> secrets belong in each lane's Cloudflare Worker secret store, not on a VM. See
> [CLOUDFLARE-RUNNER-API.md](CLOUDFLARE-RUNNER-API.md). The France VM owns only execution
> worker credentials and runtime secrets.

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
| `RUNNER_CONTROL_PLANE_URL`, `RUNNER_CONTROL_PLANE_PRINCIPAL`, `RUNNER_CONTROL_PLANE_PRINCIPAL_SECRET` | Resolve task-scoped ingress manifests and artifact bytes | Configure as one group in the VM worker's systemd environment when the central API sends `ingressManifest`; secret value belongs in the approved host secret store. Without the group, ingress-manifest runs fail closed before the agent starts. |

## RU test worker: verified locations (2026-10-06)

The test Worker at `ru-worker.178-212-14-192.sslip.io` runs signed release
`vm-worker-v0.3.1` (`332133113f7618f2779bb1693f5b281720cf8293`). These are test-only
bindings; this section records presence and location, never secret values.

| Binding | Verified location and scope |
|---|---|
| `VM_WORKER_TOKEN` | GCP Secret Manager secret `RU_VM_WORKER_TOKEN`, project `alesa-personal-assistent`, version 1; runtime copy at `/etc/ai-agent-runner/worker.env`, owned by root, mode 0600. The matching central API binding is not configured, so this token does not yet enable routed runs. |
| WIF signing key | `/opt/ru-wif/private.pem`, root-owned mode 0600; used by `ru-wif-oidc.service`. The issuer listens only on `127.0.0.1:18080`; the public Nginx vhost returns 404 for `/token` and serves only discovery/JWKS. |
| GCS external-account config | `/etc/ai-agent-runner/gcs-wif-credentials.json`, root-owned and group-readable by `ai-agent` (0640); contains no private key or access token. It exchanges the loopback OIDC subject token through Google STS and impersonates the dedicated test service account. |
| GCS identity | `ta-ru-vm-worker-test@alesa-personal-assistent.iam.gserviceaccount.com`, federated by pool `ta-vm-workers`, provider `ru-vm-worker-test`, subject `ru-vm-worker`. It has `roles/storage.objectUser` only on `trained-assist-runner-ru-worker-test-731388616698` in `EUROPE-WEST9`; the bucket has uniform access, public access prevention, and versioning enabled. A real upload/download/delete roundtrip passed. |
| GitHub release verification | `GH_TOKEN` was streamed to the updater through SSH stdin for the installation only. It is not stored in the VM Worker environment or service. |

No service-account key was created. The RU Worker is not configured with a user-data
bucket, and the central API has not been bound to it. The current WIF issuer's local
`/token` endpoint is reachable by processes on the VM; because OpenCode and the Worker
currently share the `ai-agent` Unix identity, an agent process could request a subject
token. The federated identity is therefore restricted to the isolated test bucket.
Do not grant it access to user data until per-run credential isolation is in place.

## EU VM2 sandbox storage identity (provisioning 2026-10-10)

VM2 `169.58.15.230` is being restored as the isolated EU sandbox worker. Its pre-existing
provider `ta-vm-workers/eu-vm-worker-test` is pinned to issuer
`https://eu-worker.169-58-15-230.sslip.io`, audience
`https://iam.googleapis.com/projects/731388616698/locations/global/workloadIdentityPools/ta-vm-workers/providers/eu-vm-worker-test`, and subject `eu-vm-worker`. The service account
`ta-eu-vm-worker-test@alesa-personal-assistent.iam.gserviceaccount.com` is granted only
`roles/storage.objectUser` on `trained-assist-runner-eu-vm2-sandbox-731388616698`
(`EUROPE-WEST9`, uniform access, public access prevention, versioning). It has no access
to profile or production buckets. The generic external-account file belongs at
`/etc/ai-agent-runner/gcs-wif-credentials.json`; `GOOGLE_APPLICATION_CREDENTIALS` points
to it in the worker service environment.

The EU service account previously had an unintended object-user binding on the RU test
bucket. That binding was removed; the RU service account retains its own bucket access.
The EU issuer service, TLS metadata endpoint, credential exchange, and GCS upload/read/delete
roundtrip must all pass before VM2 is called ready. The subject-token endpoint is loopback
only and must return 404 through the public reverse proxy.

## Worker authentication and model credentials

`VM_WORKER_TOKEN` and `LLM_LADDER_TOKEN` serve different trust boundaries:

- `VM_WORKER_TOKEN` is a random, long-lived bearer shared only by one VM Worker and
  the central Agent API. The VM reads it from `/etc/ai-agent-runner/worker.env`;
  the API reads the matching value from `AGENT_API_WORKERS` in
  `/etc/agent-runner/agent-runner-api.env`. It authenticates API → Worker HTTP calls.
- `LLM_LADDER_TOKEN` authenticates the agent to the model/provider ladder. The API
  passes it as an allowlisted runtime variable to the agent process. It does not
  authenticate the API to the Worker and must never be reused as `VM_WORKER_TOKEN`.

For initial bootstrap, generate a distinct random Worker token for each VM on the
central API host, transfer it to that VM over authenticated SSH stdin, and write it to
both protected service configurations. Do not put it in command arguments, shell
history, GitHub Actions logs, issue/chat messages, or run input. Keep the VM file
root-owned with mode 0600 and the API env file restricted to its service owner (mode
0600). Restart and verify the Worker before enabling its matching API entry; then
verify the API health and a canary launch. Rotate both copies as one operation after
draining new submissions because the current contract accepts one token per worker.

This repository currently has no automated cross-host token provisioning command and
no verified France/Russia/API SSH targets. `scripts/install-vm-worker.sh` and
`scripts/deploy-api-service.sh` install service configuration but do not create and
securely distribute a shared token. Treat the binding as unprovisioned until both
stores and an authenticated canary have been verified. The model ladder token is not a
workaround for this missing setup.

## France/Russia deployment check (2026-10-07)

The GitHub Actions deployment-drift workflow can reach both configured endpoints using
`EU_VM_WORKER_URL` / `EU_VM_WORKER_TOKEN` and `RU_VM_WORKER_URL` / `RU_VM_WORKER_TOKEN`.
The check confirmed both are healthy and ready on VM worker 0.3.1, source commit
`332133113f7618f2779bb1693f5b281720cf8293`. Signed release `vm-worker-v0.3.2` is now
available from the repository's attested release workflow, but France still needs an
operator update. This workstation has no verified France SSH target or key; the GitHub
repository secrets provide health-probe credentials only. Keep profile traffic falling
back to GHA until the signed release is installed and `/version` confirms its source
commit on France.

This document is a registry template, not evidence that any production secret is already
stored at the intended location. The release drift workflow reports worker configuration
presence and GitHub Actions reports missing worker probe secrets; it cannot inspect
Cloud IAM or read a provider's secret store.
