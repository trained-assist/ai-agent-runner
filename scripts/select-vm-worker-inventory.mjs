import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Выбор инвентаря биндингов для воркера.
 *
 * Раньше апдейтер жёстко ставил `france.json`, поэтому второй регион было
 * некуда деплоить. Выбираем по `workerId` из самого инвентаря, а не по имени
 * файла: файл можно переименовать, а `VM_WORKER_ID` в инвентаре — это то, чем
 * воркер себя объявляет, и оно же проверяется в `/version`.
 */

export function parseInventoryWorkerId(inventoryText, file = '(inline)') {
  let parsed;
  try {
    parsed = JSON.parse(inventoryText);
  } catch (error) {
    throw new Error(`Binding inventory ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const workerId = parsed?.workerId;
  if (typeof workerId !== 'string' || workerId.trim() === '') {
    throw new Error(`Binding inventory ${file} does not declare a workerId`);
  }
  if (parsed?.schemaVersion !== 1) {
    throw new Error(`Binding inventory ${file} has an unsupported schemaVersion: ${parsed?.schemaVersion}`);
  }
  if (!Array.isArray(parsed?.bindings) || parsed.bindings.length === 0) {
    throw new Error(`Binding inventory ${file} declares no bindings`);
  }
  return workerId;
}

/** Путь к инвентарю, чей workerId совпадает с настройкой воркера. */
export async function selectVmWorkerInventory(inventoryDir, workerId, readDir = readdir, read = readFile) {
  if (typeof workerId !== 'string' || workerId.trim() === '') throw new Error('VM_WORKER_ID is required to select a binding inventory');
  const entries = (await readDir(inventoryDir)).filter((name) => name.endsWith('.json')).sort();
  const matches = [];
  for (const name of entries) {
    const path = join(inventoryDir, name);
    if (parseInventoryWorkerId(await read(path, 'utf8'), name) === workerId) matches.push(path);
  }
  if (matches.length === 0) {
    throw new Error(`No binding inventory in ${inventoryDir} declares workerId ${workerId}; refusing to install another worker's inventory`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple binding inventories declare workerId ${workerId}: ${matches.join(', ')}`);
  }
  return matches[0];
}

const invokedDirectly = process.argv[1]?.endsWith('select-vm-worker-inventory.mjs');
if (invokedDirectly) {
  const [inventoryDir, workerId] = process.argv.slice(2);
  if (!inventoryDir || !workerId) throw new Error('Usage: select-vm-worker-inventory.mjs <inventory-dir> <worker-id>');
  process.stdout.write(`${await selectVmWorkerInventory(inventoryDir, workerId)}\n`);
}
