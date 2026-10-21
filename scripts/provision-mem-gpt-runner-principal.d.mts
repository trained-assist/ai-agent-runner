export const MEM_GPT_WORKER: string;
export const MEM_GPT_PRINCIPAL_ID: string;
export const MEM_GPT_PROFILE_ID: string;
export const MEM_GPT_BINDING: string;
export const MEM_GPT_REPOSITORY: string;

export function memGptRunnerPrincipalRecord(apiKey: string): Record<string, unknown>;

export function provisionMemGptRunnerPrincipal(env?: Record<string, string | undefined>): Promise<{
  worker: string; principalId: string; profileId: string; mcpBindings: string[];
  keyRegistry: string; versionId: string; keyFile: string;
}>;
