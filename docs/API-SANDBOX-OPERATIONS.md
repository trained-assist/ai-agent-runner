# Isolated Runner API sandbox

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

Run the manual **Runner API sandbox candidate** workflow from the default
branch, with the desired branch or commit in `source_ref`:

```bash
gh workflow run runner-api-sandbox-candidate.yml \
  --repo trained-assist/ai-agent-runner \
  --ref main \
  -f source_ref=fix/example-candidate
```

The workflow checks out the selected source ref, runs `npm run typecheck`,
`npm test`, and `npm run build`, packages the API with production dependencies, attests the
archive with GitHub build provenance, and retains the artifact for seven days.
It never connects to a VM. The artifact manifest pins the exact source SHA and
target service.

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
`agent-runner-api-mcp-test.service`, and requires both liveness and an
authenticated not-found probe before reporting success. Failed startup restores
the prior unit and code pointer. The installer keeps the prior release and
provides `/usr/local/sbin/runner-api-mcp-test-rollback SOURCE_SHA` for an
explicit rollback.

The sandbox MCP configuration is pinned to the `trained-assist-mcp-host-test-160`
Worker URL, `registry.fixture_read`, `registry:fixture-read`, the fixed policy,
catalogue, and Registry digest. The existing test environment names remain
accepted while the service is upgraded. Their values are read only by the
service; deployment output and evidence contain names and status only.

## Observe and reset

Use authenticated Runner API submit/status/result/events/artifacts endpoints for
test runs. The deployment script checks `GET /healthz` and confirms the test
API credential with a synthetic unknown run ID; it does not create a task.
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
