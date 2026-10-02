import { describe, expect, it } from 'vitest';
import { alphaKey, authHeader, startHttpHarness } from './api-http-harness.js';
import { demoRegistry, fixtureBindingResolver, startFakeRemote } from './mcp-helpers.js';

const WRITE_BINDING = 'cred:demo-domain-write';
const READONLY_BINDING = 'cred:demo-domain-readonly';

/**
 * Тот же capability handler, что обслуживает MCP-вызовы рана (карточка P13), должен
 * вызываться и через внутренний API control plane: бизнес-логика домена не дублируется
 * в транспортных фасадах (TASK-ROUTER-AND-MCP §5).
 */
describe('capability facade: один handler — два транспорта (P13)', () => {
  it('вызов через API даёт тот же effect receipt, а чужой scope получает 403', async () => {
    const remote = await startFakeRemote();
    const api = await startHttpHarness({
      capabilities: demoRegistry(remote.baseUrl),
      bindingResolver: fixtureBindingResolver({ [WRITE_BINDING]: remote.token, [READONLY_BINDING]: remote.token }),
    });
    try {
      const invoke = async (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
        const response = await fetch(`${api.base}/v1/capabilities/invoke`, {
          method: 'POST',
          headers: { ...authHeader(alphaKey), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      };

      const completed = await invoke({
        capabilityId: 'demo.record_note',
        arguments: { text: 'через API facade' },
        bindingRef: WRITE_BINDING,
        bindingScope: 'demo:write',
        userTaskId: 'task-api-facade',
      });
      expect(completed.status).toBe(200);
      const receipt = (completed.body['effectReceipt'] ?? {}) as Record<string, unknown>;
      expect(String(receipt['receiptId'])).toMatch(/^rcpt-/);
      expect(receipt['bindingRef']).toBe(WRITE_BINDING);
      expect(receipt['operationId']).toMatch(/^op_/);

      // Тот же доменный вызов ушёл в тот же внешний сервис: одна квитанция эффекта.
      const remoteReceipts = remote.receipts().filter((entry) => entry['capabilityId'] === 'demo.record_note');
      expect(remoteReceipts).toHaveLength(1);
      expect(remoteReceipts[0]?.['bindingRef']).toBe(WRITE_BINDING);

      // Чужой scope: capability под read-only binding'ом — отказ, эффекта нет.
      const denied = await invoke({
        capabilityId: 'demo.admin_purge',
        arguments: { target: 'profile-a' },
        bindingRef: READONLY_BINDING,
        bindingScope: 'demo:read',
      });
      expect(denied.status).toBe(403);
      // Наружу — ApiError-код; конкретная причина видна в details, как и на MCP-пути.
      expect(denied.body['error']).toMatchObject({ code: 'SCOPE_DENIED' });
      expect((denied.body['error'] as { details?: Record<string, unknown> }).details).toMatchObject({
        capabilityId: 'demo.admin_purge',
        bindingScope: 'demo:read',
        requiredScopes: ['demo:admin'],
      });
      expect(remote.logLines().filter((entry) => entry['capabilityId'] === 'demo.admin_purge')).toHaveLength(0);

      // Обязательные аргументы — missing_input, а не выдуманный результат.
      const missing = await invoke({ capabilityId: 'demo.record_note', arguments: {}, bindingRef: WRITE_BINDING, bindingScope: 'demo:write' });
      expect(missing.status).toBe(400);
      expect(missing.body['outcome']).toBe('missing_input');

      // Неизвестная capability и вызов без binding'а.
      const unknown = await invoke({ capabilityId: 'demo.nope', arguments: {} });
      expect(unknown.status).toBe(404);
      expect(unknown.body['error']).toMatchObject({ code: 'CAPABILITY_NOT_FOUND' });
      const noBinding = await invoke({ capabilityId: 'demo.record_note', arguments: { text: 'x' } });
      expect(noBinding.status).toBe(403);
      expect(noBinding.body['error']).toMatchObject({ code: 'CAPABILITY_BLOCKED' });

      // Контракт объявляет честный статус MCP, включая отсутствие доказанной OS-изоляции.
      const caps = (await (await fetch(`${api.base}/v1/capabilities`, { headers: authHeader(alphaKey) })).json()) as {
        mcp: Record<string, unknown>;
      };
      expect(caps.mcp).toMatchObject({
        perRunStdioProxy: true,
        scopedBindings: true,
        capabilityHandlersSharedWithMcp: true,
        capabilityInvokeEndpoint: true,
        remoteTransport: 'absent',
        osIsolation: 'not_proven_service_uid_only',
      });
      const apiLogs = api.logs.filter((entry) => entry['event'] === 'capability_invoked');
      expect(apiLogs.some((entry) => entry['effectReceiptId'] === receipt['receiptId'])).toBe(true);
    } finally {
      await api.close();
      await remote.stop();
    }
  }, 40_000);

  it('без реестра capability маршрут не объявляется', async () => {
    const api = await startHttpHarness();
    try {
      const response = await fetch(`${api.base}/v1/capabilities/invoke`, {
        method: 'POST',
        headers: { ...authHeader(alphaKey), 'content-type': 'application/json' },
        body: JSON.stringify({ capabilityId: 'demo.record_note', arguments: { text: 'x' } }),
      });
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('ROUTE_NOT_FOUND');
    } finally {
      await api.close();
    }
  }, 20_000);
});
