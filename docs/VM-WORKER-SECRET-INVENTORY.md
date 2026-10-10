# VM worker configuration and secret inventory

> API-side paths later in this inventory describe the retired Node API. Current Runner API
> secrets belong in each lane's Cloudflare Worker secret store, not on a VM. See
> [CLOUDFLARE-RUNNER-API.md](CLOUDFLARE-RUNNER-API.md). The France VM owns only execution
> worker credentials and runtime secrets.

The checked-in France and Russia inventories under `deploy/vm-worker/inventory/` record
binding names and metadata only. They must never contain values. `/version` reports
whether required process-environment bindings are present, their configured source,
owner, rotation date, and whether the binding is secret; it never returns a value.

Template entries marked `UNASSIGNED` still need a named owner and rotation date. VM2's
verified secret locations are recorded below, but these metadata gaps continue to produce
readiness warnings; a missing required binding makes readiness fail.

| Binding | Purpose | Intended location / note |
|---|---|---|
| `VM_WORKER_TOKEN` | Authenticates Cloudflare Runner API → VM worker | Worker-local secret binding in `/etc/ai-agent-runner/worker.env`, mode 0600; the paired Runner API holds the matching write-only Cloudflare secret. Confirm the rotation owner. |
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

## EU VM2 sandbox storage identity (verified 2026-10-10)

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
roundtrip passed. The subject-token endpoint is loopback only and returns 404 through the public
reverse proxy.

## EU VM2 sandbox worker (verified deployment 2026-10-10)

VM2 `169.58.15.230` runs worker `eu-vm2-sandbox`, region `eu`, through
`https://eu-vm-worker.169-58-15-230.sslip.io`. The active `ai-agent-vm-worker.service` runs
signed release `vm-worker-v0.3.5`, source commit
`dcca4e4b225ad2489748946b5afec6106b337b9d`; release workflow
[38011481689](https://github.com/trained-assist/ai-agent-runner/actions/runs/38011481689)
passed artifact checksum and attestation verification. `/readyz` reports ready with no missing
required bindings. The successful read-only end-to-end sandbox canary is recorded in
[workflow run 38011605830](https://github.com/trained-assist/ai-agent-runner/actions/runs/38011605830).
After that run, the worker had no active OpenCode process or run workspace and remained ready.

| Binding / resource | Verified location and scope |
|---|---|
| `VM_WORKER_TOKEN` | Worker copy in `/etc/ai-agent-runner/worker.env`, root-owned mode 0600; matching write-only Cloudflare sandbox Worker secret `VM_WORKER_TOKEN`. Values are not recorded here. Owner and rotation date remain unassigned in runtime inventory and appear as readiness warnings. |
| `VM_WORKER_URL` | Cloudflare sandbox Worker secret, set to the VM2 HTTPS worker route above. |
| `LLM_LADDER_TOKEN` | Cloudflare sandbox Worker secret. It is allowlisted and passed to OpenCode only as a per-run model credential; never stored in the checked-in engine template. |
| OpenCode engine config | `/etc/ai-agent-runner/engine-config/opencode.json`, root-owned; derived from the checked-in template. Pins `ladder/free` and reads the API credential from `{env:LLM_LADDER_TOKEN}`. |
| Canary principal | Added through the write-only `RUNNER_API_KEYS_ADDITIONAL` Cloudflare secret. Scoped to repository `trained-assist/ai-agent-runner`, run read/write, and engine `eu-vm-agent-run`. The existing `RUNNER_API_KEYS` registry was preserved. |
| Post-run cleanup | Canary finished successfully; `activeRuns` was 0, no `opencode` process remained, and no `run_*` directory remained in the worker workspace. |

This verifies one real sandbox execution and the isolated EU bucket path. It does not prove the
Control Plane/Telegram product flow, profile storage/saveback, general user repository access,
or production readiness. Optional secret ownership/rotation metadata still needs to be assigned.

## Worker authentication and model credentials

`VM_WORKER_TOKEN` and `LLM_LADDER_TOKEN` serve different trust boundaries:

- `VM_WORKER_TOKEN` is a random, long-lived bearer shared only by one VM Worker and
  its paired Cloudflare Runner API. The VM reads it from `/etc/ai-agent-runner/worker.env`;
  the API reads the matching value from the Cloudflare Worker secret store. It authenticates
  Runner API → Worker HTTP calls.
- `LLM_LADDER_TOKEN` authenticates the agent to the model/provider ladder. The API
  passes it as an allowlisted runtime variable to the agent process. It does not
  authenticate the API to the Worker and must never be reused as `VM_WORKER_TOKEN`.

For initial bootstrap, generate a distinct random Worker token for each VM, transfer it
over authenticated SSH stdin, and write it to the VM and paired Runner API secret stores.
Do not put it in command arguments, shell history, GitHub Actions logs, issue/chat messages,
or run input. Keep the VM file root-owned with mode 0600. Verify the Worker and authenticated
canary before accepting routed jobs. Rotate both copies as one operation after draining new
submissions because the current contract accepts one token per worker.

This repository currently has no automated cross-host token provisioning command.
EU VM2 SSH and its paired sandbox Cloudflare secrets have been verified as recorded above;
no RU VM or API SSH target is verified. `scripts/install-vm-worker.sh` and
`scripts/deploy-api-service.sh` install service configuration but do not create and
securely distribute a shared token. Treat any other worker binding as unprovisioned until
both stores and an authenticated canary have been verified. The model ladder token is not a
workaround for this missing setup.

## Historical France/Russia deployment check (2026-10-07; superseded for VM2)

At that time the GitHub Actions deployment-drift workflow could reach both configured endpoints using
`EU_VM_WORKER_URL` / `EU_VM_WORKER_TOKEN` and `RU_VM_WORKER_URL` / `RU_VM_WORKER_TOKEN`.
The check confirmed both are healthy and ready on VM worker 0.3.1, source commit
`332133113f7618f2779bb1693f5b281720cf8293`. Signed release `vm-worker-v0.3.2` is now
available from the repository's attested release workflow. The later VM2 sandbox deployment
above supersedes the claims that France lacked a verified SSH target or needed to keep sandbox
profile traffic on GHA. This historical note does not describe production routing.

This document is a registry template, not evidence that any production secret is already
stored at the intended location. The release drift workflow reports worker configuration
presence and GitHub Actions reports missing worker probe secrets; it cannot inspect
Cloud IAM or read a provider's secret store.
