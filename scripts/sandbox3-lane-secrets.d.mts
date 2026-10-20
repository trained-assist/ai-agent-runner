export const SANDBOX3_WORKER: string;
export const SANDBOX3_CONFIG: string;

export function sandbox3LaneSecret(
  env: Record<string, string | undefined> | undefined,
  name: string,
  minimumLength?: number,
): string;

export function putSandbox3Secret(name: string, value: string): void;

export function provisionSandbox3LaneSecrets(
  env?: Record<string, string | undefined>,
  putSecret?: (name: string, value: string) => void,
): { worker: string; secrets: string[] };
