export interface Sandbox3ProfilePrincipalRecord {
  keyHash: string;
  principalId: string;
  tenantId: string;
  profileId: string;
  repository: string;
  scopes: ['runs:read', 'runs:write'];
  engines: ['eu-vm-agent-run'];
}

export function sandbox3ProfilePrincipalRecord(apiKey: string): Sandbox3ProfilePrincipalRecord;
export function normalizeSandbox3ProfileDelegationSecret(secret: string): string;
export function provisionSandbox3ProfilePrincipal(env?: Record<string, string | undefined>): {
  worker: string;
  principalId: string;
  tenantId: string;
  profileId: string;
  keyRegistry: string;
};
