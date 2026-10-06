import { readFileSync } from 'node:fs';

export interface VmWorkerBindingDefinition {
  name: string;
  required: boolean;
  secret: boolean;
  source: string;
  owner: string;
  rotatedAt?: string;
}

export interface VmWorkerBindingsInventory {
  schemaVersion: 1;
  workerId: string;
  region: 'eu' | 'ru';
  bindings: VmWorkerBindingDefinition[];
}

export interface VmWorkerBindingCheck extends VmWorkerBindingDefinition {
  configured: boolean;
}

export function readVmWorkerBindingsInventory(path: string): VmWorkerBindingsInventory {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.workerId !== 'string' || !raw.workerId
    || (raw.region !== 'eu' && raw.region !== 'ru') || !Array.isArray(raw.bindings)
    || Object.keys(raw).some((key) => !['schemaVersion', 'workerId', 'region', 'bindings'].includes(key))) {
    throw new Error('worker bindings inventory has an invalid schema');
  }
  const seen = new Set<string>();
  const bindings = raw.bindings.map((entry, index) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !['name', 'required', 'secret', 'source', 'owner', 'rotatedAt'].includes(key))
      || !isEnvName(entry.name) || typeof entry.required !== 'boolean'
      || typeof entry.secret !== 'boolean' || typeof entry.source !== 'string' || !entry.source.trim()
      || typeof entry.owner !== 'string' || !entry.owner.trim()
      || (entry.rotatedAt !== undefined && (typeof entry.rotatedAt !== 'string' || !Number.isFinite(Date.parse(entry.rotatedAt))))) {
      throw new Error(`worker bindings inventory entry ${index} is invalid`);
    }
    if (seen.has(entry.name)) throw new Error(`worker bindings inventory has duplicate ${entry.name}`);
    seen.add(entry.name);
    return {
      name: entry.name,
      required: entry.required,
      secret: entry.secret,
      source: entry.source,
      owner: entry.owner,
      ...(typeof entry.rotatedAt === 'string' ? { rotatedAt: entry.rotatedAt } : {}),
    };
  });
  return { schemaVersion: 1, workerId: raw.workerId, region: raw.region, bindings };
}

/** Reports presence only; secret values are never read into a response or log. */
export function checkVmWorkerBindings(inventory: VmWorkerBindingsInventory, env: Record<string, string | undefined>): {
  ready: boolean;
  bindings: VmWorkerBindingCheck[];
  missingRequired: string[];
  warnings: string[];
} {
  const bindings = inventory.bindings.map((binding) => ({
    ...binding,
    configured: env[binding.name] !== undefined && env[binding.name]!.trim() !== '',
  }));
  const missingRequired = bindings.filter((binding) => binding.required && !binding.configured).map((binding) => binding.name);
  const warnings = bindings.filter((binding) => binding.secret && binding.owner.toUpperCase().includes('UNASSIGNED'))
    .map((binding) => `${binding.name}: secret owner is not assigned`);
  warnings.push(...bindings.filter((binding) => binding.secret && binding.rotatedAt === undefined)
    .map((binding) => `${binding.name}: secret rotation date is not recorded`));
  return { ready: missingRequired.length === 0, bindings, missingRequired, warnings };
}

function isEnvName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
