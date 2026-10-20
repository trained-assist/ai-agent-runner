#!/usr/bin/env node
/**
 * Live proof that a revoked credential fails the run closed.
 *
 * The sandbox3 credential registry carries two refs: "github" is the credential
 * the lane actually uses, and "github-revoked" points at a connection that was
 * revoked after intake, so its value is gone from the custody store. A run that
 * asks for the revoked ref must fail closed: it must not start, and it must not
 * run without the credential.
 *
 * Required environment:
 *   - RUNNER_API_URL: the Runner API base URL of the lane under test
 *   - RUNNER_API_KEY_AGENT_API: the principal key of that lane
 *
 * Optional environment:
 *   - REVOKED_CREDENTIAL_REF: the ref to test (default: the registry's
 *     "github-revoked")
 *   - CF_TOKEN: a Cloudflare API token that can read the custody database
 *   - CUSTODY_ACCOUNT_ID / CUSTODY_DATABASE_ID: the durable custody database
 *     that holds the credential journal
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const REVOKED_CREDENTIAL_REF = 'github-revoked';

/**
 * The ref under test must exist in the registry and must not be the live
 * credential: the check proves the failure of a revoked one, and a registry that
 * points the fixture at the working credential would prove nothing.
 */
export function revokedCredentialTarget(registry, ref = REVOKED_CREDENTIAL_REF) {
  const configured = registry?.[ref];
  if (!configured) throw new Error(`the credential registry has no "${ref}" ref`);
  if (configured.connection_id === registry['github']?.connection_id) {
    throw new Error(`the "${ref}" ref must not point at the live credential`);
  }
  return configured;
}

export async function runRevokedCredentialCheck({ apiUrl, apiKey, registry, ref = REVOKED_CREDENTIAL_REF, custody }) {
  const configured = revokedCredentialTarget(registry, ref);
  const steps = [];
  async function step(name, fn) {
    try {
      const detail = await fn();
      steps.push(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
      steps.push(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }

  async function runner(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return { status: response.status, text, body: parsed };
  }

  let runId = null;
  let status = null;

  await step('the Runner API accepts a run that asks for the revoked credential', async () => {
    const taskId = `revoked-credential-${Date.now()}`;
    const response = await runner('/v1/runs', {
      method: 'POST',
      headers: { 'idempotency-key': taskId },
      body: {
        userTaskId: taskId,
        input: { inlinePrompt: 'Say one word.' },
        envAllowlist: ['LLM_LADDER_TOKEN'],
        credentialBindings: [{ ref, scope: configured.scope }],
        limits: { timeoutMs: 300_000 },
      },
    });
    assert.equal(response.status, 202, `${response.status}: ${response.text}`);
    runId = response.body.runId;
    return runId;
  });

  await step('the run fails closed instead of starting without the credential', async () => {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const response = await runner(`/v1/runs/${runId}/status`);
      assert.equal(response.status, 200, response.text);
      status = response.body;
      if (['succeeded', 'failed', 'cancelled'].includes(String(status.state))) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    assert.ok(status, 'the run never reported a state');
    assert.equal(status.state, 'failed', `the run ended as ${status.state}`);
    return 'failed';
  });

  await step('the failure names the revoked credential', async () => {
    const response = await runner(`/v1/runs/${runId}/events?cursor=0`);
    assert.equal(response.status, 200, response.text);
    const events = response.body?.events ?? [];
    const failure = events.find((event) => event.type === 'run_failed');
    assert.ok(failure, `the run has no run_failed event: ${JSON.stringify(events.map((event) => event.type))}`);
    assert.equal(failure.payload?.reason, 'credential_unavailable');
    assert.equal(failure.payload?.code, 'CREDENTIAL_REVOKED');
    return 'CREDENTIAL_REVOKED';
  });

  await step('the run never produced an answer and never carried a value', async () => {
    const response = await runner(`/v1/runs/${runId}/events?cursor=0`);
    const record = JSON.stringify(status) + response.text;
    assert.ok(!/ghp_[A-Za-z0-9_]{10,}/.test(record), 'the value must not appear in the run record');
    assert.ok(!status.answer, 'a run that failed closed must not have an answer');
    return 'value-free';
  });

  await step('the custody store handed out no value for the revoked connection', async () => {
    if (!custody?.token || !custody?.accountId || !custody?.databaseId) return 'skipped: the custody database is not configured';
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${custody.accountId}/d1/database/${custody.databaseId}/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${custody.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        sql: 'SELECT action, actor FROM credential_events WHERE connection_id = ? ORDER BY event_id',
        params: [configured.connection_id],
      }),
    });
    const body = await response.json();
    const rows = body.result?.[0]?.results ?? [];
    const granted = rows.filter((row) => row.action === 'granted');
    assert.equal(granted.length, 0, `the revoked connection handed out a value: ${JSON.stringify(rows)}`);
    assert.ok(rows.some((row) => row.action === 'revoked'), 'the journal has no revocation');
    return `journal: ${rows.map((row) => row.action).join(',')}`;
  });

  return steps;
}

const invokedDirectly = process.argv[1]?.endsWith('sandbox3-revoked-credential-check.mjs');
if (invokedDirectly) {
  const apiUrl = process.env.RUNNER_API_URL;
  const apiKey = process.env.RUNNER_API_KEY_AGENT_API;
  if (!apiUrl || !apiKey) throw new Error('RUNNER_API_URL and RUNNER_API_KEY_AGENT_API are required');
  const config = JSON.parse(await readFile(new URL('../wrangler.sandbox3.jsonc', import.meta.url), 'utf8'));
  const registry = JSON.parse(config.vars.ZEROCREDS_WALLET_CREDENTIALS);
  const steps = await runRevokedCredentialCheck({
    apiUrl,
    apiKey,
    registry,
    ref: process.env.REVOKED_CREDENTIAL_REF ?? REVOKED_CREDENTIAL_REF,
    custody: {
      token: process.env.CF_TOKEN,
      accountId: process.env.CUSTODY_ACCOUNT_ID,
      databaseId: process.env.CUSTODY_DATABASE_ID,
    },
  });
  console.log(steps.join('\n'));
}
