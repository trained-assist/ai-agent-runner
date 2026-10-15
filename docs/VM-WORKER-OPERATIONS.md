# VM OpenCode worker: install and operations

The Agent API remains the single router. It selects a configured worker and calls
`POST /v1/launch`; this service is the missing host-side process that accepts that
contract and starts the local OpenCode adapter. Install one service per VM, with its
own worker engine name, public HTTPS origin, token, and capacity reservation.

## Current scope

This first installable slice includes an authenticated HTTP listener, durable Runner
state, durable host-wide capacity reservations, status/result/cancel endpoints,
replayable stdout/stderr SSE, startup recovery, liveness/readiness checks, and a
systemd unit. It supports OpenCode only. The Russia worker rejects model identifiers
containing Claude or Codex. It accepts only `isolation.mode=none`; this is a single
service Unix identity, not per-run OS isolation.

Build identity is served by `GET /version`: semantic version, exact 40-character
source commit and build timestamp. It also reports the binding inventory by variable
name, location, owner, rotation date and presence. Secret values are never returned.
Required missing bindings make `/readyz` return 503; an unassigned secret owner or
missing rotation date is a warning. The example inventories intentionally show
`UNASSIGNED` owners until an operator records the real owner and store path.

Profile-backed tasks use the API-owned saveback protocol. The API pins a base revision,
creates a signed snapshot archive and issues a one-run write-only saveback capability.
The VM verifies the snapshot size and SHA-256, materializes it without GitHub credentials,
filters changed files through the shared export policy, and uploads each allowed file to
the API with its SHA-256. The VM returns an explicit changes manifest (including
deletions); the API verifies the uploaded bytes and publishes the canonical Git merge.
The capability is omitted from durable Runner state and never enters the agent process.
On an upload failure the VM retains its workspace and reports persistence as failed.

The older VM profile protocol (GitHub token, run branch and VM-side push) remains available
for non-saveback callers during migration. New API profile runs must use the API-owned
protocol; an older VM returns `501 WORKER_PROFILE_WORKSPACE_UNSUPPORTED` before admission,
so the API can try the next configured worker. Only after the signed release has been
installed and `/version` plus `/readyz` confirm it should France be the first profile
worker. Runs without a profile workspace continue to return `repo.commit: null`.

Task-scoped Control Plane `ingressManifest` pins now pass through the external-worker
request into Runner. Configure `RUNNER_CONTROL_PLANE_URL`,
`RUNNER_CONTROL_PLANE_PRINCIPAL`, and `RUNNER_CONTROL_PLANE_PRINCIPAL_SECRET` together
when using this capability. With all three absent, ordinary runs remain available but
a run carrying an ingress manifest fails closed before OpenCode starts; a partial
configuration prevents worker startup. Ingress input materialization and profile
workspace publication are separate capabilities.

Production profile `trained-assist-production` uses a separate, read-only Control Plane
principal. The signed France VM release accepts the narrowly scoped
`configure-production-ingress` forced command through the protected workflow. It
installs `RUNNER_CONTROL_PLANE_PRODUCTION_URL`,
`RUNNER_CONTROL_PLANE_PRODUCTION_PRINCIPAL`, and
`RUNNER_CONTROL_PLANE_PRODUCTION_PRINCIPAL_SECRET` in a root-owned systemd
environment file. Production pins fail closed if this group is absent; sandbox pins
continue to use the original `RUNNER_CONTROL_PLANE_*` group. Rotate the production
credential as a paired Control Plane and VM operation.

## Install on a Linux VM

GitHub Actions builds and signs an immutable release; the France sandbox deployment job
then verifies and installs it after active work drains. The updater switches the versioned
symlink, restarts systemd, and rolls back if the new process is not ready. The signed
bundle also carries the pinned OpenCode Linux x64
binary; the updater verifies its version and SHA-256 and points `/usr/local/bin/opencode`
through the same `current` symlink, so rollback restores the matching binary. `/version`
reports the Runner source commit and the OpenCode version, source commit, and binary SHA.
`ai-agent-vm-worker.service` owns the long-running worker.
`install-vm-worker.sh` is only a one-time bootstrap for the service account, unit,
configuration templates, and updater. Each worker release pins a specific OpenCode
preview tag and its source/archive/binary hashes. Before packaging, CI compares that pin
with the newest published `mem-preview` tag and fails if the pin is stale. A new OpenCode
preview therefore requires an explicit pin change and worker release; builds never float
to an unreviewed binary. The France auto-deploy is release-triggered in GitHub Actions;
there is no workstation scheduler or VM self-update timer.
France bootstrap also installs the host shared libraries required by headless
Playwright Chromium. It does not install a browser or restart the worker service;
the agent may install a pinned Playwright package and browser inside its run workspace.
Run `scripts/install-playwright-runtime.sh` once as root on an existing France VM to
apply the same dependency set without replacing the active worker release.

### Pinned Registry test MCP

The France VM worker accepts remote MCP launch data only for the fixed
`integration-telegram-ux-v1` read-only Registry fixture binding and its exact
test URL. It rejects caller-selected MCP servers and headers. Cloudflare sends
the scoped bearer and run-bound proof as separate per-launch secrets; the worker
turns them into OpenCode `{env:NAME}` header references and passes values only
through Runner's memory-only runtime environment. Secret values are not added
to `RunSpec` or worker state. This is a test integration path, not a general
user-configurable remote MCP feature.

Before enabling a worker, detect and record the full configuration group: region and
worker ID; `VM_WORKER_PUBLIC_URL`, `VM_WORKER_ENGINE`, `VM_WORKER_TOKEN`; bind address
and port; CPU/RAM admission limits; GCS bucket and attached workload identity; OpenCode
binary path; approved repositories and environments; and, when ingress manifests are
used, all three `RUNNER_CONTROL_PLANE_*` bindings. Check values locally on the host,
but publish only presence, source/store path, owner, and rotation metadata. Never print
secret values. The updater requires `VM_WORKER_PUBLIC_URL` to be a valid HTTP(S) origin
before it changes the active release.

For the Contabo EU VM, GCS uses its dedicated `ta-eu-vm-worker-test` Workload Identity
Federation provider and VM-local issuer. Install the `ta-vm-worker-wif-issuer` service
with a signing key readable only by its dedicated system account; it binds only to
`127.0.0.1:18080`. The HTTPS proxy
publishes only `/.well-known/openid-configuration` and `/.well-known/jwks.json`, and must
return 404 for `/token`. Generate the external-account credential file with
`gcloud iam workload-identity-pools create-cred-config` using the provider's full audience,
service account `ta-eu-vm-worker-test@alesa-personal-assistent.iam.gserviceaccount.com`,
and credential source `http://127.0.0.1:18080/token`; install it root-owned at
`/etc/ai-agent-runner/gcs-wif-credentials.json` and set
`GOOGLE_APPLICATION_CREDENTIALS` in `worker.env`. The service account has access only to
the dedicated EU VM2 sandbox bucket. Never make a service-account key.

## Start another machine

For a replacement VM, install the same signed release and preserve the existing
`/var/lib/ai-agent-runner` data disk. Provision the OS, attach that disk at the same
path, restore `/etc/ai-agent-runner/worker.env` and `worker-bindings.json` from the
approved secret/config stores, then run the install and updater steps below. Give the
replacement a unique `VM_WORKER_ID`; keep the regional engine (`eu-vm-agent-run` for
France or `rf-vm-agent-run` for Russia). Verify `systemctl`, `/healthz`, `/version`,
`/readyz`, and a small canary run before pointing the central API at the replacement.

The router currently accepts only one `AGENT_API_WORKERS` entry per engine and rejects
duplicate engine names. Therefore a second VM in the same region cannot yet be attached
as a concurrent replica to add capacity. For a replacement, update that one engine's
`baseUrl` and token in central `AGENT_API_WORKERS`; keep
`AGENT_API_ENGINE_CHAIN=eu-vm-agent-run,rf-vm-agent-run,azure-dynamic-ip-agent-run`.
The scheduled GitHub drift check also has one URL/token pair per region, so update the
matching `EU_VM_WORKER_*` or `RU_VM_WORKER_*` repository secrets to the replacement.
Adding multiple same-region VMs requires a router change that models endpoints under a
single regional engine and selects among their health/capacity; do not assign a fake
engine name to bypass the duplicate check.

Prerequisites: Node.js 20+, systemd, GitHub CLI (`gh`), curl, an authenticated
read-only GitHub token for release/attestation reads, an installed OpenCode binary,
outbound access to the configured GCS bucket, and a TLS reverse proxy or equivalent
HTTPS endpoint in front of the loopback listener. Keep port 8788 private; expose only
through the trusted HTTPS endpoint. Do not put the worker token in command-line arguments.

Bootstrap from a reviewed checkout and select the immutable release plus region:

```bash
sudo scripts/install-vm-worker.sh vm-worker-v0.3.1 france
sudoedit /etc/ai-agent-runner/worker.env
sudoedit /etc/ai-agent-runner/worker-bindings.json
export GH_TOKEN # inject from the operator secret manager, not command history
sudo --preserve-env=GH_TOKEN /usr/local/sbin/ai-agent-vm-worker-update vm-worker-v0.3.1
unset GH_TOKEN
sudo systemctl enable --now ai-agent-vm-worker
```

Use `russia` for the Russia host. The bootstrap creates separate France/Russia templates,
installs the systemd unit and updater, and stops before deployment while placeholders
remain. `GH_TOKEN` is needed only for an update command; keep it in an operator secret
store or short-lived shell environment, not the worker service env file.

Each release is built from a tag that must already be reachable from `main`. GitHub
Actions publishes a Linux bundle and SHA-256 checksum, then creates a keyless SLSA
provenance attestation. The updater checks the checksum, verifies the attestation's
repository, signer workflow and tag ref, unpacks into a commit-specific directory,
switches the `current` symlink atomically, restarts systemd, and verifies `/version`
matches the exact source SHA and `/readyz` is healthy. A restart, liveness, readiness,
or source SHA failure restores the previous symlink and restarts the previous release.
Do not deploy a checkout or manually replace files in `current`.

Set the region-specific `VM_WORKER_ENGINE` to `eu-vm-agent-run` or `rf-vm-agent-run`.
Set `AGENT_API_ENGINE_CONFIG_DIR` to the root-owned engine template directory. The France
template pins OpenCode to `ladder/free`; only the run-scoped `LLM_LADDER_TOKEN` enters the
agent environment. The worker refuses to start when its OpenCode template is absent.
Set a unique `VM_WORKER_ID`, public HTTPS origin, a random `VM_WORKER_TOKEN` of at
least 24 characters, the central API callback origin, approved repositories/environment
names, GCS bucket, OpenCode path, and CPU/RAM reservation percentages. The configured
per-run CPU and memory envelope must each be positive and below 60%. Keep the env file
root-owned with mode 0600; the service runs as `ai-agent` and cannot read that file
directly after systemd has loaded it.

`VM_WORKER_ALLOWED_CALLBACK_ORIGINS` allowlists the API origin. Callback URLs may include
the API's reverse-proxy base path (for example, `/profile-api`); the worker still requires
the exact run-bound `/v1/worker/launches/{runId}/result` or `/profile-changes` suffix.
Configure the proxy to forward both paths, preserving the prefix-stripped API route and
HTTP method. Do not rewrite the run ID or callback endpoint.

The installer leaves the service stopped while the example env file still contains
placeholders. Protect `/var/lib/ai-agent-runner` as private persistent disk. Retain at
least the current and previous commit directories under `/opt/ai-agent-vm-worker/releases`
for rollback.

## Health and run tracking

- `GET /healthz` is unauthenticated liveness only. HTTP 200 means the process answers.
- `GET /version` reports the deployed worker release/source commit, bundled OpenCode
  version/source commit/binary SHA-256, and value-free binding inventory. The scheduled
  GitHub drift workflow verifies the latest stable signed worker release and compares all
  reported identities with the deployed VM; mismatch or missing identity is emitted as a
  warning annotation with expected and actual release metadata. It observes drift but does
  not install releases; updates still use the signed operator updater until a restricted
  automatic deployment identity is implemented.
- `GET /readyz` is unauthenticated readiness. HTTP 200 means Runner, OpenCode, the
  capacity store, and a fresh whole-host sample are available with room under the 60%
  admission threshold. HTTP 503 removes the worker from new-run routing. Its JSON
  identifies each check, current CPU/RAM, projected load, and active reservations.
- `POST /v1/launch` uses `Authorization: Bearer <VM_WORKER_TOKEN>` and returns a
  receipt after durable admission; the receipt alone does not prove process start.
- `GET /v1/runs/{runId}/status` reports accepted/running/terminal state;
  `GET .../result` returns the terminal result; `GET .../logs?after={sequence}` provides
  replayable stdout/stderr SSE; `POST .../cancel` requests cancellation.

Status JSON also includes the exact Runner state so the Cloudflare coordinator can
distinguish accepted/starting from a process that has reached `running`. For bounded
background reconciliation, `GET .../logs?after={sequence}&snapshot=1` returns up to
100 replayable stdout/stderr records and the next sequence cursor. Each returned
message is capped at 16,000 characters; the existing SSE route remains unchanged.

The result includes `exitObserved` independently from `exitCode` and `exitSignal`. During
cancellation, OS process-tree polling can confirm that the process ended even if the engine's
exit callback was lost and no code or signal is available. Do not infer process termination
from `exitReason: cancelled` by itself.

Example operator checks (run on the VM; use the public HTTPS host for external checks):

```bash
sudo systemctl status ai-agent-vm-worker
sudo journalctl -u ai-agent-vm-worker --since '15 minutes ago' --no-pager
curl -fsS https://worker.example.net/healthz
curl -i https://worker.example.net/readyz
```

For a specific run, use the `runId` from the Agent API receipt to query the worker's
status/result and subscribe to its logs. A ready VM only proves it can accept a run;
the run status/result is the evidence that the agent actually started and finished.
On restart, queued runs are failed closed instead of relaunched with missing
memory-only credentials. Already-running child processes are reconciled by Runner
recovery, and capacity reservations stay active until terminal state is observed.

The Cloudflare Runner API selects the France VM worker for these sandbox lanes. A VM only
answers its own health/capacity and runs accepted work; it never routes to another VM or GHA.
These lanes do not fall back to GitHub Actions when France is unavailable.

The signed release workflow can deploy that same verified bundle to the France sandbox.
It uses a dedicated forced-command SSH key restricted to `update vm-worker-vX.Y.Z`; a
short-lived GitHub release-read token is supplied on stdin and is not persisted on the VM.
Before changing versions, the updater waits for `/readyz` to report zero active runs and
reservations. The cloud workflow retries only this busy state, then checks `/healthz`,
`/version` and `/readyz` after restart and rolls back on failure. Re-running a release
already installed with matching worker and OpenCode hashes is a no-op. This automation
targets only the France sandbox, not Russia or production, and does not require a
workstation scheduler.

This drift check is deliberately narrower than product migration acceptance. See
[VM-WORKER-LEGACY-COMPATIBILITY.md](VM-WORKER-LEGACY-COMPATIBILITY.md) and
[architecture issue #174](https://github.com/trained-assist/trained-agent-architecture/issues/174):
legacy Web/Telegram routes and the new CP → Runner → Host contour must be audited and
accepted separately. A VM version match does not prove no legacy dependency exists.
