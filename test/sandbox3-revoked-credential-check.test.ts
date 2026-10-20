import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REVOKED_CREDENTIAL_REF, revokedCredentialTarget } from '../scripts/sandbox3-revoked-credential-check.mjs';

const config = JSON.parse(readFileSync(new URL('../wrangler.sandbox3.jsonc', import.meta.url), 'utf8'));
const registry = JSON.parse(config.vars.ZEROCREDS_WALLET_CREDENTIALS);

describe('sandbox3 revoked credential check', () => {
  it('tests a ref the registry declares and that is not the live credential', () => {
    const target = revokedCredentialTarget(registry);
    expect(REVOKED_CREDENTIAL_REF).toBe('github-revoked');
    expect(target.connection_id).not.toBe(registry['github'].connection_id);
    expect(target.scope).toBe(registry['github'].scope);
  });

  it('refuses a ref the registry does not declare', () => {
    expect(() => revokedCredentialTarget(registry, 'not-declared')).toThrow(/no "not-declared" ref/);
  });

  it('refuses a fixture that points at the live credential', () => {
    // A check that ran against the working credential would prove nothing: the
    // run would succeed and the script would report a healthy credential.
    expect(() => revokedCredentialTarget(registry, 'github')).toThrow(/must not point at the live credential/);
  });
});
