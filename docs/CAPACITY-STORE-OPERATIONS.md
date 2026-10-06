# File capacity store operations

`FileCapacityReservationStore` is a single-host store. It keeps every operation ID, including released records, so retries remain idempotent. It never evicts records automatically. To keep whole-file validation and atomic replacement bounded, it refuses mutations once the store reaches 10,000 reservations or 8 MiB. At that point admission fails closed until an operator performs an explicit, reviewed migration that preserves the idempotency history.

## Recovering an ambiguous lock

A lock at `<state-file>.lock` makes transactions fail closed after the configured wait. The `owner` file contains JSON with `version`, opaque `token`, `pid`, `hostname`, and `startedAt`. These fields are diagnostic only: a PID may have been reused, and a different host/container namespace can make process checks misleading. The store deliberately does not steal a lock based on age or metadata.

Recovery is a maintenance operation:

1. Stop the worker service and verify no process on the state file's host can still be inside a capacity-store transaction. Keep the service stopped throughout recovery.
2. Inspect the lock metadata and confirm the recorded process is gone or belongs to a prior boot. If that cannot be established, leave the lock in place and escalate; do not remove it based only on age.
3. Back up the state file and lock directory together. Verify the state file parses as schema version 1 and has unique operation IDs; preserve every reservation, active and released.
4. Remove only the stale `<state-file>.lock` directory, then restart one worker and verify a read-only transaction succeeds before restoring normal traffic.

Do not delete released reservations to make room: that would allow an old operation ID to launch a second process. Any future compaction requires an explicit idempotency horizon and a migration that proves old IDs cannot be retried.
