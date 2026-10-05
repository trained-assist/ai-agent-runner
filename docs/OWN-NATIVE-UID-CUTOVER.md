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
4. Stage a new commit-addressed root release using the procedure below. Its code,
   build and dependencies must be root-owned/read-only to non-root; symlink
   targets must stay inside that exact release. Never chown the current tree or
   follow its shared node_modules symlink. The cutover verifies the new release
   and switches only the own unit's WorkingDirectory/ExecStart to it.
5. Own unit must still use its one existing combined EnvironmentFile, original
   own key registry/journal and User/Group sandbox. Other configuration refuses
   rather than guessing. Record the current MainPID, verify installed source,
   and keep ingress blocked through post-cutover checks.

## Independent root release remediation

Read-only inventory on 2026-10-05 found the current own checkout
`/opt/sb/ta-integrator-runner-native-v1` owned by UID1002, directory mode0750.
There were 348 non-root-owned and 347 group/world-writable paths. Both `src` and
`dist` accounted for 107 non-root-owned/writable paths each; `docs` for 43 and
`test` for 54. The one external symlink was root-owned `node_modules`. The own
unit remained active under sandbox, PID205775. This is inventory, not a quiescence
or cutover proof; refresh it before any operational approval.

Remediation creates a separate release at
`/opt/ta-integrator-runner-native-releases/<40-character-source-commit>`.
Every ancestor must be root-owned, non-symlink and not group/world writable.
The shared sandbox-owned `/opt/sb` is never changed or used as a release ancestor.
It never changes the current tree, follows that dependency symlink, or chowns
shared code. Source, compiled build and production dependencies are rebuilt from
the exact reviewed commit and its unchanged package-lock, not copied from the
writable current build. `97956c5bca4a9d6c87d71b826354ab05ab48811d` is the current
reviewed native source baseline; a newer source requires separate review/pinning.

Prepare the public archive locally, excluding the repository's tracked external
dependency symlink. Record its exact SHA256 and the pinned package-lock SHA256;
transfer only this public source to a private root-owned operator directory.

```sh
SOURCE_COMMIT=97956c5bca4a9d6c87d71b826354ab05ab48811d
git archive --format=tar "$SOURCE_COMMIT" -- . ':(exclude)node_modules' > "$PUBLIC_SOURCE_TAR"
shasum -a 256 "$PUBLIC_SOURCE_TAR"
git show "$SOURCE_COMMIT:package-lock.json" | shasum -a 256
node scripts/integration/stage-own-native-release.mjs plan
# Later only: explicit review + parent source-staging authorization on the VM.
sudo /usr/local/bin/node scripts/integration/stage-own-native-release.mjs stage \
  "$ROOT_PRIVATE_SOURCE_TAR" "$SOURCE_COMMIT" "$ARCHIVE_SHA256" "$PACKAGE_LOCK_SHA256"
```

Staging checks root-private nonsymlink input, archive hash, embedded commit and
every tar header/path/type before extraction. Only regular files/directories and
the exact git commit comment are accepted; links, traversal, node_modules and
prebuilt dist refuse. A fresh `.staging` directory is used, never an existing
release. `npm ci --ignore-scripts` installs lock-pinned build dependencies, the
reviewed build scripts produce dist, then another script-disabled ci installs
only production dependencies. The build environment contains no inherited host
credentials/configuration, only local PATH/HOME/npm cache. This requires npm
registry access during later staging, not Google/provider calls.

The stager checks module/dependency loading without running API main, hardens
only newly-created files to root-owned 0755 directories / 0644 nonexecutables,
and rejects links outside the exact release before publishing it. It writes
`root-release.json` with commit/archive/lock/main hashes. Build stdout/stderr stays
in a root-only 0600 sibling log; no raw output or secrets are printed. Incomplete
staging remains for operator review, not automatic deletion/retry. Existing
releases refuse replacement. Staging does not stop/start any unit, provision a
UID, touch journals/configuration/vaults or make Runner submissions.

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
  "releaseCommit": "97956c5bca4a9d6c87d71b826354ab05ab48811d",
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
empty supplementary groups, umask 0077, the private copied EnvironmentFile and
the pinned root release WorkingDirectory/ExecStart. Endpoint/worker/callback
settings are preserved; only own journal/registry and executable paths change.
The tool does daemon-reload/start, not legacy enable/restart. It
checks the actual new process UID, effective routing/MCP-off environment and journal preservation. Raw credentials,
environment, stderr, addresses and task text are never printed.

Before stopping Runner, the tool freezes the original and staged environment
bytes in root-private 0600 files. An inert transient systemd service evaluates
the actual `EnvironmentFile` syntax using `/usr/bin/env -0`, not a shell or a
hand-written dotenv parser. It runs as root (never the shared sandbox UID) with no new privileges, a private
network and read-only system filesystem; it does not launch Runner or a job.
The original environment must itself be root-owned 0600, without symlinks or
non-root/writable ancestors. Before evaluation, the running environment must not
define nonempty loader-control variables. A deliberately conservative byte scan
rejects loader names anywhere in the staged file (including comments/values);
systemd also unsets the enumerated loader variables before executing the parser.
Do not relax this guard to accommodate a token or comment containing a loader name.
Runner/worker/callback/child environment settings must match the checked running
process, except the explicit own journal/registry path changes. Nonempty unit
`Environment`, `PassEnvironment` or `UnsetEnvironment` settings refuse this narrow
recipe. Process-specific HOME/PATH and systemd runtime metadata are not routing
comparison fields. Staged byte hashes are checked before stop and before/after
start; effective post-start routing and MCP-off settings must match the parsed
stage. A failed post-start check stops only the own unit and leaves ingress sealed.
Pre-stop validation failure can leave the private preparation directory; do not
retry automatically. Offline tests do not prove Linux/systemd runtime acceptance.

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
target UID and source release commit. Do not reuse the apply gate or an old
three-run snapshot. The pinned release must still validate.

```sh
sudo /usr/local/bin/node scripts/integration/own-native-uid-cutover.mjs rollback "$PRIVATE_ROLLBACK_GATE"
```

Rollback stops only the own unit and copies its **latest** journal into a fresh
isolated `/var/lib/ta-integrator-runner-native-rollback-v1` directory, UID/GID1002,
0700/0600. It never reverts to an old admission snapshot and never writes through
the sandbox-owned original journal directory. Original combined environment and
registry must remain byte-identical. The own UID drop-in is replaced with a
validated frozen-original EnvironmentFile with a journal override, restoring the inherited sandbox identity,
original executable/working directory and configuration while retaining every
latest admission/idempotency key.
Private backups, dedicated account and new journal remain for review; no shared
ownership changes or account deletion occur. Parent repeats post-cutover checks
before reopening ingress. A second cutover requires a separately reviewed plan.

### Inactive post-apply recovery (source only)

A fresh rollback gate may explicitly set `inactiveRecovery:true` and `mainPid:0`.
All ordinary owner approval, ingress seal, five-minute freshness, exact latest
journal hash, admission/task/generation and independently observed terminal-run
requirements still apply. The own unit must be `inactive/dead`, have MainPID0
and an empty systemd ControlGroup, the dedicated User/Group, exact release cwd
and expected single EnvironmentFile. Active, failed, residual-cgroup or ambiguous
states refuse; this mode is not a general partial-install repair mechanism.

The saved apply state, account, exact own drop-in, original files and frozen
environment byte pins must all still validate. Baseline routing is obtained from
the pinned applied environment through the guarded systemd parser, not a missing
process or operator-supplied routing values. Only `/proc` inspection of the old
process and its redundant stop are skipped. Recovery preserves the latest journal,
uses the frozen original environment, and performs the ordinary post-start checks.
Missing/modified state, environment or incomplete installation refuse. A fresh
operator authorization and independent review are required before any actual use.
No inactive recovery or rollback has been executed as part of the live acceptance.

## Deployment evidence — 2026-10-05

Parent reports successful actual cutover using operational source
`c877ea112d8d88d353afec8d16090f8c47ecdf0e` (PR132), independently reviewed with
51 offline tests. The deployed Runner application is the separately staged
root-owned release `97956c5bca4a9d6c87d71b826354ab05ab48811d`, not the operational
script commit. Its source archive SHA256 is
`e83d83864714907174e196cc44ed08edbb52e7dd282d53bdb552423527999a78`;
package-lock SHA256 is
`b1fe9e8edaf181f2dd6e78e28344d957bac5950c64e9dcebe29ce6a39ab64c93`.

Reported live checks passed: dedicated UID12079, independent Unix boundary,
all four existing CP/native/Runner runs and journal/artifact identities,
callback and unchanged legacy units. Parent removed only the exact own ingress
seal; non-root health returned 200. External Runner health and bot restoration
were still pending at this checkpoint. These are parent-reported live results,
not a live run performed by this source author. Evidence is tracked in
[architecture issue141](https://github.com/trained-assist/trained-agent-architecture/issues/141).

Actual rollback was **not performed**. Deployed c877 operational tools require an
active isolated Runner with its expected PID/environment. The later source-only
inactive post-apply mode above is not deployed or live-validated. Such recovery
requires independent review, a fresh gate and explicit operator authorization;
do not restart, rerun jobs, or claim rollback acceptance.
This cutover proves neither Google/vault access nor external GHA/model sandbox
isolation. No Google vault transfer or Google activation is part of this evidence.

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
node --check scripts/integration/stage-own-native-release.mjs
node --test scripts/integration/own-native-uid-cutover.test.mjs
```
