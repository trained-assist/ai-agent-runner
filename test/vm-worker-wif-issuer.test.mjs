import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWifIssuerServer, isDirectExecution, signSubjectToken } from '../scripts/vm-worker/wif-issuer.mjs';

const issuer = 'https://eu-worker.169-58-15-230.sslip.io';
const audience = 'https://iam.googleapis.com/projects/731388616698/locations/global/workloadIdentityPools/ta-vm-workers/providers/eu-vm-worker-test';
const keyId = 'eu-vm2-oidc-20261010';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const server = createWifIssuerServer({ privateKey: pair.privateKey, issuer, subject: 'eu-vm-worker', audience, keyId, now: () => 1_800_000_000 });
let origin;

before(async () => {
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  assert.equal(server.address().address, '127.0.0.1');
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test('metadata describes this issuer and its public signing key', async () => {
  const response = await fetch(`${origin}/.well-known/openid-configuration`);
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.issuer, issuer);
  assert.equal(metadata.jwks_uri, `${issuer}/.well-known/jwks.json`);
  const jwks = await (await fetch(`${origin}/.well-known/jwks.json`)).json();
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].kid, keyId);
  assert.equal(jwks.keys[0].d, undefined);
});

test('token endpoint issues a short-lived RS256 token for the pinned worker subject and audience', async () => {
  const response = await fetch(`${origin}/token`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const token = await response.text();
  const [encodedHeader, encodedClaims, encodedSignature] = token.split('.');
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString());
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: keyId });
  assert.equal(claims.iss, issuer);
  assert.equal(claims.sub, 'eu-vm-worker');
  assert.equal(claims.aud, audience);
  assert.equal(claims.iat, 1_800_000_000);
  assert.equal(claims.exp - claims.iat, 600);
  assert.equal(typeof claims.jti, 'string');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`), pair.publicKey, Buffer.from(encodedSignature, 'base64url')), true);
});

test('unknown paths and non-GET methods do not return credentials', async () => {
  assert.equal((await fetch(`${origin}/unknown`)).status, 404);
  assert.equal((await fetch(`${origin}/token`, { method: 'POST' })).status, 405);
});

test('token lifetime is bounded and issuer/audience must be HTTPS', () => {
  assert.throws(() => signSubjectToken({ privateKey: pair.privateKey, issuer, subject: 'eu-vm-worker', audience, keyId, lifetimeSeconds: 601 }), /lifetimeSeconds/);
  assert.throws(() => signSubjectToken({ privateKey: pair.privateKey, issuer: 'http://issuer.invalid', subject: 'eu-vm-worker', audience, keyId }), /HTTPS/);
});

test('direct execution detection follows the current-release symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vm-worker-wif-test-'));
  const source = resolve(fileURLToPath(new URL('../scripts/vm-worker/wif-issuer.mjs', import.meta.url)));
  const current = join(directory, 'current');
  try {
    await symlink(source, current);
    assert.equal(isDirectExecution(current, pathToFileURL(source).href), true);
    assert.equal(isDirectExecution(source, pathToFileURL(source).href), true);
    assert.equal(isDirectExecution(current, 'file:///another-module.mjs'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
