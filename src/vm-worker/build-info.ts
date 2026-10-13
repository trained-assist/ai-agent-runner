import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface VmWorkerBuildInfo {
  schemaVersion: 1;
  version: string;
  sourceCommit: string;
  builtAt: string;
  buildUrl?: string;
  opencode?: { version: string; sourceCommit: string; binarySha256: string };
}

const EMPTY_BUILD: VmWorkerBuildInfo = {
  schemaVersion: 1,
  version: '0.0.0-dev',
  sourceCommit: 'unknown',
  builtAt: new Date(0).toISOString(),
};

export function readVmWorkerBuildInfo(): VmWorkerBuildInfo {
  try {
    const raw = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'build-info.json'), 'utf8')) as unknown;
    if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.version !== 'string'
      || typeof raw.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(raw.sourceCommit)
      || typeof raw.builtAt !== 'string' || !Number.isFinite(Date.parse(raw.builtAt))) return EMPTY_BUILD;
    return {
      schemaVersion: 1,
      version: raw.version,
      sourceCommit: raw.sourceCommit,
      builtAt: raw.builtAt,
      ...(typeof raw.buildUrl === 'string' ? { buildUrl: raw.buildUrl } : {}),
      ...(isRecord(raw.opencode)
        && typeof raw.opencode.version === 'string'
        && typeof raw.opencode.sourceCommit === 'string' && /^[0-9a-f]{40}$/.test(raw.opencode.sourceCommit)
        && typeof raw.opencode.binarySha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.opencode.binarySha256)
        ? { opencode: { version: raw.opencode.version, sourceCommit: raw.opencode.sourceCommit, binarySha256: raw.opencode.binarySha256 } }
        : {}),
    };
  } catch { return EMPTY_BUILD; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
