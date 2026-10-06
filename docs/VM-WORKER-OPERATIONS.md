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

The slice does **not** yet publish `agent-run/<runId>` to the user's GitHub repository:
the returned result deliberately has `repo.commit: null`. GCS storage wiring is
configured, but that does not replace Git branch publication or prove that user data
was persisted. Do not route production user work here until branch creation/push,
artifact references, and API-side merge/persistence are integrated and tested.

## Install on a Linux VM

Prerequisites: Node.js 20+, systemd, GitHub CLI (`gh`), curl, an authenticated
read-only GitHub token for release/attestation reads, an installed OpenCode binary,
outbound access to the configured GCS bucket, and a TLS reverse proxy or equivalent
HTTPS endpoint in front of the loopback listener. Keep port 8788 private; expose only
through the trusted HTTPS endpoint. Do not put the worker token in command-line arguments.

Bootstrap from a reviewed checkout and select the immutable release plus region:

```bash
sudo scripts/install-vm-worker.sh vm-worker-v0.2.0 france
sudoedit /etc/ai-agent-runner/worker.env
sudoedit /etc/ai-agent-runner/worker-bindings.json
export GH_TOKEN # inject from the operator secret manager, not command history
sudo --preserve-env=GH_TOKEN /usr/local/sbin/ai-agent-vm-worker-update vm-worker-v0.2.0
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
switches the `current` symlink atomically, restarts systemd, and verifies `/version`.
If liveness or the source SHA is wrong, it restores the previous symlink and restarts
the previous release. Do not deploy a checkout or manually replace files in `current`.

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
