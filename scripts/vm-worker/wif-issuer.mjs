#!/usr/bin/env node
import { createServer } from 'node:http';
import { createPrivateKey, createPublicKey, createSign, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAX_TOKEN_LIFETIME_SECONDS = 600;

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function signSubjectToken({ privateKey, issuer, subject, audience, keyId, nowSeconds = Math.floor(Date.now() / 1000), lifetimeSeconds = 600 }) {
  issuer = requiredString(issuer, 'issuer');
  subject = requiredString(subject, 'subject');
  audience = requiredString(audience, 'audience');
  keyId = requiredString(keyId, 'keyId');
  if (!issuer.startsWith('https://') || !audience.startsWith('https://')) throw new Error('issuer and audience must use HTTPS');
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1) throw new Error('nowSeconds must be a positive integer');
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > MAX_TOKEN_LIFETIME_SECONDS) {
    throw new Error(`lifetimeSeconds must be between 1 and ${MAX_TOKEN_LIFETIME_SECONDS}`);
  }

  const header = { alg: 'RS256', typ: 'JWT', kid: keyId };
  const payload = {
    iss: issuer,
    sub: subject,
    aud: audience,
    iat: nowSeconds,
    exp: nowSeconds + lifetimeSeconds,
    jti: randomUUID(),
  };
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

export function createWifIssuerServer({ privateKey, issuer, subject, audience, keyId, now = () => Math.floor(Date.now() / 1000) }) {
  issuer = requiredString(issuer, 'issuer');
  subject = requiredString(subject, 'subject');
  audience = requiredString(audience, 'audience');
  keyId = requiredString(keyId, 'keyId');
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  const publicJwk = createPublicKey(key).export({ format: 'jwk' });
  const jwks = { keys: [{ ...publicJwk, kid: keyId, use: 'sig', alg: 'RS256' }] };
  const json = (response, body, cacheControl) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl, 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(body));
  };
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      json(response, {
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: ['id_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      }, 'public, max-age=300');
      return;
    }
    if (url.pathname === '/.well-known/jwks.json') {
      json(response, jwks, 'public, max-age=300');
      return;
    }
    if (url.pathname === '/token') {
      const token = signSubjectToken({ privateKey: key, issuer, subject, audience, keyId, nowSeconds: now() });
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache', 'x-content-type-options': 'nosniff' });
      response.end(token);
      return;
    }
    response.writeHead(404, { 'cache-control': 'no-store' });
    response.end();
  });
}

export function isDirectExecution(scriptPath, moduleUrl = import.meta.url) {
  if (typeof scriptPath !== 'string' || !scriptPath) return false;
  try {
    return pathToFileURL(realpathSync(scriptPath)).href === moduleUrl;
  } catch {
    return false;
  }
}

async function main() {
  const issuer = requiredString(process.env['WIF_ISSUER_URL'], 'WIF_ISSUER_URL');
  const subject = requiredString(process.env['WIF_SUBJECT'], 'WIF_SUBJECT');
  const audience = requiredString(process.env['WIF_AUDIENCE'], 'WIF_AUDIENCE');
  const keyId = requiredString(process.env['WIF_KEY_ID'], 'WIF_KEY_ID');
  const privateKeyPath = requiredString(process.env['WIF_PRIVATE_KEY_FILE'], 'WIF_PRIVATE_KEY_FILE');
  const port = Number(process.env['WIF_PORT'] ?? '18080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WIF_PORT must be a valid TCP port');
  const server = createWifIssuerServer({ privateKey: await readFile(privateKeyPath), issuer, subject, audience, keyId });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ event: 'wif_issuer_listening', host: '127.0.0.1', port })}\n`));
}

if (isDirectExecution(process.argv[1])) {
  main().catch(() => {
    process.stderr.write('{"event":"wif_issuer_start_failed"}\n');
    process.exit(1);
  });
}
