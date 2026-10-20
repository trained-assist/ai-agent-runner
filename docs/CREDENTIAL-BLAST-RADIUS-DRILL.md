# Credential blast-radius drill

## The question

A run can bind a credential that the user granted once. The request carries a
reference and a scope, never a value; the host resolves the value at dispatch
and hands it to the agent in the engine's process environment
([trusted runtime](CLOUDFLARE-RUNNER-API.md#run-credential-bindings)).

That mode cannot stop the agent from writing the value down. Nothing in this
repository can: the value is in the agent's environment, and the agent is the
thing we do not trust. So the drill does not ask "can the value leak?" — it
asks two questions it can answer with measurements:

- **Where does the value end up?** Every place it reaches is a radius.
- **What survives the host dying?** The custody, the host's disk, the run
  record, and the artifacts that leave the host.

The drill is the evidence for the containment claims in
[CLOUDFLARE-RUNNER-API.md](CLOUDFLARE-RUNNER-API.md#run-credential-bindings).
A claim without a measurement is not a claim; this document records what was
measured, when, and what the measurement does not cover.

## What the drill does

Two runs on the lane under test. The value never leaves the drill process: it
is compared by exact value inside the process, and the report contains only
booleans, counts and hashes.

**Phase A — the leak radius.** The agent is asked to persist the credential in
the middle of the run. The drill reads the value out of the engine's
environment on the host (`/proc/<pid>/environ`), and plants a copy in the run's
workspace when the agent did not write one — the radius of a copy that exists
does not depend on who wrote it, and the report says who did. The run then
finishes normally.

| Step | What it proves |
| --- | --- |
| The API accepts a run that binds the credential | the binding path works end to end |
| The value reaches the agent's environment | the host resolved and delivered it |
| The run finishes | the delivery did not break the run |
| The value is not in the run record, the status or the events | the record is value-free |
| The value is not in the runner log, the run state or the session transcript | the per-run persistence paths are value-free |
| The host counts the hosts that received the value | the radius is a number: one delivery, and the custody recognised no repeat |
| The copy does not survive the run on the host | the workspace is swept when the run ends |
| The published profile carries the file without the value | the publication path is value-free: the drill reads the published bytes back and compares them, it does not trust the manifest |

**The publication step reads the bytes back.** The lane publishes the agent's
files through its own profile workspace: the worker uploads them to the lane
with a run-scoped capability, and the lane serves them back. The drill does not
trust the manifest — it fetches the published bytes and compares them. The
digest of the bytes must equal the digest in the manifest, the bytes must carry
the redaction marker, and they must not carry the value. A manifest that hashes
correctly while the bytes carry the value would be a passing test of nothing.

**Phase B — the kill.** The second run repeats the delivery, and the drill
SIGKILLs the worker's whole control group while the run is alive: the worker,
the engine it spawned and the MCP servers it started. That is what "the host
died" means — a power cut, not one process exiting.

| Step | What it proves |
| --- | --- |
| The kill landed on a run that was still alive | the measurement is of a death, not of a normal exit |
| The copy on the dead host is swept by the recovery | the recovery removes the run's leftovers; the kill itself removes nothing |
| The outcome of the run whose host died | measured, not judged — see below |
| The custody store is independent of the host | the value outlived the host, and the journal kept one grant for the run |

The outcome of a killed run is a **measurement**, not an assertion. The
coordinator is designed to survive an unreachable worker and may hand the run
to another host; then the run succeeds and the value is delivered to a second
host. That is the radius growing, and the drill counts it — but the two sides
count different things, and the drill reports both:

- the **custody** records one grant per run. A repeat request is the same
  grant, so the journal does not grow, and the journal says how many runs
  consumed the value;
- the **host** counts the deliveries: how many workers received the value in
  their launch, and how many of those the custody recognised as the same
  grant. That is the radius.

The radius also has an end in time. A credential may carry a lease, and the
custody owns it: once the lease has ended the custody refuses to hand the
value out again, so a re-dispatch after that point delivers nothing. The
refusal is `CREDENTIAL_LEASE_EXPIRED` and the run fails closed with it. A
credential without a lease has no such end — it lives in the custody until it
is revoked.

## Running it

The drill needs the API of the lane, the host it runs on, and (optionally) the
custody database.

```sh
RUNNER_API_URL=https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev \
RUNNER_API_KEY_AGENT_API="$(cat "$E2E/run-binding-key")" \
VM_HOST=169.58.15.230 VM_SSH_KEY=~/.ssh/id_vm2_sandbox \
CF_TOKEN="$(security find-generic-password -s cloudflare.com -a trained-assist-sandbox -w)" \
CUSTODY_ACCOUNT_ID=d740a05e9442c1d0feacae2dfc673e93 \
CUSTODY_DATABASE_ID=9c140ceb-62ae-4f6f-8e18-8b2a08429d51 \
WALLET_API_URL=https://zerocreds-wallet-api-runner-sandbox.skillset-apply.workers.dev \
node scripts/sandbox3-credential-blast-radius.mjs
```

| Variable | Meaning |
| --- | --- |
| `RUNNER_API_URL`, `RUNNER_API_KEY_AGENT_API` | the lane under test and its principal key |
| `VM_HOST`, `VM_SSH_KEY`, `VM_SSH_USER` | the host that runs the worker |
| `VM_WORKER_SERVICE`, `VM_RUNNER_ROOT` | the host's coordinates: the systemd unit and the runner's data root (defaults: `ai-agent-vm-worker.service`, `/var/lib/ai-agent-runner`) |
| `CREDENTIAL_REF` | the registry ref to drill (default: the registry's `github`) |
| `CF_TOKEN`, `CUSTODY_ACCOUNT_ID`, `CUSTODY_DATABASE_ID` | the custody journal; without them the custody step is skipped |
| `WALLET_API_URL`, `WALLET_SERVICE_TOKEN` | the wallet that owns the value; needed only to revoke at the end |
| `DRILL_WAIT_MS` | how long a run may take (default 900000). It is also the timeout limit the run is created with |
| `DRILL_KILL=0` | skip the kill phase (the leak radius alone) |
| `DRILL_REVOKE=1` | revoke the drilled credential at the end. The revocation destroys the value, so the lane loses that credential until a new value is minted |

**The drill is destructive on the host it measures.** It kills the worker's
control group with SIGKILL. The worker restarts (systemd `Restart=on-failure`),
but every run on that host dies with it. Point it at a sandbox worker, not at
a host that serves anything else.

The deterministic part lives in CI:
`test/sandbox3-credential-blast-radius.test.ts` runs the same drill against a
fake host and a fake API, and pins the parts that must not rot — the shell
quoting, the cgroup kill command, the environment parsing, and the rule that
the report never contains the value.

## What the drill does not prove

- **It does not prove that the value cannot leak.** In trusted-runtime mode the
  value is in the agent's environment; an agent that writes it down leaks it.
  The drill measures how far that leak reaches and whether the leftovers are
  cleaned up. A run that needs the value to stay out of the agent process needs
  the broker mode.
- **It does not cover the exfiltration phase yet.** The drill has no sink to
  send the value to: the lane has no browser MCP attached
  ([#479](https://github.com/trained-assist/ai-agent-runner/issues/479)). The
  measurement is one-sided — the drill proves where the value does *not* end up.
- **It does not cover the archive upload.** The session log export needs a
  signed URL, which the R2 backend cannot produce, so on this lane the export
  does not happen at all
  ([#485](https://github.com/trained-assist/ai-agent-runner/issues/485)). The
  transcript is checked on the host, where it is written already redacted.
- **It does not cover the git publication path.** The GitHub Actions lane
  publishes the agent's files without redaction
  ([#471](https://github.com/trained-assist/ai-agent-runner/issues/471)). The
  Runner API lane publishes through its own profile workspace, where the
  published bytes are edited by value before they leave the host.

## The measured run (2026-10-20, worker 0.3.47, France sandbox worker, Runner API f91b7509)

```
ok   A: the Runner API accepts a run that binds the credential — run_32faff21bdb659a12fa9627ce31b84d3cf17432f8f72f37dc37ccbc6fd81faf0_2b87898dd8634374acc63873
ok   A: the credential reaches the agent in its environment, and only there — value=sha256:8b6715b585cd536f
ok   A: the run finishes — state=succeeded
ok   A: the value does not reach the run record, the status or the events — value-free
ok   A: the host counts the hosts that received the value — deliveries=1 repeats=0
ok   A: the value does not reach the runner log, the run state or the session transcript — value-free
ok   A: the copy does not survive the run on the host — the workspace was swept
ok   A: the published profile carries the file without the value — published without the value (10 bytes, sha256 017ad73325fcf108)
ok   B: the Runner API accepts the second run that will be killed — run_8224c45b839f9f6bbdccc250491474bc0f43c6066fb7403b29122d62f9545429_4de008e02f704a0180af29c5
ok   B: the credential is in the engine environment and the copy is on the disk — value=sha256:8b6715b585cd536f
ok   B: the host dies mid-flight: the worker is SIGKILLed — the worker control group is dead
ok   B: the copy on the dead host is swept by the recovery, not by the kill — the workspace copy is gone
ok   B: the outcome of the run whose host died — state=failed
ok   B: the custody store is independent of the host — the custody outlived the host
```

The published file was read back from the lane after the run
(`GET /v1/runs/{runId}/profile-changes?path=blast/leak.txt`): 10 bytes, sha256
`017ad73325fcf108a972edac618f9edfc957c5b1de10f8b371b0a8bfa4f59e2d` — the same
digest the manifest and the response header carry. The bytes hold
`[redacted]` and no token-shaped string. The agent wrote the value; the profile
that landed holds the marker.

On the host, the killed run ended as `workerCrashed: true`, `exit observed:
false`, and its checkpoint as `cleanup: completed` — the recovery removed the
workspace, engine and MCP socket, and the custody journal kept exactly one
grant for that run.

## What the drill found

- **A blocked sweep leaves the workspace on disk.** When the worker cannot
  unlink something inside the workspace, the run's result says
  `cleanup: pending` with the exact reason — it does not claim the workspace
  is gone. But nothing collects it afterwards
  ([#486](https://github.com/trained-assist/ai-agent-runner/issues/486)).
- **The sweep is a point event, not a state.** Anything that lands in the
  workspace after the sweep stays on the host forever, with no run record and
  no checkpoint pointing at it. The drill found this by planting a copy a few
  milliseconds after the run had already swept its own workspace
  ([#486](https://github.com/trained-assist/ai-agent-runner/issues/486)).
- **A re-dispatch hands the value out again.** The coordinator resolves the
  credential on every dispatch attempt, so a run that is handed to another host
  after a kill is delivered the value once more. The custody now records one
  grant per run, and the host counts the deliveries, so the growth of the
  radius is a number rather than an inference from the journal
  ([#478](https://github.com/trained-assist/ai-agent-runner/issues/478)).
- **A stored value never expires by itself.** The custody keeps the value until
  it is explicitly revoked; a lease is the exception, and it is the custody
  that owns it — once the lease has ended the custody refuses to hand the
  value out again ([#477](https://github.com/trained-assist/ai-agent-runner/issues/477)).

The drill's own defects were fixed as they appeared; the history is in
[#472](https://github.com/trained-assist/ai-agent-runner/pull/472),
[#476](https://github.com/trained-assist/ai-agent-runner/pull/476),
[#481](https://github.com/trained-assist/ai-agent-runner/pull/481),
[#484](https://github.com/trained-assist/ai-agent-runner/pull/484) and
[#488](https://github.com/trained-assist/ai-agent-runner/pull/488).

## Related

- [Cloudflare Runner API](CLOUDFLARE-RUNNER-API.md) — how the credential is
  delivered, and what is redacted.
- [Credentials](CREDENTIALS.md) — which keychain items exist and how secrets
  are read.
- [VM worker operations](VM-WORKER-OPERATIONS.md) — the host the drill
  measures.
