# Own connector trusted release — proposal, not deployed

Production security gate remains open: the current own QuickTunnel executes
cloudflared from a sandbox-owned `/opt/sb` ancestor. Runner UID12079/root-release
acceptance does not cover the connector executable. Do not change shared ownership.

Read-only metadata observed on 2026-10-05: own unit
`ta-integrator-native-tunnel-v1.service`, dedicated user/group
`ta-integrator-native-tunnel-v1`, active PID205443, origin port18879, binary version
2026.9.3 and `--token-file` support. This is not executable provenance proof.

## Official pin and offline guard

Official [2026.9.3 release](https://github.com/cloudflare/cloudflared/releases/tag/2026.9.3)
asset metadata was read without downloading assets:

| Linux architecture | Asset | SHA256 |
| --- | --- | --- |
| x86_64 / Node x64 | cloudflared-linux-amd64 | 77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2 |
| aarch64 / Node arm64 | cloudflared-linux-arm64 | aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d |

`own-cloudflared-release.mjs` defaults to a no-op plan. Its root-only `verify`
command reads a root-owned 0600 regular single-link non-symlink input, checks
Linux/architecture, exact digest and ELF64 headers without executing it. It refuses
PT_INTERP/PT_DYNAMIC; dynamic assets need a separate trusted loader/library audit,
not `ldd` execution of an untrusted binary. Actual official asset static linkage
has not been established: no binary was downloaded. Tests use synthetic headers
and deliberately cannot pass the official checksum gate.

## Parent-authorized staging recipe (not executed)

1. Obtain explicit staging authorization. Parent obtains only the matching pinned
   official asset into a fresh root-private directory; no shared credentials or
   tunnel resources are needed. Capture failure output privately.
2. Run root verifier against that 0600 input. Refuse architecture/checksum/linkage
   mismatch; never run the old or downloaded binary merely to establish provenance.
3. Reuse `verifyRootAncestors` to check `/opt` and every existing destination
   ancestor. Fresh root-only staging is under
   `/opt/ta-integrator-cloudflared-releases/2026.9.3-<asset>-<sha256>.staging`.
   No symlinks, overwrite or shared chown. Copy verified bytes once; verify copied
   digest again, root ownership and 0755 executable/directory permissions; fsync
   binary/directory and atomically publish the fresh final release. Verify its full
   tree and ancestors again. No service manager operations during staging.
4. Keep a future root-owned drop-in **outside** the systemd load path for review.
   Snapshot exact own unit argv privately. Candidate override resets `ExecStart`
   and replaces only argv[0] with the trusted release binary. Preserve every
   original own QuickTunnel argument and the dedicated connector identity.
   Do not install the drop-in or reload/restart yet. Staging preserves PID/URL but
   does not make the already-running process trusted.

## Running executable proof and later cutover

Parent read-only proof must pin the current own systemd MainPID, start-time and
process identity before/after inspecting `/proc/<PID>/exe`. Hash the opened live
executable descriptor, not only the pathname on disk; compare with the official
asset and inspect ELF linkage with the same guard. A deleted exe, identity race,
wrong SHA or dynamic linkage leaves the gate open. Inspect file ownership and all
binary ancestors separately: matching official bytes alone does not fix a writable
replacement path. No running-executable proof was performed by this source task.

Later apply requires independent source/operational review, parent assignment,
fresh sealed/quiescent admissions, private argv/unit snapshots and legacy PID
baseline. Only the own connector may change. Restarting a QuickTunnel can change
its URL: do not claim URL-preserving activation. Named-tunnel parallel rollout can
instead use the trusted binary and private tunnel-token file while leaving the
current QuickTunnel process alive; hostname/DNS/tunnel authorization remains a
separate gate. No global `cloudflared service install` or shared tunnel edits.

Rollback of a future named connector stops only that new connector and restores
the privately snapshotted CP/Runner routing under fresh quiescence. Existing
QuickTunnel remains the fallback. Re-executing the old untrusted binary is not a
security rollback. Confirm callback/status/result/artifact identities and legacy
continuity before reopening ingress. None of staging, cutover, executable proof,
DNS creation, connector rollback or transport promotion has occurred in this task.

Offline checks:

```sh
node --check scripts/integration/own-cloudflared-release.mjs
node --test scripts/integration/own-cloudflared-release.test.mjs
```
