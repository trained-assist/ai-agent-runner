#!/usr/bin/env node
// Live sandbox E2E for a real agent run against the disposable sandbox user
// (ai-agent-runner#413).
//
// The protocol-level harness (scripts/sandbox-user-agent-e2e.mjs) proves the trust
// chain by playing the Runner's part. This script proves the product path: a run
// is issued to the sandbox Runner API, the Runner provisions a disposable identity
// for that run, the agent creates a synthetic GitHub credential form through the
// user gateway, the browser submits a synthetic-only value, and the agent observes
// `done`.
//
// What is proven, against the deployed sandbox surfaces only:
//
//   1. the Runner API admits a task whose MCP descriptor is the pinned user catalog;
//   2. the agent itself creates the synthetic form through the gateway;
//   3. a synthetic-only value is accepted by that form;
//   4. the agent observes `done` and the submitted value is in none of the MCP
//      responses, the run logs, the run events or the run artifacts;
//   5. the Runner revokes the disposable identity when the run reaches a terminal
//      state, and a later bootstrap cannot see the old identity's form.
//
// Sandbox OpenBao is ephemeral and only ever sees synthetic values. Secrets are
// read from the environment or from 0600 files; nothing secret is printed. The
// script prints identifiers, statuses and byte counts only.

import { createHash, createPrivateKey, randomUUID, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RUNNER_API = (process.env.RUNNER_API_URL || 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev').replace(/\/+$/, '');
const GATEWAY_URL = (process.env.MCP_USER_GATEWAY_URL || 'https://trained-assist-mcp-user-sandbox.skillset-apply.workers.dev').replace(/\/+$/, '');
const API_KEY_FILE = process.env.RUNNER_API_KEY_FILE || join(homedir(), '.epic253-secrets', 'runner-api-mem-gpt-key');
const CHAIN_FILE = process.env.MCP_USER_RUNNER_CHAIN_FILE || join(homedir(), '.epic253-secrets', 'mcp-user-runner-chain.json');

const AGENT_ISSUER = 'trained-assist-agent-runner';
const AGENT_AUDIENCE = 'trained-assist:mcp:user';
const AGENT_SERVER = 'mem-gpt';
const AGENT_BINDING = 'mem-gpt-user-sandbox';
const AGENT_SCOPE = 'mcp:user-agent-run';
const AGENT_POLICY = 'mem-gpt-user-run-v1';
const AGENT_CATALOGUE = 'mem-gpt-user-catalogue-v2';
const AGENT_TOOLS = [
  'identity.whoami',
  'google_docs.connect',
  'google_docs.get_document',
  'zerocreds_wallet_form_create',
  'zerocreds_wallet_form_status',
  'zerocreds_wallet_connection_status',
  'zerocreds_wallet_connection_revoke',
];

const RUN_TIMEOUT_MS = Number(process.env.E2E_RUN_TIMEOUT_MS || 20 * 60_000);
const POLL_INTERVAL_MS = Number(process.env.E2E_POLL_INTERVAL_MS || 4_000);

const failures = [];
const scanned = []; // every surface that is scanned for the submitted value

function pass(name, detail = '') {
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  failures.push(`${name}: ${detail}`);
  console.log(`FAIL ${name} — ${detail}`);
}

function check(name, condition, detail = '') {
  if (condition) pass(name, detail);
  else fail(name, detail || 'condition was false');
  return Boolean(condition);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function readKey() {
  const fromEnv = process.env.RUNNER_API_KEY?.trim();
  const key = fromEnv || readFileSync(API_KEY_FILE, 'utf8').trim();
  if (!key || key.length < 32) throw new Error('the sandbox Runner API key is missing');
  return key;
}

function readChain() {
  const chain = JSON.parse(readFileSync(CHAIN_FILE, 'utf8'));
  const privateJwk = process.env.MCP_USER_RUNNER_PRIVATE_JWK || chain.privateJwk;
  const authToken = process.env.MCP_USER_AUTH_TOKEN || chain.authToken;
  const provisionToken = process.env.MCP_SANDBOX_PROVISION_TOKEN || chain.provisionToken;
  if (!privateJwk || !authToken || !provisionToken) throw new Error('the sandbox chain material is incomplete');
  return { privateJwk, authToken, provisionToken };
}

function signRunBinding({ privateJwk, runId, taskId, profileId, userId, allowedTools, ttlSeconds = 900 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const claims = {
    iss: AGENT_ISSUER, aud: AGENT_AUDIENCE, sub: runId, runId, userTaskId: taskId,
    profileId, principalId: `user:${userId}`, userId, ownerGeneration: 1,
    serverId: AGENT_SERVER, bindingRef: AGENT_BINDING, scope: AGENT_SCOPE,
    policyVersion: AGENT_POLICY, catalogueVersion: AGENT_CATALOGUE,
    allowedTools, iat: now, exp: now + ttlSeconds,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
  return `${unsigned}.${Buffer.from(cryptoSign(null, Buffer.from(unsigned), key)).toString('base64url')}`;
}

async function json(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000, apiKey } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, ok: response.ok, text, body: parsed };
}

async function mcp(grant, { method, params }) {
  const response = await json(`${GATEWAY_URL}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${grant.authToken}`,
      'x-mcp-operation': 'invocation',
      'x-mcp-scope': AGENT_SCOPE,
      'x-mcp-user-task-id': grant.taskId,
      'x-mcp-profile': grant.profileId,
      'x-mcp-run-id': grant.runId,
      'x-mcp-run-binding': grant.proof,
    },
    body: { jsonrpc: '2.0', id: `${method}:${randomUUID()}`, method, params },
  });
  scanned.push({ surface: 'mcp', body: response.text });
  return response;
}

function toolResultText(response) {
  const content = response.body?.result?.content;
  if (!Array.isArray(content) || !content.length) return null;
  const text = content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('');
  try { return JSON.parse(text); } catch { return text; }
}

const AGENT_PROMPT = [
  'Use the mem-gpt MCP server tools for this task.',
  '1. Call zerocreds_wallet_form_create with provider "github", kind "token", ttl_minutes 30,',
  '   a title that says the credential is sandbox-only and synthetic, and a unique idempotency_key.',
  '2. As soon as the tool returns, write the returned form id and form url into your reply text.',
  '3. Then call zerocreds_wallet_form_status with that form id, one call per step, repeating the',
  '   call about every ten seconds (up to forty attempts) until the returned status is "done".',
  '   Do not wait inside code: your JavaScript sandbox has no timer, so call the MCP tool again',
  '   directly instead of wrapping the wait in a script.',
  '4. When the status is "done", write a final line in the form: FORM_STATUS_DONE <form_id> <connection_id>.',
  'Never ask for, print, or guess any credential value.',
].join('\n');

function findFormUrl(text) {
  const match = /https?:\/\/[^\s"'\\]*\/f\/([a-f0-9]{32})/.exec(text ?? '');
  if (!match) return null;
  return { url: match[0], formId: match[1] };
}

function sawDone(text) {
  return /FORM_STATUS_DONE/.test(text ?? '') || /"status"\s*:\s*"done"/.test(text ?? '') || /'status'\s*:\s*'done'/.test(text ?? '');
}

async function main() {
  const apiKey = readKey();
  const { privateJwk, authToken, provisionToken } = readChain();
  const taskId = `task-${randomUUID()}`;

  // 1. issue the task -------------------------------------------------------
  const submitted = await json(`${RUNNER_API}/v1/runs`, {
    method: 'POST',
    apiKey,
    headers: { 'idempotency-key': `e2e-${randomUUID()}` },
    body: {
      userTaskId: taskId,
      input: { inlinePrompt: AGENT_PROMPT },
      // The France VM worker runs the agent with the model credential the lane
      // approves for runtime use. Without the name in the allowlist the worker
      // starts the agent without it and the provider refuses the first call.
      routeMode: 'france',
      engine: { name: 'eu-vm-agent-run', adapterVersion: '1' },
      envAllowlist: ['LLM_LADDER_TOKEN'],
      limits: { timeoutMs: 900_000, maxOutputBytes: 2_000_000, maxLogBytes: 2_000_000 },
      mcp: { servers: [{
        serverId: AGENT_SERVER, transport: 'remote', url: `${GATEWAY_URL}/mcp`,
        bindingRef: AGENT_BINDING, allowedTools: AGENT_TOOLS,
        policyVersion: AGENT_POLICY, catalogueVersion: AGENT_CATALOGUE,
      }] },
    },
  });
  if (!check('the Runner API admits the task with the pinned user catalog',
    [200, 201, 202].includes(submitted.status),
    `status=${submitted.status} body=${JSON.stringify(submitted.body).slice(0, 300)}`)) {
    throw new Error('cannot continue without an admitted run');
  }
  const runId = submitted.body?.runId;
  pass('the Runner API admits the task with the pinned user catalog', `runId=${runId} taskId=${taskId}`);

  // The Runner derives the disposable identity from the run id; the harness
  // recomputes it so it can talk to the gateway as that identity afterwards.
  const identityHash = createHash('sha256').update(runId.toLowerCase()).digest('hex');
  const userId = `sbx-${identityHash.slice(0, 32)}`;
  const profileId = `sbx_${identityHash.slice(0, 32)}`;

  // 2. watch the run, submit the synthetic value when the form appears ------
  const syntheticValue = `synthetic-${randomUUID()}-sandbox-only-value`;
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let stdout = '';
  let stderr = '';
  let form = null;
  let submittedValue = false;
  let status = null;

  while (Date.now() < deadline) {
    const view = await json(`${RUNNER_API}/v1/runs/${encodeURIComponent(runId)}/status`, { apiKey });
    status = view.body;
    stdout = `${stdout}${status?.output?.stdout ?? ''}`;
    stderr = `${stderr}${status?.output?.stderr ?? ''}`;

    if (!form) {
      // The agent's tool traffic is reported on the run's stderr stream, so the
      // form URL can appear on either stream depending on how the agent ran the
      // tool (inline call or wrapped in a script).
      const found = findFormUrl(`${stdout}\n${stderr}`);
      if (found) {
        form = found;
        pass('the agent created the synthetic GitHub form', `form_id=${found.formId}`);
        const page = await fetch(found.url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
        await page.text();
        check('the one-time form page is served', page.status === 200, `status=${page.status}`);
        const sent = await json(found.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: { t: found.formId, fields: { token: syntheticValue } },
        });
        submittedValue = sent.status === 200;
        check('the synthetic-only value is accepted by the form', submittedValue,
          `status=${sent.status} body=${JSON.stringify(sent.body).slice(0, 200)}`);
      }
    }

    if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(status?.state)) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  check('the run reaches a terminal state', ['succeeded', 'failed', 'cancelled'].includes(status?.state),
    `state=${status?.state} reason=${status?.failure?.code ?? ''}`);

  // 3. collect every surface the run produced --------------------------------
  const [result, events, artifacts, sessionLog] = await Promise.all([
    json(`${RUNNER_API}/v1/runs/${encodeURIComponent(runId)}/result`, { apiKey }),
    json(`${RUNNER_API}/v1/runs/${encodeURIComponent(runId)}/events?limit=500`, { apiKey }),
    json(`${RUNNER_API}/v1/runs/${encodeURIComponent(runId)}/artifacts`, { apiKey }),
    json(`${RUNNER_API}/v1/runs/${encodeURIComponent(runId)}/log`, { apiKey, timeoutMs: 60_000 }),
  ]);
  scanned.push({ surface: 'stdout', body: stdout });
  scanned.push({ surface: 'stderr', body: stderr });
  scanned.push({ surface: 'result', body: result.text });
  scanned.push({ surface: 'events', body: events.text });
  scanned.push({ surface: 'artifacts', body: artifacts.text });
  scanned.push({ surface: 'session-log', body: sessionLog.text });
  scanned.push({ surface: 'answer', body: JSON.stringify(status?.answer ?? '') });
  pass('the run surfaces are collected',
    `session-log=${sessionLog.status} bytes=${sessionLog.text.length} artifacts=${artifacts.body?.count ?? 0} events=${events.body?.events?.length ?? 0}`);

  // 4. the agent observed done ------------------------------------------------
  check('the agent observed the form as done', sawDone(`${stdout}\n${stderr}\n${result.text}`),
    `form_id=${form?.formId ?? 'none'}`);

  // 5. the value is in none of the surfaces -----------------------------------
  const leaked = scanned.filter((entry) => String(entry.body ?? '').includes(syntheticValue));
  check('the submitted value appears in no run surface', leaked.length === 0,
    leaked.length ? `leaked into ${leaked.map((entry) => entry.surface).join(', ')}`
      : `${scanned.length} surfaces scanned`);

  // 6. the Runner revoked the disposable identity -----------------------------
  // The revocation is a post-terminal cleanup step, so it may land a few seconds
  // after the run reports its terminal state. Give it a moment instead of
  // failing the proof on a race that the product resolves on its own.
  const revokedGrant = {
    authToken, runId, taskId, profileId,
    proof: signRunBinding({ privateJwk, runId, taskId, profileId, userId, allowedTools: AGENT_TOOLS }),
  };
  let afterCleanup = null;
  const revokeDeadline = Date.now() + 120_000;
  while (Date.now() < revokeDeadline) {
    afterCleanup = await mcp(revokedGrant, { method: 'tools/list', params: {} });
    if (afterCleanup.body?.error?.code === -32001) break;
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  check('the disposable identity loses access after the run',
    afterCleanup?.body?.error?.code === -32001,
    `error=${JSON.stringify(afterCleanup?.body?.error)}`);

  // 7. a later bootstrap cannot see the old state -----------------------------
  const secondRunId = randomUUID();
  const secondBoot = await json(`${GATEWAY_URL}/internal/sandbox/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${provisionToken}` },
    body: { runId: secondRunId, expiresAt: Date.now() + 60 * 60_000 },
  });
  if (check('a later run bootstraps its own identity',
    secondBoot.status === 200 || secondBoot.status === 201,
    `status=${secondBoot.status} body=${JSON.stringify(secondBoot.body)}`)) {
    const secondTaskId = `task-${randomUUID()}`;
    const second = {
      authToken, runId: secondRunId, taskId: secondTaskId,
      profileId: secondBoot.body.profileId,
      proof: signRunBinding({
        privateJwk, runId: secondRunId, taskId: secondTaskId,
        profileId: secondBoot.body.profileId, userId: secondBoot.body.userId,
        allowedTools: AGENT_TOOLS,
      }),
    };
    const oldForm = form
      ? await mcp(second, { method: 'tools/call', params: { name: 'zerocreds_wallet_form_status', arguments: { form_id: form.formId } } })
      : null;
    const oldFormVisible = oldForm ? oldForm.body?.result?.isError !== true : false;
    check('the later identity cannot see the old form', !oldFormVisible,
      `response=${JSON.stringify(oldForm?.body?.result?.content?.[0]?.text ?? oldForm?.body?.error ?? null).slice(0, 160)}`);

    await json(`${GATEWAY_URL}/internal/sandbox/users/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${provisionToken}` },
      body: { runId: secondRunId },
    });
  }

  console.log(`runId=${runId} taskId=${taskId} userId=${userId} profileId=${profileId}`);
  console.log(failures.length ? `E2E_FAIL (${failures.length})` : 'E2E_PASS');
  if (failures.length) {
    for (const failure of failures) console.log(` - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.log(`E2E_ERROR — ${error?.message || error}`);
  if (failures.length) for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
});
