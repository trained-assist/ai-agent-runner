import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseInventoryWorkerId, selectVmWorkerInventory } from '../scripts/select-vm-worker-inventory.mjs';

const inventory = (workerId: string) => JSON.stringify({
  schemaVersion: 1,
  workerId,
  bindings: [{ name: 'OPENCODE_BIN', required: true, secret: false, source: 'systemd:/etc/ai-agent-runner/worker.env' }],
});

describe('VM worker binding inventory selection', () => {
  it('reads the workerId the inventory declares', () => {
    expect(parseInventoryWorkerId(inventory('other-vm-1'), 'other.json')).toBe('other-vm-1');
  });

  it('refuses an inventory that cannot identify its worker', () => {
    expect(() => parseInventoryWorkerId('not json', 'x.json')).toThrow('not valid JSON');
    expect(() => parseInventoryWorkerId(JSON.stringify({ schemaVersion: 1, bindings: [{}] }), 'x.json')).toThrow('does not declare a workerId');
    expect(() => parseInventoryWorkerId(JSON.stringify({ schemaVersion: 2, workerId: 'a', bindings: [{}] }), 'x.json')).toThrow('unsupported schemaVersion');
    expect(() => parseInventoryWorkerId(JSON.stringify({ schemaVersion: 1, workerId: 'a', bindings: [] }), 'x.json')).toThrow('declares no bindings');
  });

  it('selects the inventory whose workerId matches the host, not the first file', async () => {
    const files: Record<string, string> = {
      '/inv/france.json': inventory('eu-vm2-sandbox'),
      '/inv/other.json': inventory('other-vm-1'),
    };
    const readDir = async () => Object.keys(files).map((p) => p.split('/').pop() as string);
    const read = async (p: string) => files[p] as string;
    expect(await selectVmWorkerInventory('/inv', 'other-vm-1', readDir, read)).toBe('/inv/other.json');
    expect(await selectVmWorkerInventory('/inv', 'eu-vm2-sandbox', readDir, read)).toBe('/inv/france.json');
  });

  it('refuses to install another worker inventory or an ambiguous one', async () => {
    const one: Record<string, string> = { '/inv/france.json': inventory('eu-vm2-sandbox') };
    const readDir = async () => ['france.json'];
    const read = async (p: string) => one[p] as string;
    await expect(selectVmWorkerInventory('/inv', 'other-vm-1', readDir, read)).rejects.toThrow('No binding inventory');
    await expect(selectVmWorkerInventory('/inv', '', readDir, read)).rejects.toThrow('VM_WORKER_ID is required');

    const twice: Record<string, string> = { '/inv/a.json': inventory('other-vm-1'), '/inv/b.json': inventory('other-vm-1') };
    const readDir2 = async () => ['a.json', 'b.json'];
    const read2 = async (p: string) => twice[p] as string;
    await expect(selectVmWorkerInventory('/inv', 'other-vm-1', readDir2, read2)).rejects.toThrow('Multiple binding inventories');
  });

  it('finds the committed France inventory and no other region', async () => {
    const dir = new URL('../deploy/vm-worker/inventory/', import.meta.url).pathname;
    expect(await selectVmWorkerInventory(dir, 'eu-vm2-sandbox')).toContain('france.json');
    expect(parseInventoryWorkerId(readFileSync(`${dir}france.json`, 'utf8'), 'france.json')).toBe('eu-vm2-sandbox');
    // The Russia inventory is gone with the Russia deployment path: a host that
    // asks for it must be refused rather than given another worker's inventory.
    await expect(selectVmWorkerInventory(dir, 'ru-vm-1')).rejects.toThrow('No binding inventory');
  });
});
