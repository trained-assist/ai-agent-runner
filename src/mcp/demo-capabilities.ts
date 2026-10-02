import type { CapabilityHandler, CapabilityInvocation, CapabilityOutcome } from './capabilities.js';

/**
 * Песочный доменный handler этапа I04 (SANDBOX): ходит в фикстуру «remote domain service».
 * Первый реальный домен для P14 ещё не выбран (эпик E5 #21), поэтому здесь два
 * демонстрационных capability вместо доменных tools продукта.
 *
 * Handler — единственное место, где живёт доменная логика вызова: и MCP-путь рана
 * (tools/call → мост → registry), и внутренний API control plane
 * (POST /v1/capabilities/invoke) приходят в эти же функции. Значение binding'а приходит
 * аргументом от хоста и уходит только в заголовок авторизации исходящего запроса.
 */

export interface FakeRemoteDomainOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5000;

function receiptOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return receiptOf(parsed);
  } catch {
    return null;
  }
}

/** Один исходящий вызов фикстуры: авторизация binding'ом + скоупы binding'а в заголовках. */
async function callFakeRemote(
  options: FakeRemoteDomainOptions,
  invocation: CapabilityInvocation,
  body: Record<string, unknown>,
  bindingValue: string | undefined,
): Promise<CapabilityOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const binding = invocation.binding;
  if (!binding) return { kind: 'blocked', reason: 'no credential binding for this capability' };
  if (!invocation.caller.profileId) return { kind: 'blocked', reason: 'no profile in the trusted caller envelope' };

  const url = `${options.baseUrl.replace(/\/$/, '')}/v1/domain?capability=${encodeURIComponent(invocation.capabilityId)}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bindingValue ?? ''}`,
        'x-binding-ref': binding.ref,
        'x-binding-scope': binding.scope,
        'x-profile-id': invocation.caller.profileId,
        'x-user-task-id': invocation.caller.userTaskId,
      },
      body: JSON.stringify({ ...body, operationId: invocation.caller.operationId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { kind: 'technical_error', code: err instanceof Error && err.name === 'TimeoutError' ? 'REMOTE_TIMEOUT' : 'REMOTE_UNREACHABLE' };
  }

  const payload = parseJson(await response.text()) ?? {};
  if (response.status === 403) {
    const error = receiptOf(payload['error']) ?? {};
    return { kind: 'blocked', reason: `remote refused the binding scope: ${String(error['code'] ?? 'SCOPE_DENIED')}` };
  }
  if (response.status === 401) return { kind: 'blocked', reason: 'remote rejected the credential binding' };
  if (!response.ok) {
    const error = receiptOf(payload['error']) ?? {};
    return { kind: 'technical_error', code: `REMOTE_${response.status}_${String(error['code'] ?? 'UNKNOWN')}` };
  }

  const result = receiptOf(payload['result']) ?? {};
  const remoteReceipt = receiptOf(payload['receipt']) ?? {};
  const receiptId = typeof remoteReceipt['receiptId'] === 'string' ? remoteReceipt['receiptId'] : '';
  if (receiptId.length === 0) {
    // «Ок» без проверяемой квитанции наружу не выходит (ловушка PR-16).
    return { kind: 'technical_error', code: 'REMOTE_RECEIPT_MISSING' };
  }
  return {
    kind: 'completed',
    result: { ...result, remoteReceiptId: receiptId },
    effectReceipt: {
      receiptId,
      capabilityId: invocation.capabilityId,
      capabilityVersion: 1,
      operationId: invocation.caller.operationId,
      bindingRef: binding.ref,
      at: typeof remoteReceipt['at'] === 'string' ? remoteReceipt['at'] : new Date().toISOString(),
      ...(typeof remoteReceipt['externalRef'] === 'string' ? { externalRef: remoteReceipt['externalRef'] } : {}),
    },
  };
}

export function createFakeRemoteDomainCapabilities(options: FakeRemoteDomainOptions): CapabilityHandler[] {
  const searchStatus: CapabilityHandler = {
    capabilityId: 'demo.search_status',
    capabilityVersion: 1,
    requiredScopes: ['demo:read'],
    requiredArguments: ['searchId'],
    effect: 'read',
    description: 'Read the state of a demo search by its id (sandbox I04 domain fixture)',
    async invoke(invocation, context) {
      return callFakeRemote(options, invocation, { searchId: String(invocation.arguments['searchId'] ?? '') }, context.bindingValue);
    },
  };

  const recordNote: CapabilityHandler = {
    capabilityId: 'demo.record_note',
    capabilityVersion: 1,
    requiredScopes: ['demo:write'],
    requiredArguments: ['text'],
    effect: 'write',
    description: 'Store a demo note in the fake remote service and return an effect receipt',
    async invoke(invocation, context) {
      return callFakeRemote(options, invocation, { text: String(invocation.arguments['text'] ?? '') }, context.bindingValue);
    },
  };

  // Инструмент с более узким scope, чем есть у binding'а песочницы: хост обязан отказать
  // раньше исходящего вызова, иначе «разрешения» ничего не значат.
  const adminPurge: CapabilityHandler = {
    capabilityId: 'demo.admin_purge',
    capabilityVersion: 1,
    requiredScopes: ['demo:admin'],
    requiredArguments: ['target'],
    effect: 'write',
    description: 'Destructive demo capability, requires the demo:admin binding scope',
    async invoke(invocation, context) {
      return callFakeRemote(options, invocation, { target: String(invocation.arguments['target'] ?? '') }, context.bindingValue);
    },
  };

  return [searchStatus, recordNote, adminPurge];
}
