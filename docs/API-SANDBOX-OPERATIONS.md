# Isolated Runner API sandbox

> **Legacy VM-hosted Node API procedure.** The GitHub deploy workflow is disabled and its
> installers now refuse writes. Current sandbox Runner APIs are Cloudflare Workers; see
> [CLOUDFLARE-RUNNER-API.md](CLOUDFLARE-RUNNER-API.md). This file remains as historical
> operational evidence and must not be used to provision a new VM API lane.

## Repeatable API sandbox creation through GitHub Actions

The manual `runner-api-sandbox-deploy.yml` workflow creates or updates a named
Runner API lane (`sandbox3` through `sandbox5`). A single signed candidate built
with `target=agent-runner-api-sandbox` can be installed into several lanes.
For lane `sandboxN`, the workflow uses a separate GitHub environment
`runner-api-sandboxN` and the VM paths below:

| Resource | Per-lane value |
|---|---|
| API unit | `agent-runner-api-sandboxN.service` |
| Port | `18880 + N` (`sandbox3` = `18883`) |
| Environment | `/etc/agent-runner/agent-runner-api-sandboxN.env` |
| Key registry | `/etc/agent-runner/key-registry-sandboxN.json` |
| Admission journal | `/var/lib/agent-runner/sandboxN/admissions.jsonl` |
| Profile workspace | `/var/lib/agent-runner/sandboxN/profiles` |
| Release root | `/opt/sb/ai-agent-runner-api-sandboxN` |
| API principal/profile | `integration-sandboxN-v1` |

Each GitHub environment has the **same secret names**, with lane-specific values:
`VM2_SSH_HOST`, `VM2_SSH_USER`, `VM2_SSH_PRIVATE_KEY`, `VM2_KNOWN_HOSTS`,
`RUNNER_API_ENV_FILE`, and `RUNNER_API_KEY_REGISTRY_JSON`. The API env must set
that lane's exact port, registry and journal paths, `AGENT_API_ENVIRONMENT=sandbox`,
a lane-specific `AGENT_API_PROFILE_WORKSPACE_ROOT`,
a distinct delegation secret, and a real external worker. The registry must
contain the matching lane principal with `runs:read` and `runs:write`. Keep
these environment secrets restricted to the lane operators; the SSH user needs
only the sandbox API bootstrap/install sudo path. The existing API's credential
for calling a GHA worker does **not** grant GHA SSH or systemd access to `vm2`.
Worker/provider access may use the same approved backend, but each CP→API
principal, delegation secret, registry, journal and workspace path is distinct.
For a later lane, `inherit_worker_from=sandboxN` copies only the existing API's
worker routing and provider variables inside `vm2`; GitHub Actions never reads
or logs their values. The source may be another named sandbox lane or the
existing `mcp-test` API; if that service has no real worker route, bootstrap
fails. The first lane can instead receive worker access through its own
`RUNNER_API_ENV_FILE` secret. This option
does not copy the source API principal, delegation secret, or run state.

For a new lane, dispatch `runner-api-sandbox-candidate.yml` with a reviewed
source ref and `target=agent-runner-api-sandbox`. Record the successful run ID
and source SHA. Dispatch `runner-api-sandbox-deploy.yml` with `lane`, that run ID,
SHA, and `bootstrap=true` (optionally `inherit_worker_from`). The job verifies the artifact checksum, GitHub
attestation and manifest before connecting to the pinned VM host. Bootstrap
creates only the named lane's unit, env, registry and state directory, and
refuses to overwrite an existing lane. On later code updates use
`bootstrap=false`. The installer checks the named paths and principal, refuses
a journal with unfinished runs, and rolls back to the
previous code if health fails. No shared API or VM worker is restarted.

A network route from each CP to its Runner API port and paired CP/Runner keys
must be verified separately. API health alone does not prove a Telegram task,
GHA execution, persistence or delivery. To rebuild a broken lane, first inspect
and reconcile its accepted runs and preserve required evidence; do not remove
its state or reuse another lane's credentials as part of the deploy workflow.

This procedure deploys a signed Runner API candidate to the test-only
`agent-runner-api-mcp-test.service` on SSH target `vm2`. It does not install the
VM worker, deploy production, alter the legacy `agent-runner-api.service`, or
change the production profile. The test service listens on loopback port 18882
and uses `/etc/agent-runner/agent-runner-api-mcp-test.env` plus its separate
test key registry.

The normal production path remains a reviewed PR merged to `main`, followed by
an authorized `vm-worker-v*` release and the documented promotion procedure in
[VM worker operations](VM-WORKER-OPERATIONS.md). A sandbox candidate may be
built from any repository branch or commit without first merging that candidate
to `main`.

## Build a candidate

Run the manual **Runner API sandbox candidate** workflow from a ref that
contains the installer and packaging changes you intend to use. The workflow
ref supplies those deployment scripts; `source_ref` supplies the Runner source.
For an unmerged PR that changes both, use that PR branch for both refs:

```bash
gh workflow run runner-api-sandbox-candidate.yml \
  --repo trained-assist/ai-agent-runner \
  --ref feat/sandbox-principal-bootstrap-20261008 \
  -f source_ref=feat/sandbox-principal-bootstrap-20261008
```

After that workflow is merged, `--ref main` can package a branch or commit
passed through `source_ref`.

The workflow checks out the selected source ref, runs `npm run typecheck`,
`npm test`, and `npm run build`, packages the API with production dependencies, attests the
archive with GitHub build provenance, and retains the artifact for seven days.
It verifies the required installer, rollback, mock principal provisioning,
and mock-mode scripts are present in the archive. It never connects to a VM.
The artifact manifest pins the exact source SHA and target service.

Download the artifact and deploy it from an operator workstation with GitHub
attestation access and the existing `vm2` SSH alias:

```bash
gh run list --repo trained-assist/ai-agent-runner --workflow runner-api-sandbox-candidate.yml
gh run download RUN_ID --repo trained-assist/ai-agent-runner \
  --name runner-api-sandbox-candidate-SOURCE_SHA --dir /tmp/runner-api-candidate
scripts/deploy-api-sandbox-candidate.sh \
  /tmp/runner-api-candidate/runner-api-sandbox-candidate.tar.gz
```

The deploy script verifies the checksum and provenance signer workflow before
opening SSH. The remote installer independently checks the target hostname,
unit name, environment-file path, port, artifact checksum, source manifest, and
archive paths. It installs a versioned directory below
`/opt/sb/ai-agent-runner-api-mcp-test`, updates only
`agent-runner-api-mcp-test.service`, and requires liveness plus the scoped
Telegram UX principal in the configured registry before reporting success.
The authenticated CP-to-Runner probe is performed by a disposable end-to-end
acceptance task after deployment. Failed startup restores
the prior unit and code pointer. The installer keeps the prior release and
provides `/usr/local/sbin/runner-api-mcp-test-rollback SOURCE_SHA` for an
explicit rollback.

The candidate installer explicitly enables `AGENT_API_ENVIRONMENT=sandbox` and
`AGENT_API_ENABLE_MOCK_TEST=true` only in the protected EnvironmentFile for this
named test service. The installed root-only helper
`runner-api-mcp-test-provision-principal` accepts a strict JSON request on stdin
containing only `schemaVersion`, the fixed target name, and a SHA-256 key hash.
It adds the fixed `integration-telegram-ux-v1-mock-test` principal, tenant, and
profile with `runs:read`, `runs:write`, and the `mock-test` engine allowlist to
the isolated registry. Its synthetic tenant/profile are distinct from the
Telegram UX profile, so its read/status/cancel scope cannot reach the old
profile's admission records. It never accepts the raw key, updates other
principals, or modifies the production API registry. The file-backed registry
reloads the atomic update without restarting the service.

This helper is the Runner half of credential provisioning. The CP-owned
bootstrap must generate the raw key in memory, pass only its hash to this helper
over the declared operator channel, and store the raw key in a dedicated
mock-probe binding on the isolated CP Worker. It must not replace the normal
`RUNNER_API_KEY_TELEGRAM_UX`, which belongs to the Telegram UX profile. Until
that paired operation and an authenticated CP→Runner `mock-test` probe are
implemented, the helper alone does not establish a usable identity and the
sandbox must not be reported `READY`.

The sandbox MCP configuration is pinned to the `trained-assist-mcp-host-test-160`
Worker URL, `registry.fixture_read`, `registry:fixture-read`, the fixed policy,
catalogue, and Registry digest. The existing test environment names remain
accepted while the service is upgraded. Their values are read only by the
service; deployment output and evidence contain names and status only.

## Observe and reset

### Read-only admission and binding inventory

`scripts/inspect-api-sandbox.py --inventory` reads only the declared test
EnvironmentFile, admission journal and current candidate manifest on the pinned
VM2 host. Run it as the authorized root operator, or send the reviewed script
over pinned SSH stdin with `python3 - --inventory`. It emits only source SHA,
approved engine names, binding-presence booleans and admission counts. It does
not emit raw configuration, credentials, run IDs, prompts, results or exception
text, and performs no restart, migration, provisioning or file write.

Missing, malformed, oversized, symlinked or overly readable protected files
produce a sanitized reason code. Unknown outcomes remain nonterminal even when
a `completed` journal record exists. `--require-terminal-journal` exits nonzero
unless every journal admission is terminal. `journalTerminalOnly` describes the
observed journal snapshot; it does not establish a held admission fence, Worker
exit proof, profile readiness or E2E acceptance. Reconcile exact accepted runs
and exclude concurrent intake before any restart. A separate service/journal is
required when old outcomes remain unknown. Recovery ownership:
[Runner #212](https://github.com/trained-assist/ai-agent-runner/issues/212),
[architecture #236](https://github.com/trained-assist/trained-agent-architecture/issues/236).

If inventory reports a protected file's permissions are too open, use the
separate explicit `scripts/restrict-api-sandbox-permissions.py --restrict`
operator helper. It accepts only the pinned VM2 host and the declared MCP test
EnvironmentFile/journal paths. It verifies canonical regular files, single
links, expected root/sandbox owners and the sandbox port/registry/journal
configuration before any change. Accepted private modes are retained; unsafe
modes become `0600` for the same owner. It changes file modes only and emits
component/status labels. It does not edit records, rotate secrets or restart
services. Stream exact reviewed bytes over pinned SSH and rerun read-only
inventory afterward. Live failure and repair ownership:
[Runner #214](https://github.com/trained-assist/ai-agent-runner/issues/214).

Use authenticated Runner API submit/status/result/events/artifacts endpoints for
test runs. The installer checks `GET /healthz` and verifies the scoped test
principal in the configured key registry without reading or printing credential
values. The acceptance task proves authenticated CP-to-Runner admission; the
installer itself does not create a task.
Service logs are available with:

```bash
ssh vm2 'sudo journalctl -u agent-runner-api-mcp-test.service --since "15 minutes ago" --no-pager'
```

Before another synthetic run, reconcile every previously accepted run through
the API or its configured external worker. Do not repeat a submit whose
acceptance is unknown. The API admission journal is
`/var/lib/agent-runner/mcp-test/admissions.jsonl`; task data is isolated from
the production API. Reset only the test API process and its isolated test data
after the runs are terminal and their required evidence is retained.

The deployed API is the orchestration boundary; it may forward accepted work
to its configured test executor. A passing API health probe alone does not
prove model execution, remote MCP invocation, Telegram delivery, or production
readiness. Those claims require a separately recorded end-to-end task result.

## Ownership and limits

- Source/release owner: `trained-assist/ai-agent-runner` maintainers.
- Test service owner: the `agent-runner-api-mcp-test` systemd unit on `vm2`.
- Scoped test credentials: `/etc/agent-runner/key-registry-mcp-test.json` and
  the service's protected environment file. Never print or copy their values.
- Production promotion: reviewed main change, signed `vm-worker-v*` release,
  then the production operator path. This sandbox workflow has no production
  target or credential.

The permission helper verifies the fixed systemd service runs as `sandbox`.
Its EnvironmentFile may be owned by root or that service account; both are
valid existing installation layouts. Journal ownership remains pinned to
`sandbox`, so restricting its mode cannot remove the service writer's access.
Unrelated owners still fail before any mode change.

On failed inventory, fixed-file metadata uses lstat only and reports regular-file,
unique-file, root/sandbox/other owner category, private-mode and service access
booleans. It emits no file bytes, numeric owner IDs, names or arbitrary paths.
A private existing operator-owned EnvironmentFile remains untouched during
permission repair, since systemd reads it as root. Changing an unsafe environment
mode still requires root/sandbox ownership; journal ownership stays pinned to
sandbox before restriction. No chown or service restart is performed.

## Initial sandbox3 contract stage through the existing bootstrap

The CP #231 operator channel has proven SSH and read-only access to the existing
signed ab8e7a3 candidate. `bootstrap-api-sandbox-lane.sh --contract-sandbox3
PREPARER_PATH --inspect` delegates to the separately byte-verified fixed-target
preparer and reports component/proxy-service booleans. `--prepare` accepts only
fixed-target JSON on stdin (API key hash and delegation secret), refuses any
existing namespace/alias/occupied port and creates a distinct `sandbox3-api`
nonlogin account, private config/registry/journal and a root-owned runtime root.
It does not start a service, copy old credentials/state or provision providers.
Secrets stay out of arguments/logs. Initial registry engines are mock-test only;
there is no default chain, real worker/model access or profile workspace yet.

The existing lane installer accepts the ab8e7a3 artifact only with the explicit
sixth argument `--existing-mcp-runtime` and the pinned source/checksum, for
sandbox3 exclusively. The unchanged artifact target and exclusive install
target are separate identities. It accepts safe regular npm file symlinks and
refuses escaping links/chains/ancestors/duplicates. Unit user/runtime, canonical
private files and service-owned journal are checked; installed code is root-owned.
It never stops an active API: a terminal snapshot alone is not an admission
fence, so later updates require a separately verified operator quiescence path.
If admissions become unresolved during startup, rollback preserves this runtime.

Expected public route: `https://169-58-15-230.sslip.io/runner-sandbox3`. Its proxy,
TLS and CP reachability require separate proof. Initial mock stage is not bounded
real worker/profile storage or Telegram acceptance.

Initial contract diagnostics also support `--mock-probe` with a fixed-target
API-key request on stdin and `--proxy-inspect` without secret input. The mock
probe checks exact installed ab8e7a3 process identity, invalid-key refusal,
normal explicit mock-test receipt/status/result/events and same-key replay.
It never retries a nonterminal/unknown outcome or submits another run key.
Only synthetic IDs/booleans survive; model calls and real Telegram E2E are false.
Proxy inspection emits only global config marker booleans: those markers do not
prove server selection, TLS routing, ownership or public API reachability.
The namespace inspector includes allowlisted systemd failure result and bounded
exit status, without raw journalctl or environment contents.

Root-owned runtime staging is made 0755 explicitly: mktemp starts at 0700, which
would prevent the distinct service UID from entering the installed code root.
Private state/config permissions are unchanged.

Proxy inspection additionally parses nginx source/server blocks and reports a
bounded qualifiedRouteTargetCount. A target requires the exact sandbox hostname,
TLS listen 443 in the same server block. Legacy route/upstream presence is independent metadata.
Markers in separate servers never authorize a route edit. Raw source paths,
certificate paths, header values and configuration stay out of evidence.
Unsupported or ambiguous grammar fails closed before any mutation.

`prepare-api-sandbox3.py --configure-proxy` is an explicit isolated route operation.
It requires the exact signed sandbox3 process, active nginx and one or two qualified
TLS servers for the exact declared host. It refuses any existing sandbox3 route, alias
outside `/etc/nginx`, writable/non-root configuration, source changes or duplicate aliases of the same canonical file. It adds only `/runner-sandbox3` locations,
preserves original bytes around each insertion, validates `nginx -t`, then reloads
nginx without restarting Runner. Validation/reload failure restores only this
operation's unchanged config bytes across all changed files; a conflicting operator edit is preserved.
Each operation creates a unique root-only backup directory under `/etc/agent-runner`, never service state
or evidence. External TLS/health/auth checks must separately prove public routing.

The live corrected grammar inspection (CP run 37911004901) passed with zero
targets under the original legacy-upstream-dependent selector. Selection now
requires the exact declared host and TLS in one server, independently of where
legacy paths point. Their configuration stays byte-for-byte preserved. A zero
or greater-than-two TLS host count still refuses mutation.

The exact-host inspection in CP run 37911919984 found two TLS server blocks.
The bounded pair operation adds the same isolated route to both, in at most two
canonical configuration files, then validates once and reloads once. Zero or more
than two targets refuse before writing. Evidence reports only the matched server
and changed file counts; private configuration contents and paths stay out of logs.

### Configure the existing signed sandbox3 API for its native Worker

`prepare-api-sandbox3.py --configure-native` updates only the already installed
`ab8e7a3da4efa45c2154d67423542a6974576f22` process on `vmi3617957`. It requires
the reviewed journal checker beside the script. Root-only JSON stdin supplies
`schemaVersion: 1`, the fixed target, `workerSha`, `workerToken`,
`profileGitHubToken`, the existing `storageBucket` and service-account JSON in
`storageCredentials`. Never pass these credentials in argv or save the request
as an evidence artifact. The signed candidate remains unchanged.

The operator checks Worker source/auth, the exact mock-only namespace and its
terminal journal. It backs up configuration privately, replaces only the known
sandbox3 nginx blocks with HTTP503, waits for old nginx workers to exit, then
checks admissions again. An admission accepted during draining refuses the
service stop and leaves the fence held. Only the fresh service is stopped; the
journal is checked again before configuration and restart. The operator preserves
the existing intake key hash and delegation secret, adds the native engine and
profile-provisioning scope, routes only the declared tenant to trained-assist,
and copies only the Ladder credential from the old API's environment pool.
Profile GitHub, Worker and GCS credentials remain host credentials.

The existing GCS backend provides signed profile snapshots. Local-fs has no
`shareUrl` implementation and cannot provide this cross-host profile chain.
A private root-owned GCS credential file is readable only by the dedicated
service group. No bucket, cloud key or paid resource is created by this operator.
Failure after fencing keeps backups and the fence for operator recovery; it
does not automatically roll back or restart an unknown run. Source/health checks
must pass before reopening admission. Successful configuration is not agent,
model, file-persistence or Telegram acceptance evidence.
