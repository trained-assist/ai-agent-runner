import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { generateApiKey, KeyRegistry, keyRecordFor } from '../src/api/auth.js';
import { createAgentApiServer } from '../src/api/server.js';
import { AgentApi } from '../src/api/service.js';
import { adapterFor, startMockWorker } from './external-worker-harness.js';

describe('file-backed API key registry', () => {
  it('rotates and revokes keys across concurrent HTTP requests without restarting the API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-key-reload-'));
    const path = join(dir, 'keys.json');
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const oldKey = generateApiKey();
    const newKey = generateApiKey();
    const principal = { principalId: 'p-a', tenantId: 'tenant-a', profileId: 'profile-a', scopes: ['runs:read'] as const };
    const record = (key: string) => keyRecordFor(key, { ...principal, scopes: [...principal.scopes] });
    const replace = (keys: string[]) => {
      const next = join(dir, 'keys.next.json');
      writeFileSync(next, JSON.stringify({ schemaVersion: 1, principals: keys.map(record) }));
      renameSync(next, path);
    };
    replace([oldKey]);

    const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => logs.mockRestore());
    const registry = KeyRegistry.loadFile(path);
    const worker = await startMockWorker();
    onTestFinished(() => worker.close());
    const api = new AgentApi({ workers: [adapterFor(worker)] });
    onTestFinished(() => api.dispose());
    const server = createAgentApiServer(api, { keys: registry });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onTestFinished(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const status = async (key: string) => (await fetch(`${base}/v1/capabilities`, {
      headers: { authorization: `Bearer ${key}` },
    })).status;

    expect(await status(oldKey)).toBe(200);
    replace([newKey]);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => status(index % 2 === 0 ? oldKey : newKey)));
    expect(results).toEqual(Array.from({ length: 20 }, (_, index) => index % 2 === 0 ? 401 : 200));
    expect(logs).toHaveBeenCalledWith(expect.stringContaining('"event":"key_registry_reloaded","keys":1'));

    replace([]);
    expect(await status(newKey)).toBe(401);
    expect(registry.size()).toBe(0);
    unlinkSync(path);
    expect(await status(newKey)).toBe(401);

    writeFileSync(path, '{ malformed json');
    expect(await status(newKey)).not.toBe(200);
    replace([newKey]);
    expect(await status(newKey)).toBe(200);
  });
});
