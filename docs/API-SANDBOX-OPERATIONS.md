# Isolated Runner API sandbox

## Dedicated sandbox3 through GitHub Actions

The second Telegram lane uses a **different** API target,
`agent-runner-api-sandbox3.service` on port 18883. The candidate workflow now
accepts `target=agent-runner-api-sandbox3`. Its signed artifact can be deployed
with the manual `runner-api-sandbox3-deploy.yml` workflow, so the operator does
not need local SSH access. This path never installs the shared `mcp-test` API.

Before dispatching a deployment, an operator must bootstrap on `vm2`:

- `/etc/systemd/system/agent-runner-api-sandbox3.service`, using only
  `/etc/agent-runner/agent-runner-api-sandbox3.env` and a distinct writable state
  directory;
- a dedicated environment with `AGENT_API_PORT=18883`,
  `AGENT_API_KEY_REGISTRY=/etc/agent-runner/key-registry-sandbox3.json`,
  `AGENT_API_ADMISSION_LOG=/var/lib/agent-runner/sandbox3/admissions.jsonl`,
  `AGENT_API_ENVIRONMENT=sandbox`, a real external worker, and no enabled
  `mock-test` engine;
- a separate key registry containing the scoped `integration-sandbox3-v1`
  principal and a network route from the sandbox3 CP to this API;
- GitHub environment `runner-api-sandbox3` with `VM2_SANDBOX3_SSH_HOST`,
  `VM2_SANDBOX3_SSH_USER`, `VM2_SANDBOX3_SSH_PRIVATE_KEY`, and
  `VM2_SANDBOX3_KNOWN_HOSTS` secrets. The SSH user must have narrowly scoped
  passwordless sudo for the sandbox3 installer; protect the environment with
  trusted reviewers. Do not reuse the production or shared test credentials.

The installer checks the exact host, service, env file, port, registry,
principal, empty admission journal, artifact checksum, and manifest target
before changing code. It restarts only `agent-runner-api-sandbox3.service` and
restores the previous release if health fails. A nonempty journal blocks an
update until its accepted runs are reconciled. A successful deploy proves API
liveness only; a Telegram task must still prove Runner admission, execution,
result persistence, and delivery.

Dispatch `runner-api-sandbox-candidate.yml` with the exact source ref and
`target=agent-runner-api-sandbox3`. Record the successful run ID and source SHA.
Then dispatch `runner-api-sandbox3-deploy.yml` with that run ID and SHA. The
deploy job verifies the checksum, GitHub provenance, and target-specific
manifest before opening SSH with pinned host keys. If any bootstrap item is
missing, it fails without changing the shared API.

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
