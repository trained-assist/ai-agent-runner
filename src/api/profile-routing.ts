import { WorkspaceError } from '../workspace/contract.js';

export interface ProfileRepositoryRoute {
  owner: string;
  token: string;
}

export interface TenantProfileRouteDeclaration {
  owner: string;
  tokenEnv: string;
}

/** Parse operator-owned routing config. The JSON contains secret variable names, never values. */
export function parseTenantProfileRoutes(
  raw: string | undefined,
  env: Record<string, string | undefined>,
): Record<string, ProfileRepositoryRoute> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AGENT_API_PROFILE_TENANT_ROUTES_JSON must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('AGENT_API_PROFILE_TENANT_ROUTES_JSON must be an object keyed by trusted tenantId');
  }
  const routes = Object.create(null) as Record<string, ProfileRepositoryRoute>;
  for (const [tenantId, value] of Object.entries(parsed)) {
    if (!tenantId.trim() || typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('AGENT_API_PROFILE_TENANT_ROUTES_JSON contains an invalid route');
    }
    const declaration = value as Record<string, unknown>;
    if (Object.keys(declaration).some((key) => key !== 'owner' && key !== 'tokenEnv')) {
      throw new Error(`profile route for tenant ${tenantId} contains an unsupported field`);
    }
    const owner = declaration['owner'];
    const tokenEnv = declaration['tokenEnv'];
    if (typeof owner !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(owner)) {
      throw new Error(`profile route for tenant ${tenantId} has an invalid owner`);
    }
    if (typeof tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(tokenEnv)) {
      throw new Error(`profile route for tenant ${tenantId} has an invalid tokenEnv name`);
    }
    const token = env[tokenEnv]?.trim();
    if (!token) throw new Error(`profile route for tenant ${tenantId} is missing its configured GitHub credential`);
    routes[tenantId] = { owner, token };
  }
  return routes;
}

export function requireTenantProfileRoute(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '' || raw.trim().toLowerCase() === 'false') return false;
  if (raw.trim().toLowerCase() === 'true') return true;
  throw new Error('AGENT_API_PROFILE_REQUIRE_TENANT_ROUTE must be true or false');
}

export function selectProfileRepositoryRoute(input: {
  tenantId: string;
  defaultRoute: ProfileRepositoryRoute;
  tenantRoutes?: Record<string, ProfileRepositoryRoute>;
  requireTenantRoute?: boolean;
}): ProfileRepositoryRoute {
  const routes = input.tenantRoutes;
  const route = routes && Object.prototype.hasOwnProperty.call(routes, input.tenantId)
    ? routes[input.tenantId]
    : undefined;
  if (route) return route;
  if (input.requireTenantRoute) {
    throw new WorkspaceError('WORKSPACE_FORBIDDEN', 'API key tenant has no configured profile repository route');
  }
  return input.defaultRoute;
}
