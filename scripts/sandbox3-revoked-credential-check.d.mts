export const REVOKED_CREDENTIAL_REF: string;

export interface RevokedCredentialTarget {
  connection_id: string;
  env: string;
  field: string;
  scope: string;
}

export function revokedCredentialTarget(
  registry: Record<string, RevokedCredentialTarget>,
  ref?: string,
): RevokedCredentialTarget;

export function runRevokedCredentialCheck(input: {
  apiUrl: string;
  apiKey: string;
  registry: Record<string, RevokedCredentialTarget>;
  ref?: string;
  custody?: { token?: string; accountId?: string; databaseId?: string };
}): Promise<string[]>;
