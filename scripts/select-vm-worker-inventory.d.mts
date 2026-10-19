export function parseInventoryWorkerId(inventoryText: string, file?: string): string;
export function selectVmWorkerInventory(
  inventoryDir: string,
  workerId: string,
  readDir?: (path: string) => Promise<string[]>,
  read?: (path: string, encoding: string) => Promise<string>,
): Promise<string>;
