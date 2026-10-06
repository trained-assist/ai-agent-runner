# Capacity admission design for issue #137

## Finding

Do not implement the 60% CPU / RAM rule inside the current API process. The API is a
control plane which forwards `POST /v1/launch` to remote workers:

- `src/api/server.ts` sends a submit request to `AgentApi.submit`.
- `src/api/service.ts` resolves configured engine names and calls
  `worker.launch(...)`; it has no process execution or host resource sampler.
- `src/adapters/external-worker-adapter.ts` sends the launch request to a remote URL.
- `src/api/main.ts` creates only these external adapters and the API server.

Therefore a CPU/RAM sample in the API would describe the API host, not the France or
Russia VM. An in-memory mutex there would also fail to coordinate multiple API processes
or a worker restart. A preflight query followed by a separate launch has a race and
cannot constitute an atomic reservation. The API must not synthesize remote readings.

## Required ownership and protocol

Capacity admission belongs on each VM, at the same boundary that accepts and registers a
launch, before it starts the agent. The worker must measure the whole host (including
services outside Runner), and it must serialize `sample → decision → reservation →
register operationId` using a host-wide lock shared by all worker processes. Reservation
state must survive process restart or be reconciled against active operation IDs and
agent process trees. A per-process mutex is insufficient if the VM can run more than one
worker process.

For a new operation, the worker should atomically:

1. Read fresh whole-host CPU and memory usage. Reject admission when either is at or
   above 60%, or when admitting the configured run resource envelope would violate the
   40% headroom policy.
2. Persist a reservation tied to `operationId` and register the run before acknowledging
   acceptance. Duplicate `operationId` requests return the existing receipt and do not
   reserve twice.
3. Release the reservation only after the run is terminal and its processes are gone.

Stale/unavailable metrics and an unavailable reservation store must fail closed for VM
admission. Return a structured, definitive pre-accept response such as HTTP 503 with
`code: WORKER_CAPACITY` and measured values/sample timestamp when available. Do not include
credentials or environment values. A capacity refusal must guarantee the operation was
not registered or started, so the API can route the new run directly to the next worker.
If acceptance is uncertain, preserve the existing reconcile-before-failover rule; never
start a second copy merely because a capacity response or connection was ambiguous.

The API's normal configured order should be France → Russia → GitHub Actions. A confirmed
`WORKER_CAPACITY` refusal at or above the 60% CPU or RAM limit skips any remaining regional
VM and sends that new run directly to GitHub Actions, preserving the 40% headroom for other
host services. Unknown capacity or admission availability does not prove saturation and
continues through the configured order. Once any worker accepts, capacity changes do not
preempt or migrate that run. In Russia the existing regional engine policy must independently
limit execution to OpenCode.

## Open implementation inputs

The repository does not define a resource envelope per run, a host metrics source, worker
acceptance implementation, or a shared reservation store. Before coding the worker-side
gate, decide how the run envelope is set (fixed conservative maximum or measured profile),
which Linux host metrics are authoritative, and how the lock/reservation survives worker
restart. These values cannot be inferred from API load or the number of active runs.

## Acceptance checks

- With two simultaneous launch requests and host usage below threshold, the shared gate
  serializes them and does not admit a combination that violates the configured headroom.
- CPU at 60% or above, or RAM at 60% or above, produces a definitive refusal before
  registration; the router reaches the next configured worker.
- A stale/failed sampler or failed reservation write refuses the VM launch.
- A duplicate `operationId` returns one existing run and one reservation.
- A lost launch response is reconciled before failover; no duplicate run starts.
- A run accepted before load rises continues to terminal completion and releases its
  reservation only after its process tree exits.
- Tests include unrelated host load so the measurement cannot accidentally report only
  Runner child processes.
