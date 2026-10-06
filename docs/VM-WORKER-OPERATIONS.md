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

Profile-backed tasks use the existing durable workspace contract: the API pins a base
commit and supplies a scoped publication token plus the heavy-artifact manifest. Before
OpenCode starts, the VM checks out that exact revision on `agent-run/<runId>`, verifies
and materializes heavy artifacts from GCS, and removes files excluded by the shared
profile policy. On completion, it publishes allowed small files to the run branch,
uploads heavy files to GCS with read-back checksum verification, writes the artifact
index, and returns the confirmed commit in `repo.commit`. The API validates and merges
that branch through its existing compare-and-swap publication coordinator.

The token is memory-only, passed to Git through a static askpass helper, and never put
in Git arguments or durable RunSpec state. The publisher resets `origin` to the trusted
repository URL before fetch/push, verifies the pinned revision and run branch, and uses
a private Git index so a broad staging command cannot include credentials. If
publication fails, the VM retains the run workspace and returns no commit; the API
reports publication as pending/unknown rather than claiming that user data was saved.
Runs without a profile workspace continue to return `repo.commit: null`.

Task-scoped Control Plane `ingressManifest` pins now pass through the external-worker
request into Runner. Configure `RUNNER_CONTROL_PLANE_URL`,
`RUNNER_CONTROL_PLANE_PRINCIPAL`, and `RUNNER_CONTROL_PLANE_PRINCIPAL_SECRET` together
when using this capability. With all three absent, ordinary runs remain available but
a run carrying an ingress manifest fails closed before OpenCode starts; a partial
configuration prevents worker startup. Ingress input materialization and profile
workspace publication are separate capabilities.

## Install on a Linux VM

Release delivery and service lifecycle are separate processes. GitHub Actions builds
and signs an immutable release; `ai-agent-vm-worker-update <tag>` verifies and installs
that release, switches the versioned symlink, restarts systemd, and rolls back if the
new process is not ready. `ai-agent-vm-worker.service` owns the long-running worker.
`install-vm-worker.sh` is only a one-time bootstrap for the service account, unit,
configuration templates, and updater. There is currently no automatic VM rollout or
VM self-deployment: the operator invokes the updater after reviewing a release.

Before enabling a worker, detect and record the full configuration group: region and
worker ID; `VM_WORKER_PUBLIC_URL`, `VM_WORKER_ENGINE`, `VM_WORKER_TOKEN`; bind address
and port; CPU/RAM admission limits; GCS bucket and attached workload identity; OpenCode
binary path; approved repositories and environments; and, when ingress manifests are
used, all three `RUNNER_CONTROL_PLANE_*` bindings. Check values locally on the host,
but publish only presence, source/store path, owner, and rotation metadata. Never print
secret values. The updater requires `VM_WORKER_PUBLIC_URL` to be a valid HTTP(S) origin
before it changes the active release.

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
Set a unique `VM_WORKER_ID`, public HTTPS origin, a random `VM_WORKER_TOKEN` of at
least 24 characters, the central API callback origin, approved repositories/environment
names, GCS bucket, OpenCode path, and CPU/RAM reservation percentages. The configured
per-run CPU and memory envelope must each be positive and below 60%. Keep the env file
root-owned with mode 0600; the service runs as `ai-agent` and cannot read that file
directly after systemd has loaded it.

The installer leaves the service stopped while the example env file still contains
placeholders. Protect `/var/lib/ai-agent-runner` as private persistent disk. Retain at
least the current and previous commit directories under `/opt/ai-agent-vm-worker/releases`
for rollback.

## Health and run tracking

- `GET /healthz` is unauthenticated liveness only. HTTP 200 means the process answers.
- `GET /version` reports the deployed version/source commit and the value-free binding
  inventory for periodic deployment drift checks.
- `GET /readyz` is unauthenticated readiness. HTTP 200 means Runner, OpenCode, the
  capacity store, and a fresh whole-host sample are available with room under the 60%
  admission threshold. HTTP 503 removes the worker from new-run routing. Its JSON
  identifies each check, current CPU/RAM, projected load, and active reservations.
- `POST /v1/launch` uses `Authorization: Bearer <VM_WORKER_TOKEN>` and returns a
  receipt only after durable admission and Runner start.
- `GET /v1/runs/{runId}/status` reports accepted/running/terminal state;
  `GET .../result` returns the terminal result; `GET .../logs?after={sequence}` provides
  replayable stdout/stderr SSE; `POST .../cancel` requests cancellation.

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

The API remains responsible for worker ordering and failover. A VM only answers its
own health/capacity and runs accepted work; it never routes to another VM or GHA.

This drift check is deliberately narrower than product migration acceptance. See
[VM-WORKER-LEGACY-COMPATIBILITY.md](VM-WORKER-LEGACY-COMPATIBILITY.md) and
[architecture issue #174](https://github.com/trained-assist/trained-agent-architecture/issues/174):
legacy Web/Telegram routes and the new CP → Runner → Host contour must be audited and
accepted separately. A VM version match does not prove no legacy dependency exists.
