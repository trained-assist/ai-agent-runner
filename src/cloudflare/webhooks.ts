import type { ApiPrincipal, RunnerWorkerEnv } from './types.js';

export interface WebhookConnection {
  webhookId: string;
  principalId: string;
  profileId: string;
  tenantId?: string;
  url: string;
  secretBinding: string;
}

export interface WebhookDelivery {
  webhookId: string;
  url: string;
  secretBinding: string;
  attempts: number;
  nextAttemptAt: string;
  deliveredAt?: string;
  exhaustedAt?: string;
  lastStatus?: number;
  lastError?: string;
}

const WEBHOOK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET_BINDING = /^RUNNER_WEBHOOK_SECRET_[A-Z0-9_]{1,80}$/;

export function validWebhookUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443')
      && raw.length <= 2048 && /^[a-z0-9.-]+$/.test(host) && host.includes('.')
      && !/^\d+(?:\.\d+){3}$/.test(host) && !host.startsWith('.') && !host.endsWith('.')
      && !['local', 'localhost', 'internal', 'invalid', 'test', 'example'].includes(host.split('.').at(-1) ?? '')
      && host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  } catch { return false; }
}

export function loadWebhookConnections(env: RunnerWorkerEnv): WebhookConnection[] {
  const parsed: unknown = JSON.parse(env.RUNNER_WEBHOOKS ?? '[]');
  if (!Array.isArray(parsed) || parsed.length > 1000 || parsed.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
    const item = entry as Record<string, unknown>;
    return Object.keys(item).some((field) => !['webhookId', 'principalId', 'profileId', 'tenantId', 'url', 'secretBinding'].includes(field))
      || typeof item['webhookId'] !== 'string' || !WEBHOOK_ID.test(item['webhookId'])
      || typeof item['principalId'] !== 'string' || !item['principalId']
      || typeof item['profileId'] !== 'string' || !item['profileId']
      || item['tenantId'] !== undefined && (typeof item['tenantId'] !== 'string' || !item['tenantId'])
      || typeof item['url'] !== 'string' || !validWebhookUrl(item['url'])
      || typeof item['secretBinding'] !== 'string' || !SECRET_BINDING.test(item['secretBinding']);
  })) throw new Error('RUNNER_WEBHOOKS must contain valid principal-bound HTTPS endpoints');
  const entries = parsed as WebhookConnection[];
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.principalId}\0${entry.profileId}\0${entry.tenantId ?? ''}\0${entry.webhookId}`;
    if (keys.has(key)) throw new Error('RUNNER_WEBHOOKS contains a duplicate webhook ID for one principal');
    keys.add(key);
  }
  return entries;
}

export function principalWebhooks(env: RunnerWorkerEnv, principal: ApiPrincipal): Array<{ webhookId: string; url: string }> {
  if (env.RUNNER_WEBHOOKS_ENABLED !== 'true') return [];
  return loadWebhookConnections(env).filter((entry) => entry.principalId === principal.principalId
    && entry.profileId === principal.profileId && entry.tenantId === principal.tenantId
    && typeof env[entry.secretBinding] === 'string' && (env[entry.secretBinding] as string).length >= 24)
    .map((entry) => ({ webhookId: entry.webhookId, url: entry.url }));
}

export function resolveWebhook(env: RunnerWorkerEnv, principal: ApiPrincipal, webhookId: string): WebhookConnection | null {
  if (!WEBHOOK_ID.test(webhookId)) return null;
  return loadWebhookConnections(env).find((entry) => entry.webhookId === webhookId
    && entry.principalId === principal.principalId && entry.profileId === principal.profileId
    && entry.tenantId === principal.tenantId) ?? null;
}

export async function deliverTerminalWebhook(env: RunnerWorkerEnv, delivery: WebhookDelivery,
  run: { runId: string; state: string; finishedAt: string | null; result?: Record<string, unknown> }): Promise<number> {
  const secret = env[delivery.secretBinding];
  if (typeof secret !== 'string' || secret.length < 24) throw new Error('webhook signing secret is unavailable');
  const text = typeof run.result?.['text'] === 'string' ? run.result['text'] : '';
  const resultUrl = new URL(`/v1/developer/runs/${run.runId}/result`, env.RUNNER_API_PUBLIC_URL).href;
  const body = JSON.stringify({ eventId: `terminal:${run.runId}`, type: 'run.terminal', runId: run.runId,
    state: run.state, occurredAt: run.finishedAt, resultUrl,
    result: { outcome: run.result?.['outcome'] ?? run.state, text: text.slice(0, 16_000), truncated: text.length > 16_000,
      available: !!run.result } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
  const signature = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const send = env.FETCH ?? fetch;
  const response = await send(delivery.url, { method: 'POST', redirect: 'manual', body, signal: AbortSignal.timeout(8_000),
    headers: { 'content-type': 'application/json', 'x-serverlessagence-event': 'run.terminal',
      'x-serverlessagence-delivery': `terminal:${run.runId}`, 'x-serverlessagence-timestamp': timestamp,
      'x-serverlessagence-signature': `v1=${signature}` } });
  return response.status;
}
