export interface DeveloperRecord {
  keyHash: string;
  principalId: string;
  tenantId: string;
  profileId: string;
  repository: string;
  scopes: string[];
  engines: string[];
  developerApi: true;
}

export const API_ORIGIN: string;
export const KEY_PATH: string;
export function developerRecord(key: string): DeveloperRecord;
export function readKey(path?: string): string;
export function initializeKey(path?: string): { created: boolean; path: string };
export function waitForBuildSha(
  expectedSha: string,
  options?: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    delays?: number[];
  },
): Promise<{ buildSha?: string; [key: string]: unknown }>;
