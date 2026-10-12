export interface ProductionRunnerPrincipalRecord {
  keyHash: string;
  principalId: string;
  tenantId: string;
  profileId: string;
  repository: string;
  scopes: string[];
  engines: string[];
}

export function productionRunnerPrincipalRecord(apiKey: string): ProductionRunnerPrincipalRecord;
export function hasExpectedProductionCapabilities(body: unknown): boolean;
