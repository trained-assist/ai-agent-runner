import type { ApiPrincipal, RunnerWorkerEnv } from './types.js';
import { principalWebhooks } from './webhooks.js';
import { githubConnectionConfigured } from './github-connection.js';

const RUN_ID = /^run_[0-9a-f]{64}_[0-9a-f]{24}$/;
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIONS = new Set(['result', 'events', 'artifacts', 'webhook']);

function failure(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } });
}

async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function developerCapabilities(env: RunnerWorkerEnv, principal: ApiPrincipal): Response {
  const allowed = new Set((env.ALLOWED_ENVIRONMENT_NAMES ?? '').split(',').map((name) => name.trim()));
  if (env.RUNNER_DEVELOPER_MANAGED_MODEL && !/^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/.test(env.RUNNER_DEVELOPER_MANAGED_MODEL)) {
    return failure('SERVER_MISCONFIGURED', 'managed model identifier is invalid', 503);
  }
  const managed = allowed.has('LLM_LADDER_TOKEN') && !!env.LLM_LADDER_TOKEN;
  let connections: unknown = [];
  if (env.RUNNER_MODEL_CONNECTIONS !== undefined) {
    try { connections = JSON.parse(env.RUNNER_MODEL_CONNECTIONS); } catch { return failure('SERVER_MISCONFIGURED', 'model connection registry is invalid', 503); }
    if (!Array.isArray(connections)) return failure('SERVER_MISCONFIGURED', 'model connection registry is invalid', 503);
  }
  const byokConnections = (connections as unknown[]).filter((item): item is Record<string, unknown> => plainObject(item)
    && item['principalId'] === principal.principalId && item['profileId'] === principal.profileId
    && item['tenantId'] === principal.tenantId && item['provider'] === 'openai'
    && typeof item['connectionId'] === 'string' && CONNECTION_ID.test(item['connectionId'])
    && typeof item['model'] === 'string' && /^openai\/[A-Za-z0-9._:-]{1,100}$/.test(item['model'])
    && typeof item['secretBinding'] === 'string' && /^RUNNER_MODEL_SECRET_[A-Z0-9_]{1,80}$/.test(item['secretBinding'])
    && typeof env[item['secretBinding']] === 'string' && allowed.has('OPENAI_API_KEY')
    && env.RUNNER_BYOK_ENABLED === 'true')
    .map((item) => ({ connectionId: item['connectionId'], provider: 'openai', model: item['model'] }));
  let webhooks: Array<{ webhookId: string; url: string }>;
  try { webhooks = principalWebhooks(env, principal); } catch { return failure('SERVER_MISCONFIGURED', 'webhook registry is invalid', 503); }
  return Response.json({ contractVersion: 1, execution: 'eu-vm-agent-run', isolation: 'none',
    limits: { maxTimeoutSeconds: 3600, maxPromptCharacters: 100_000 },
    managedAvailable: managed, managedModel: env.RUNNER_DEVELOPER_MANAGED_MODEL ?? null, byokConnections, webhooks,
    features: { status: true, result: true, events: true, artifacts: true, cancel: true,
      webhooks: env.RUNNER_WEBHOOKS_ENABLED === 'true', billing: false, selfServiceConnections: false,
      githubConnectionIntake: githubConnectionConfigured(env) } },
  { headers: { 'cache-control': 'no-store' } });
}

export function developerWebhooks(env: RunnerWorkerEnv, principal: ApiPrincipal): Response {
  try { return Response.json({ webhooks: principalWebhooks(env, principal) }, { headers: { 'cache-control': 'no-store' } }); }
  catch { return failure('SERVER_MISCONFIGURED', 'webhook registry is invalid', 503); }
}

/**
 * Additive façade over the existing task-keyed coordinator. The principal, idempotency,
 * persistence, status, cancellation and VM dispatch all remain owned by the legacy path.
 * This route is explicitly provisioned per API key; it is not self-service admission.
 */
export async function developerRequest(request: Request, env: RunnerWorkerEnv, principal: ApiPrincipal): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.split('/').filter(Boolean);
  if (path.length < 3 || path.length > 5 || path[0] !== 'v1' || path[1] !== 'developer' || path[2] !== 'runs') {
    return failure('ROUTE_NOT_FOUND', 'unknown developer route', 404);
  }
  if (path.length === 3) {
    if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 'run creation supports POST only', 405);
    if (!principal.scopes.includes('runs:write')) return failure('FORBIDDEN', 'runs:write scope is required', 403);
    const key = request.headers.get('idempotency-key')?.trim() ?? '';
    if (!key || key.length > 200) return failure('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key is required (maximum 200 characters)', 400);
    if (Number(request.headers.get('content-length') ?? 0) > 1_000_000) return failure('BODY_TOO_LARGE', 'request body exceeds 1000000 bytes', 413);
    let body: unknown;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > 1_000_000) return failure('BODY_TOO_LARGE', 'request body exceeds 1000000 bytes', 413);
      body = JSON.parse(text);
    } catch { return failure('INVALID_REQUEST', 'request body must be JSON', 400); }
    if (!plainObject(body) || Object.keys(body).some((field) => !['prompt', 'model', 'limits', 'webhookId'].includes(field))) {
      return failure('INVALID_REQUEST', 'only prompt, model, limits and webhookId are supported', 400);
    }
    const prompt = body['prompt'];
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100_000) return failure('INVALID_REQUEST', 'prompt must be non-empty and at most 100000 characters', 400);
    const webhookId = body['webhookId'];
    if (webhookId !== undefined && (typeof webhookId !== 'string' || !CONNECTION_ID.test(webhookId))) {
      return failure('INVALID_REQUEST', 'webhookId must be a safe registered identifier', 400);
    }
    const model = body['model'];
    if (!plainObject(model) || Object.keys(model).some((field) => !['mode', 'connectionId'].includes(field)) || !['managed', 'byok'].includes(String(model['mode']))) {
      return failure('INVALID_REQUEST', 'model.mode must be managed or byok', 400);
    }
    const limits = body['limits'];
    if (limits !== undefined && (!plainObject(limits) || Object.keys(limits).some((field) => field !== 'timeoutSeconds')
      || !Number.isSafeInteger(limits['timeoutSeconds']) || Number(limits['timeoutSeconds']) < 1 || Number(limits['timeoutSeconds']) > 3600)) {
      return failure('INVALID_REQUEST', 'limits.timeoutSeconds must be between 1 and 3600', 400);
    }
    if (!principal.repository) return failure('SERVER_MISCONFIGURED', 'developer principal requires a trusted repository binding', 503);
    const requestedMode = model['mode'];
    let credentialBindings: Array<{ type: string; connectionId: string }> = [];
    let envAllowlist: string[] = [];
    if (requestedMode === 'managed') {
      if (model['connectionId'] !== undefined) return failure('INVALID_REQUEST', 'managed mode does not accept connectionId', 400);
      if (!env.LLM_LADDER_TOKEN || !(env.ALLOWED_ENVIRONMENT_NAMES ?? '').split(',').map((v) => v.trim()).includes('LLM_LADDER_TOKEN')) {
        return failure('SERVER_MISCONFIGURED', 'managed model access is not configured for this lane', 503);
      }
      envAllowlist = ['LLM_LADDER_TOKEN'];
      if (env.RUNNER_DEVELOPER_MANAGED_MODEL && !/^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/.test(env.RUNNER_DEVELOPER_MANAGED_MODEL)) {
        return failure('SERVER_MISCONFIGURED', 'managed model identifier is invalid', 503);
      }
    } else {
      if (typeof model['connectionId'] !== 'string' || !CONNECTION_ID.test(model['connectionId'])) {
        return failure('INVALID_REQUEST', 'byok mode requires a valid connectionId', 400);
      }
      credentialBindings = [{ type: 'openai', connectionId: model['connectionId'] }];
    }
    const taskHash = await hash(`${principal.principalId}\0${principal.profileId}\0${key}`);
    const taskId = `dev-${taskHash.slice(0, 48)}`;
    const legacyBody = { userTaskId: taskId, input: { inlinePrompt: prompt }, envAllowlist,
      limits: { timeoutMs: Number(limits?.['timeoutSeconds'] ?? 300) * 1000 },
      ...(webhookId ? { webhookId } : {}),
      ...(requestedMode === 'managed' && env.RUNNER_DEVELOPER_MANAGED_MODEL ? {
        engine: { name: env.RUNNER_ENGINE || 'eu-vm-agent-run', adapterVersion: '1', modelSettings: { model: env.RUNNER_DEVELOPER_MANAGED_MODEL } },
      } : {}),
      ...(credentialBindings.length ? { credentialBindings } : {}) };
    const headers = new Headers({ 'content-type': 'application/json', 'idempotency-key': key,
      'x-runner-principal': JSON.stringify(principal) });
    const objectName = `task-${await hash(`${principal.principalId}\0${principal.profileId}\0${taskId}`)}`;
    const object = env.RUNNER_RUNS.get(env.RUNNER_RUNS.idFromName(objectName));
    const response = await object.fetch(new Request('https://runner-runs.internal/v1/runs', { method: 'POST', headers, body: JSON.stringify(legacyBody) }));
    if (!response.ok) return response;
    const receipt = await response.json() as { runId: string; deduplicated: boolean };
    return Response.json({ ...receipt, id: receipt.runId, statusUrl: `/v1/developer/runs/${receipt.runId}`,
      resultUrl: `/v1/developer/runs/${receipt.runId}/result` },
    { status: response.status, headers: { 'cache-control': 'no-store' } });
  }
  const runId = path[3];
  if (!runId || !RUN_ID.test(runId)) return failure('INVALID_REQUEST', 'invalid run id', 400);
  const action = path[4] ?? 'status';
  if (action !== 'status' && action !== 'cancel' && !ACTIONS.has(action)) return failure('ROUTE_NOT_FOUND', 'unknown run action', 404);
  const write = action === 'cancel';
  if (request.method !== (write ? 'POST' : 'GET')) return failure('METHOD_NOT_ALLOWED', 'method not allowed', 405);
  if (!principal.scopes.includes(write ? 'runs:write' : 'runs:read')) return failure('FORBIDDEN', 'required run scope is missing', 403);
  if (url.search && action !== 'events' && action !== 'artifacts') return failure('INVALID_REQUEST', 'query parameters are not supported for this action', 400);
  const object = env.RUNNER_RUNS.get(env.RUNNER_RUNS.idFromName(`task-${runId.split('_')[1]}`));
  const headers = new Headers({ 'x-runner-principal': JSON.stringify(principal) });
  if (write) headers.set('content-type', 'application/json');
  const internalUrl = `https://runner-runs.internal/v1/runs/${runId}/${action}${url.search}`;
  return object.fetch(new Request(internalUrl, { method: request.method, headers, ...(write ? { body: '{}' } : {}) }));
}
