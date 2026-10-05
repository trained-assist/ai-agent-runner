# Own native Runner Unix identity cutover

Source-only tooling for architecture #140. **Not executed or VM-validated.**
Default `plan` does not inspect a VM, read credentials or change anything.
Do not run the existing general `deploy-api-service.sh`: it targets the legacy
unit/configuration and is not this cutover procedure.

## Scope and prerequisites

Only `ta-integrator-runner-native-v1.service` on loopback 18879 is eligible.
Legacy services/users/groups remain untouched, including `sandbox` UID/GID 1002.
The new account is `ta-integrator-native-v1`; parent chooses an unused UID/GID
in 10000..60000. It gets no supplementary sandbox group, login shell or home.
The tool never recursively chowns code, dependencies, shared configuration,
old journals or Google vaults. No UID switch, restart or credential provisioning
is authorized by preparing these files.

Before a later **explicit parent authorization**:

1. Block new submissions at the owning ingress/CP/Runner access boundary. The
   script does not change gateway routing, firewall or proxies for you.
2. Reconcile **every** admission in the current own journal against authenticated
   Runner/native results. Require terminal succeeded/failed/cancelled with observed
   exit; unknown, interrupted, missing, undispatched or in-flight runs block.
   Historical "three runs terminal" does not cover the new Telegram CSV run.
   `/healthz` counts and an admission/dispatched journal are not terminal proof.
3. MCP must remain disabled. Existing bindings/listeners/vaults are not migrated.
4. Own code, build and dependencies must be root-owned/read-only to non-root;
   symlink targets must stay inside the own code directory. If node_modules points
   to legacy/shared dependencies, stage an independent public dependency tree
   first, without chowning that shared tree. The cutover refuses this situation.
5. Own unit must still use its one existing combined EnvironmentFile, original
   own key registry/journal and User/Group sandbox. Other configuration refuses
   rather than guessing. Record the current MainPID, verify installed source,
   and keep ingress blocked through post-cutover checks.

## Parent-owned quiescence authorization

Write a fresh root-owned regular nonsymlink `0600` file in a root-owned `0700`
operator directory, with SHA256 of exact journal bytes and one result per admission:

```json
{
  "schemaVersion": "own-native-uid-quiescence-v1",
  "action": "apply",
  "unit": "ta-integrator-runner-native-v1.service",
  "ownerApproved": true,
  "ingressBlocked": true,
  "mcpDisabled": true,
  "targetUid": 12079,
  "mainPid": 12345,
  "checkedAt": "ACTUAL_CURRENT_ISO_TIME",
  "journalSha256": "SHA256_OF_CURRENT_ENTIRE_JOURNAL",
  "runs": [{
    "runId": "ACTUAL_CANONICAL_run_UUID",
    "userTaskId": "ACTUAL_TASK_ID",
    "ownerGeneration": 1,
    "state": "succeeded",
    "exitObserved": true
  }]
}
```

Illustrative IDs/UID are not VM facts. This file is a trusted operator attestation,
**not automatically acquired provider evidence**. Preserve the private authenticated
readback supporting it. Approval is valid for five minutes, the exact action,
MainPID and entire journal hash. New admissions invalidate it. The script checks
the gate before stop and again after stop; it does not infer terminal state from
the journal or automatically cancel/drain running work.

```sh
node scripts/integration/own-native-uid-cutover.mjs plan
# Later only, on the VM, with explicit parent authorization and fresh gate:
sudo /usr/local/bin/node scripts/integration/own-native-uid-cutover.mjs apply "$PRIVATE_GATE"
```

Linux/root apply stops only the own unit, creates the dedicated account, and copies
the exact journal to `/var/lib/ta-integrator-runner-native-own-v1/admission.jsonl`
(new UID, directory 0700/file 0600). It copies the own key registry and combined
environment into `/etc/ta-integrator-runner-native-own-v1` without changing the
originals or rotating any keys. The environment is root-only 0600; the registry
is readable only by the new UID. A private root backup lives under
`/var/lib/ta-integrator-native-uid-cutover-v1`.

Only `90-own-uid.conf` in the own unit's drop-in directory is added: new User/Group,
empty supplementary groups, umask 0077 and the private copied EnvironmentFile.
Endpoint/worker/callback settings are preserved; only own journal and registry
paths change. The tool does daemon-reload/start, not legacy enable/restart. It
checks the actual new process UID and journal preservation. Raw credentials,
environment, stderr, addresses and task text are never printed.

Success is **not health/native/MCP acceptance**. Parent must verify actual service
health, authenticated prior-run result retrieval, unchanged worker/callback
routing, own permissions and legacy unit PID/UID continuity before reopening
ingress. Do not submit a new job merely to validate this switch.

## Rollback without lost admission identity

Any partial failure leaves ingress blocked and requires private operator review;
there is no automatic restart/rollback/new launch. Do not repeat apply after a
partial mutation. Backup/account/directory conflicts deliberately refuse.
An exclusive root-only `/run/ta-integrator-native-uid-cutover-v1.lock` serializes
apply/rollback; a process crash leaves it for operator reconciliation, not removal
or retry based only on an apparently idle service.

For rollback, block ingress again, reconcile **all current new-journal runs**,
and issue a new `action:rollback` gate with current MainPID/hash and the same
target UID. Do not reuse the apply gate or an old three-run snapshot.

```sh
sudo /usr/local/bin/node scripts/integration/own-native-uid-cutover.mjs rollback "$PRIVATE_ROLLBACK_GATE"
```

Rollback stops only the own unit and copies its **latest** journal into a fresh
isolated `/var/lib/ta-integrator-runner-native-rollback-v1` directory, UID/GID1002,
0700/0600. It never reverts to an old admission snapshot and never writes through
the sandbox-owned original journal directory. Original combined environment and
registry must remain byte-identical. The own UID drop-in is replaced with a
journal-only EnvironmentFile override, restoring the inherited sandbox identity
and configuration while retaining every latest admission/idempotency key.
Private backups, dedicated account and new journal remain for review; no shared
ownership changes or account deletion occur. Parent repeats post-cutover checks
before reopening ingress. A second cutover requires a separately reviewed plan.

## Later Google vault boundary

Only after independent UID cutover verification may parent authorize a **new**
private documents runtime owned by this dedicated UID. Provision SA/encryption
material there from its owning host; never chown/reuse a legacy UID1002 vault or
put root/SA credentials in RunSpec, model prompt or MCP headers. This script does
not provision, read, mint, migrate or start Google bindings/domains. A dedicated
service UID does not prove external-engine isolation or provider permissions.

Offline checks (no root, systemctl, SSH, Google, live Runner or vault access):

```sh
node --check scripts/integration/own-native-uid-cutover.mjs
node --test scripts/integration/own-native-uid-cutover.test.mjs
```
