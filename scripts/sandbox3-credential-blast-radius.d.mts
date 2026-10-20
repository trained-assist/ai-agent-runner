export const BLAST_RADIUS_REF: string;
export const DEFAULT_SERVICE: string;
export const DEFAULT_RUNNER_ROOT: string;
export const LEAK_RELATIVE_PATH: string;

export interface BlastRadiusRegistryEntry {
  connection_id: string;
  env: string;
  field: string;
  scope: string;
}

export interface BlastRadiusHost {
  exec(command: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface BlastRadiusCustody {
  token?: string;
  accountId?: string;
  databaseId?: string;
  walletUrl?: string;
  serviceToken?: string;
}

export function fingerprint(value: string): string;

export function parseStateCwd(stateText: string): { cwd: string; pid: number | null; runState: string | null };

export function parseEngineEnv(envText: string, name: string): string | null;

export function killWorkerCgroup(service: string, runPid: number): string;

export function shellQuote(value: string): string;

export function runCredentialBlastRadiusDrill(input: {
  apiUrl: string;
  apiKey: string;
  registry: Record<string, BlastRadiusRegistryEntry>;
  ref?: string;
  host: BlastRadiusHost;
  custody?: BlastRadiusCustody;
  service?: string;
  runnerRoot?: string;
  kill?: boolean;
  revoke?: boolean;
  waitMs?: number;
  captureWaitMs?: number;
  sweepWaitMs?: number;
}): Promise<string[]>;
