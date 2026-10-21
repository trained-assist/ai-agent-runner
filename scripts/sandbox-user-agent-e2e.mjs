#!/usr/bin/env node
// Live sandbox E2E for the disposable sandbox user lifecycle (ai-agent-runner#413).
//
// What it proves, against the deployed sandbox surfaces only:
//
//   1. a fresh run can bootstrap its own disposable user on the MCP user gateway;
//   2. the runner-delegated grant (service bearer + Ed25519 run binding) reaches the
//      gateway and sees exactly the pinned user catalogue;
//   3. the agent can create a synthetic GitHub credential form, the browser submits a
//      synthetic-only value, and the form status becomes `done`;
//   4. the submitted value never appears in any MCP response the agent can see;
//   5. cleanup revokes the identity, and a later bootstrap cannot see the old state.
//
// The harness plays the part the Runner plays: it holds the runner private key and
// signs the per-run binding exactly as the Runner API must. It does not dispatch an
// agent run; that leg is covered by the runner-side policy work.
//
// Secrets are read from the environment or from a 0600 chain file. Nothing secret is
// printed: the script only prints identifiers, statuses and byte counts.

import { createPrivateKey, sign as cryptoSign, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GATEWAY_URL = (process.env.MCP_USER_GATEWAY_URL || 'https://trained-assist-mcp-user-sandbox.skillset-apply.workers.dev').replace(/\/+$/, '');
const CHAIN_FILE = process.env.MCP_USER_RUNNER_CHAIN_FILE || join(homedir(), '.epic253-secrets', 'mcp-user-runner-chain.json');
const CATALOGUE_VERSION = process.env.MCP_USER_CATALOGUE_VERSION || 'mem-gpt-user-catalogue-v2';
const CATALOGUE_DIGEST = process.env.MCP_USER_CATALOGUE_DIGEST || '483e6d2f949b32c05a70186f4e25aba291b1483eeb0bdc9a7a3bca4b9b7cdf11';

const AGENT_ISSUER = 'trained-assist-agent-runner';
const AGENT_AUDIENCE = 'trained-assist:mcp:user';
const AGENT_SERVER = 'mem-gpt';
const AGENT_BINDING = 'mem-gpt-user-sandbox';
const AGENT_SCOPE = 'mcp:user-agent-run';
const AGENT_POLICY = 'mem-gpt-user-run-v1';
const LEASE_MS = 60 * 60 * 1000;

// The pinned @zerocreds/mcp-provider publishes its tools under the `zerocreds_`
// namespace, and the gateway's allowlist uses exactly these names.
const EXPECTED_TOOLS = [
  'google_docs.connect',
  'google_docs.get_document',
  'identity.whoami',
  'zerocreds_wallet_connection_revoke',
  'zerocreds_wallet_connection_status',
  'zerocreds_wallet_form_create',
  'zerocreds_wallet_form_status',
];

const failures = [];
const observed = []; // every MCP response body, scanned for the submitted value

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

function readChain() {
  const chain = JSON.parse(readFileSync(CHAIN_FILE, 'utf8'));
  const authToken = process.env.MCP_USER_AUTH_TOKEN || chain.authToken;
  const provisionToken = process.env.MCP_SANDBOX_PROVISION_TOKEN || chain.provisionToken;
  const privateJwk = process.env.MCP_USER_RUNNER_PRIVATE_JWK || chain.privateJwk;
  if (!authToken || !provisionToken || !privateJwk) {
    throw new Error('missing sandbox chain material; set the env vars or point MCP_USER_RUNNER_CHAIN_FILE at the 0600 chain file');
  }
  return { authToken, provisionToken, privateJwk };
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signRunBinding({ privateJwk, runId, taskId, profileId, userId, allowedTools, ttlSeconds = 900 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const claims = {
    iss: AGENT_ISSUER,
    aud: AGENT_AUDIENCE,
    sub: runId,
    runId,
    userTaskId: taskId,
    profileId,
    principalId: `user:${userId}`,
    userId,
    ownerGeneration: 1,
    serverId: AGENT_SERVER,
    bindingRef: AGENT_BINDING,
    scope: AGENT_SCOPE,
    policyVersion: AGENT_POLICY,
    catalogueVersion: CATALOGUE_VERSION,
    catalogueDigest: CATALOGUE_DIGEST,
    allowedTools,
    iat: now,
    exp: now + ttlSeconds,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
  const signature = cryptoSign(null, Buffer.from(unsigned), key);
  return `${unsigned}.${Buffer.from(signature).toString('base64url')}`;
}

async function json(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, ok: response.ok, text, body: parsed, headers: response.headers };
}

async function mcp(grant, { method, params, id }) {
  const requestId = id || `${method}:${randomUUID()}`;
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
    body: { jsonrpc: '2.0', id: requestId, method, params },
  });
  observed.push(response.text);
  return { ...response, requestId };
}

function toolResultText(response) {
  const content = response.body?.result?.content;
  if (!Array.isArray(content) || !content.length) return null;
  const text = content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('');
  try { return JSON.parse(text); } catch { return text; }
}

async function bootstrap(provisionToken, runId) {
  return json(`${GATEWAY_URL}/internal/sandbox/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${provisionToken}` },
    body: { runId, expiresAt: Date.now() + LEASE_MS },
  });
}

async function revoke(provisionToken, runId) {
  return json(`${GATEWAY_URL}/internal/sandbox/users/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${provisionToken}` },
    body: { runId },
  });
}

async function main() {
  const { authToken, provisionToken, privateJwk } = readChain();
  const runId = randomUUID();
  const taskId = `task-${randomUUID()}`;

  // 1. bootstrap -----------------------------------------------------------
  const boot = await bootstrap(provisionToken, runId);
  if (!check('bootstrap disposable sandbox user', boot.status === 201 || boot.status === 200,
    `status=${boot.status} body=${JSON.stringify(boot.body)}`)) {
    throw new Error('cannot continue without a disposable identity');
  }
  const { userId, profileId } = boot.body;
  pass('bootstrap disposable sandbox user', `status=${boot.status} userId=${userId} profileId=${profileId}`);

  const allowedTools = EXPECTED_TOOLS.slice();
  const grant = {
    authToken,
    runId,
    taskId,
    profileId,
    proof: signRunBinding({ privateJwk, runId, taskId, profileId, userId, allowedTools }),
  };

  try {
    // 2. catalogue ----------------------------------------------------------
    const list = await mcp(grant, { method: 'tools/list', params: {} });
    const tools = Array.isArray(list.body?.result?.tools) ? list.body.result.tools.map((tool) => tool.name).sort() : [];
    check('runner grant sees exactly the pinned user catalogue',
      JSON.stringify(tools) === JSON.stringify(EXPECTED_TOOLS),
      `tools=${JSON.stringify(tools)}`);

    // 3. identity ------------------------------------------------------------
    const who = await mcp(grant, { method: 'tools/call', params: { name: 'identity.whoami', arguments: {} } });
    const whoResult = toolResultText(who);
    check('whoami resolves the sandbox identity',
      whoResult?.userId === userId && whoResult?.service === 'mcp-sandbox-agent',
      `userId=${whoResult?.userId} service=${whoResult?.service}`);

    // 4. synthetic GitHub form ---------------------------------------------
    const created = await mcp(grant, {
      method: 'tools/call',
      params: {
        name: 'zerocreds_wallet_form_create',
        arguments: {
          provider: 'github',
          kind: 'token',
          title: 'Synthetic GitHub token (sandbox E2E)',
          description: 'Sandbox-only synthetic value. Not a real credential.',
          ttl_minutes: 30,
          idempotency_key: `e2e_${randomUUID().replace(/-/g, '')}`,
        },
      },
    });
    const form = toolResultText(created);
    if (!check('agent creates a synthetic GitHub form',
      typeof form?.form_id === 'string' && typeof form?.url === 'string' && typeof form?.connection_id === 'string',
      `form_id=${form?.form_id} connection_id=${form?.connection_id} error=${form?.content?.[0]?.text ?? ''}`)) {
      throw new Error('cannot continue without a created form');
    }
    pass('agent creates a synthetic GitHub form', `form_id=${form.form_id} connection_id=${form.connection_id}`);

    // 5. browser submits a synthetic-only value ----------------------------
    const syntheticValue = `synthetic-${randomUUID()}-not-a-real-token`;
    const formPage = await fetch(form.url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    const pageText = await formPage.text();
    check('one-time form page is served', formPage.status === 200, `status=${formPage.status}`);
    check('form page discloses the wallet owner and profile',
      pageText.includes('Wallet owner') && pageText.includes(profileId),
      `owner disclosure=${pageText.includes('Wallet owner')} profile disclosure=${pageText.includes(profileId)}`);

    const submitted = await json(form.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { t: form.form_id, fields: { token: syntheticValue } },
    });
    check('synthetic-only value is accepted by the form', submitted.status === 200,
      `status=${submitted.status} body=${JSON.stringify(submitted.body).slice(0, 200)}`);

    // 6. status becomes done, without the value -----------------------------
    const statusCall = await mcp(grant, { method: 'tools/call', params: { name: 'zerocreds_wallet_form_status', arguments: { form_id: form.form_id } } });
    const status = toolResultText(statusCall);
    check('form status reaches done', status?.status === 'done',
      `status=${status?.status} kv_version=${status?.kv_version} error=${statusCall.body?.result?.content?.[0]?.text ?? ''}`);
    check('form status exposes no credential value',
      !JSON.stringify(status).includes(syntheticValue) && !JSON.stringify(statusCall.text).includes(syntheticValue),
      'value absent from the MCP response');

    // 7. no value anywhere the agent can see ---------------------------------
    const leakedIn = observed.findIndex((body) => body.includes(syntheticValue));
    check('submitted value never appears in an MCP response', leakedIn === -1,
      leakedIn === -1 ? `${observed.length} MCP responses scanned` : `response #${leakedIn} contains the value`);

    // 8. cleanup --------------------------------------------------------------
    const cleanup = await revoke(provisionToken, runId);
    check('cleanup revokes the disposable identity',
      cleanup.status === 200 && cleanup.body?.revoked === true,
      `status=${cleanup.status} body=${JSON.stringify(cleanup.body)}`);

    const afterRevoke = await mcp(grant, { method: 'tools/list', params: {} });
    check('revoked identity loses access', afterRevoke.body?.error?.code === -32001,
      `error=${JSON.stringify(afterRevoke.body?.error)}`);

    // 9. bootstrap again, no old state ---------------------------------------
    const secondRunId = randomUUID();
    const secondBoot = await bootstrap(provisionToken, secondRunId);
    if (!check('a later run bootstraps its own identity', secondBoot.status === 201 || secondBoot.status === 200,
      `status=${secondBoot.status} body=${JSON.stringify(secondBoot.body)}`)) {
      throw new Error('cannot continue without a second identity');
    }
    const secondTaskId = `task-${randomUUID()}`;
    const second = {
      authToken,
      runId: secondRunId,
      taskId: secondTaskId,
      profileId: secondBoot.body.profileId,
      proof: signRunBinding({
        privateJwk,
        runId: secondRunId,
        taskId: secondTaskId,
        profileId: secondBoot.body.profileId,
        userId: secondBoot.body.userId,
        allowedTools,
      }),
    };

    const secondWho = await mcp(second, { method: 'tools/call', params: { name: 'identity.whoami', arguments: {} } });
    const secondWhoResult = toolResultText(secondWho);
    check('the later identity is a different principal',
      secondWhoResult?.userId === secondBoot.body.userId && secondWhoResult?.userId !== userId,
      `userId=${secondWhoResult?.userId}`);

    const oldStatus = await mcp(second, {
      method: 'tools/call',
      params: { name: 'zerocreds_wallet_connection_status', arguments: { connection_id: form.connection_id } },
    });
    const oldState = toolResultText(oldStatus);
    const oldVisible = oldStatus.body?.result?.isError !== true
      && typeof oldState === 'object' && oldState !== null
      && ['allocated', 'active'].includes(oldState.state);
    check('the later identity cannot see the old connection', !oldVisible,
      `response=${JSON.stringify(oldStatus.body?.result?.content?.[0]?.text ?? oldStatus.body?.error ?? null).slice(0, 160)}`);

    const oldForm = await mcp(second, {
      method: 'tools/call',
      params: { name: 'zerocreds_wallet_form_status', arguments: { form_id: form.form_id } },
    });
    const oldFormVisible = oldForm.body?.result?.isError !== true;
    check('the later identity cannot see the old form', !oldFormVisible,
      `response=${JSON.stringify(oldForm.body?.result?.content?.[0]?.text ?? oldForm.body?.error ?? null).slice(0, 160)}`);

    await revoke(provisionToken, secondRunId);
  } finally {
    await revoke(provisionToken, runId).catch(() => {});
  }

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
