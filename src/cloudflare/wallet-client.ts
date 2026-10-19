import type { ApiPrincipal, RunnerWorkerEnv } from './types.js';

/**
 * ZeroCreds wallet API client owned by the Runner API host.
 *
 * The Runner API never sees a credential value. It only asks the wallet API to
 * allocate a connection and to open a one-time form URL that the user fills in
 * directly on the ZeroCreds side. Everything that flows back is an opaque
 * connection reference plus value-free metadata.
 *
 * The host proves itself with a short-lived Ed25519 assertion: `caller_class`
 * is always `human`, the owner/profile pair comes from host configuration and
 * never from a request body, and every call mints a fresh `jti` because the
 * wallet API rejects a replayed assertion.
 */

const WALLET_OPERATIONS = ['wallet.forms.create', 'wallet.connections.status'];
const ASSERTION_TTL_SECONDS = 120;
const WALLET_TIMEOUT_MS = 10_000;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WALLET_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ASSERTION_ISSUER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export type WalletErrorCode = 'invalid_request' | 'rejected' | 'not_found' | 'conflict' | 'unavailable';

export class WalletError extends Error {
  constructor(readonly code: WalletErrorCode, message: string) {
    super(message);
  }
}

export interface WalletForm {
  formId: string;
  connectionId: string;
  url: string;
  statusUrl: string;
  expiresAt: string;
  state: string;
}

export interface WalletConnection {
  connectionId: string;
  provider: string;
  state: string;
  kvVersion: number | null;
  updatedAt: string | null;
}

export interface WalletFormRequest {
  provider: string;
  kind?: string;
  title?: string;
  description?: string;
  ttlMinutes?: number;
  idempotencyKey?: string;
}

export type WalletResolution =
  | { ok: true; client: WalletClient }
  | { ok: false; reason: 'not_configured' | 'invalid_config' | 'profile_unmapped' };

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class WalletClient {
  private constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly apiUrl: string,
    private readonly issuer: string,
    private readonly kid: string,
    private readonly privateJwk: JsonWebKey,
    private readonly profile: { ownerId: string; profileId: string },
  ) {}

  /**
   * Builds the client for one authenticated principal. The wallet profile is
   * looked up by the effective Runner profile id, so a delegated Control Plane
   * call resolves to the end user's profile rather than to the service profile.
   */
  static resolve(principal: ApiPrincipal, env: RunnerWorkerEnv): WalletResolution {
    const apiUrl = (env.ZEROCREDS_WALLET_API_URL ?? '').trim();
    const issuer = (env.ZEROCREDS_WALLET_ASSERTION_ISSUER ?? '').trim();
    const kid = (env.ZEROCREDS_WALLET_ASSERTION_KID ?? '').trim();
    const jwkRaw = (env.ZEROCREDS_WALLET_ASSERTION_PRIVATE_JWK ?? '').trim();
    const profilesRaw = (env.ZEROCREDS_WALLET_PROFILES ?? '').trim();
    if (!apiUrl || !issuer || !kid || !jwkRaw || !profilesRaw) return { ok: false, reason: 'not_configured' };
    let base: URL;
    try { base = new URL(apiUrl); } catch { return { ok: false, reason: 'invalid_config' }; }
    const local = base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname);
    if (base.protocol !== 'https:' && !local) return { ok: false, reason: 'invalid_config' };
    if (base.username || base.password || base.hash || base.search) return { ok: false, reason: 'invalid_config' };
    if (!ASSERTION_ISSUER.test(issuer) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(kid)) return { ok: false, reason: 'invalid_config' };
    let privateJwk: JsonWebKey;
    try { privateJwk = JSON.parse(jwkRaw) as JsonWebKey; } catch { return { ok: false, reason: 'invalid_config' }; }
    if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519' || typeof privateJwk.d !== 'string' || typeof privateJwk.x !== 'string') {
      return { ok: false, reason: 'invalid_config' };
    }
    const profiles = parseProfiles(profilesRaw);
    if (!profiles) return { ok: false, reason: 'invalid_config' };
    const binding = profiles[principal.profileId];
    if (!binding) return { ok: false, reason: 'profile_unmapped' };
    if (binding.tenantId && principal.tenantId && binding.tenantId !== principal.tenantId) return { ok: false, reason: 'profile_unmapped' };
    return { ok: true, client: new WalletClient((env.FETCH ?? fetch).bind(globalThis), base.origin + base.pathname.replace(/\/$/, ''), issuer, kid, privateJwk, binding) };
  }

  async createForm(input: WalletFormRequest): Promise<WalletForm> {
    if (!PROVIDER.test(input.provider)) throw new WalletError('invalid_request', 'provider is not a supported credential type');
    const payload: Record<string, unknown> = { provider: input.provider, ttl_minutes: input.ttlMinutes ?? 30, idempotency_key: input.idempotencyKey ?? randomToken(24) };
    if (input.kind !== undefined) payload['kind'] = input.kind;
    if (input.title !== undefined) payload['title'] = input.title;
    if (input.description !== undefined) payload['description'] = input.description;
    const body = await this.call('wallet.forms.create', WALLET_OPERATIONS, '/api/wallet/forms', 'POST', payload);
    const formId = text(body['form_id']);
    const connectionId = text(body['connection_id']);
    const url = text(body['url']);
    if (!formId || !connectionId || !url) throw new WalletError('unavailable', 'the credential service returned an unexpected response');
    return {
      formId,
      connectionId,
      url,
      statusUrl: text(body['status_url']) ?? '',
      expiresAt: text(body['expires_at']) ?? '',
      state: text(body['state']) ?? 'pending',
    };
  }

  async getConnection(connectionId: string): Promise<WalletConnection> {
    if (!WALLET_ID.test(connectionId)) throw new WalletError('invalid_request', 'connection id is not a valid reference');
    const body = await this.call('wallet.connections.status', WALLET_OPERATIONS, `/api/wallet/connections/${encodeURIComponent(connectionId)}`, 'GET');
    const state = text(body['state']);
    if (!state) throw new WalletError('unavailable', 'the credential service returned an unexpected response');
    const kvVersion = body['kv_version'];
    return {
      connectionId: text(body['connection_id']) ?? connectionId,
      provider: text(body['provider']) ?? '',
      state,
      kvVersion: typeof kvVersion === 'number' ? kvVersion : null,
      updatedAt: text(body['updated_at']),
    };
  }

  /** Signs a one-call host assertion and forwards the request to the wallet API. */
  private async call(operation: string, operations: string[], route: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const assertion = await this.assertion(operation, operations);
    // Detached on purpose: the Workers runtime rejects a fetch invoked with a
    // receiver that is not the global object.
    const fetchImpl = this.fetchImpl;
    let response: Response;
    try {
      response = await fetchImpl(`${this.apiUrl}${route}`, {
        method,
        headers: { authorization: `Bearer ${assertion}`, 'content-type': 'application/json', accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        // The Workers runtime has no `error` redirect mode; a redirect must never
        // carry the host assertion to another origin, so it is not followed.
        redirect: 'manual',
        signal: AbortSignal.timeout(WALLET_TIMEOUT_MS),
      });
    } catch { throw new WalletError('unavailable', 'the credential service is not reachable'); }
    let parsed: unknown;
    try { parsed = await response.json(); } catch { parsed = null; }
    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    if (response.ok) return record;
    if (response.status === 400) throw new WalletError('invalid_request', 'the credential service rejected the requested credential form');
    if (response.status === 401 || response.status === 403) throw new WalletError('rejected', 'the credential service rejected the Runner identity');
    if (response.status === 404) throw new WalletError('not_found', 'no credential connection exists for this reference');
    if (response.status === 409) throw new WalletError('conflict', 'a credential request with the same idempotency key already exists');
    throw new WalletError('unavailable', 'the credential service is not available');
  }

  private async assertion(operation: string, operations: string[]): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.issuer,
      aud: 'zerocreds-wallet:human',
      owner_id: this.profile.ownerId,
      profile_id: this.profile.profileId,
      caller_class: 'human',
      operations,
      iat: now,
      exp: now + ASSERTION_TTL_SECONDS,
      jti: randomToken(24),
    };
    const encode = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));
    const signingInput = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: this.kid })}.${encode(claims)}`;
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey('jwk', this.privateJwk, { name: 'Ed25519' }, false, ['sign']);
    } catch { throw new WalletError('unavailable', 'the host signing key is not usable'); }
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(signingInput));
    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  }
}

function parseProfiles(raw: string): Record<string, { ownerId: string; profileId: string; tenantId?: string }> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: Record<string, { ownerId: string; profileId: string; tenantId?: string }> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!PROFILE_ID.test(key)) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const ownerId = record['owner_id'];
    const profileId = record['profile_id'];
    const tenantId = record['tenant_id'];
    if (typeof ownerId !== 'string' || !WALLET_ID.test(ownerId)) return null;
    if (typeof profileId !== 'string' || !WALLET_ID.test(profileId)) return null;
    if (tenantId !== undefined && (typeof tenantId !== 'string' || !WALLET_ID.test(tenantId))) return null;
    out[key] = { ownerId, profileId, ...(typeof tenantId === 'string' ? { tenantId } : {}) };
  }
  return out;
}
