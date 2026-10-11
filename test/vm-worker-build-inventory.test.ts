import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkVmWorkerBindings, readVmWorkerBindingsInventory } from '../src/vm-worker/bindings-inventory.js';

describe('VM worker build and binding inventory', () => {
  const tempDirs: string[] = [];
  afterEach(() => { for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

  it('reports missing required bindings and rotation/owner gaps without values', () => {
    const inventory = {
      schemaVersion: 1 as const,
      workerId: 'france-worker',
      region: 'eu' as const,
      bindings: [
        { name: 'VM_WORKER_TOKEN', required: true, secret: true, source: 'systemd:worker.env', owner: 'UNASSIGNED — assign named owner' },
        { name: 'GCS_BUCKET', required: true, secret: false, source: 'systemd:worker.env', owner: 'platform' },
      ],
    };
    const checked = checkVmWorkerBindings(inventory, { GCS_BUCKET: 'private-bucket-name', VM_WORKER_TOKEN: '' });
    expect(checked.ready).toBe(false);
    expect(checked.missingRequired).toEqual(['VM_WORKER_TOKEN']);
    expect(checked.warnings).toContain('VM_WORKER_TOKEN: secret owner is not assigned');
    expect(checked.warnings).toContain('VM_WORKER_TOKEN: secret rotation date is not recorded');
    expect(JSON.stringify(checked)).not.toContain('private-bucket-name');
  });

  it('rejects duplicate binding names and inventory fields that could carry secret values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vm-worker-inventory-'));
    tempDirs.push(dir);
    const path = join(dir, 'bindings.json');
    const valid = { schemaVersion: 1, workerId: 'ru-worker', region: 'ru', bindings: [
      { name: 'VM_WORKER_TOKEN', required: true, secret: true, source: 'file', owner: 'ops' },
    ] };
    writeFileSync(path, JSON.stringify({ ...valid, bindings: [...valid.bindings, ...valid.bindings] }));
    expect(() => readVmWorkerBindingsInventory(path)).toThrow('duplicate VM_WORKER_TOKEN');
    writeFileSync(path, JSON.stringify({ ...valid, bindings: [{ ...valid.bindings[0], value: 'must-not-be-here' }] }));
    expect(() => readVmWorkerBindingsInventory(path)).toThrow('entry 0 is invalid');
  });

  it('declares every startup-required VM binding in each deploy inventory', () => {
    const requiredAtStartup = [
      'VM_WORKER_BINDINGS_INVENTORY', 'VM_WORKER_ENGINE', 'VM_WORKER_PUBLIC_URL', 'VM_WORKER_TOKEN',
      'VM_WORKER_ALLOWED_REPOSITORIES', 'VM_WORKER_ALLOWED_ENV', 'VM_WORKER_ALLOWED_CALLBACK_ORIGINS',
      'VM_WORKER_CPU_RESERVATION_PCT', 'VM_WORKER_MEMORY_RESERVATION_PCT', 'STORAGE_BACKEND',
      'OPENCODE_BIN', 'AGENT_API_ENGINE_CONFIG_DIR',
    ];
    for (const name of ['france.json', 'russia.json']) {
      const path = new URL(`../deploy/vm-worker/inventory/${name}`, import.meta.url);
      const inventory = readVmWorkerBindingsInventory(path.pathname);
      const bindings = new Map(inventory.bindings.map((binding) => [binding.name, binding]));
      for (const binding of requiredAtStartup) expect(bindings.get(binding)?.required, `${name}: ${binding}`).toBe(true);
    }
  });
});
