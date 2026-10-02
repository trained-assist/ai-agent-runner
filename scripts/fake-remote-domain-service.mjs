#!/usr/bin/env node
// Фикстура «remote domain service» для этапа I04 (SANDBOX): общий внешний сервис, который
// НЕ поднимается на каждый ран (TASK-ROUTER-AND-MCP §5: «Remote domain MCP — shared
// external service, auth per operation; не спавнится для каждого Run»).
//
// Что фикстура доказывает:
//   - действие действительно дошло наружу (каждая операция выдаёт receipt и строку в JSONL);
//   - привязка к профилю/скоупу: capability вне scope binding'а → 403 SCOPE_DENIED;
//   - отказ не оставляет эффекта (GET /v1/domain/receipts показывает только реальные операции).
//
// Секрет наружу — только env (argv виден через ps всем локальными пользователями):
//   FAKE_REMOTE_TOKEN — bearer-токен фикстуры;
//   FAKE_REMOTE_PORT / FAKE_REMOTE_LOG — порт и путь JSONL-журнала.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const TOKEN = process.env.FAKE_REMOTE_TOKEN ?? '';
const PORT = Number(process.env.FAKE_REMOTE_PORT ?? 0);
const HOST = process.env.FAKE_REMOTE_HOST ?? '127.0.0.1';
const LOG = process.env.FAKE_REMOTE_LOG ?? '';
/** Скоупы, которые фикстура считает существующими; capability вне своего скоупа получает 403. */
const CAPABILITIES = {
  'demo.search_status': { scopes: ['demo:read'], effect: 'read' },
  'demo.record_note': { scopes: ['demo:write'], effect: 'write' },
  'demo.admin_purge': { scopes: ['demo:admin'], effect: 'write' },
};

const receipts = [];
let notes = 0;

function log(entry) {
  if (!LOG) return;
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`, 'utf8');
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function authorize(req) {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.slice('Bearer '.length) !== TOKEN) {
    return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
  }
  const scopes = String(req.headers['x-binding-scope'] ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  const bindingRef = String(req.headers['x-binding-ref'] ?? '');
  const profileId = String(req.headers['x-profile-id'] ?? '');
  if (scopes.length === 0) return { ok: false, status: 403, code: 'BINDING_SCOPE_REQUIRED' };
  return { ok: true, scopes, bindingRef, profileId };
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    send(res, 500, { error: { code: 'FIXTURE_ERROR', message: err instanceof Error ? err.message : String(err) } });
  });
});

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://fake-remote.local');
  const path = url.pathname;
  const at = new Date().toISOString();

  if (path === '/healthz' && req.method === 'GET') {
    send(res, 200, { status: 'ok', service: 'fake-remote-domain-service', receipts: receipts.length });
    return;
  }

  if (path === '/v1/domain/receipts' && req.method === 'GET') {
    send(res, 200, { receipts });
    return;
  }

  const auth = authorize(req);
  if (!auth.ok) {
    log({ at, method: req.method, path, outcome: auth.status === 401 ? 'unauthenticated' : 'binding_scope_required' });
    send(res, auth.status, { error: { code: auth.code } });
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
    return;
  }

  const capabilityId = String(url.searchParams.get('capability') ?? '');
  const capability = CAPABILITIES[capabilityId];
  if (!capability) {
    log({ at, method: req.method, path, capabilityId, bindingRef: auth.bindingRef, bindingScopes: auth.scopes, outcome: 'unknown_capability' });
    send(res, 404, { error: { code: 'CAPABILITY_NOT_FOUND', capabilityId } });
    return;
  }

  const satisfied = capability.scopes.some((scope) => auth.scopes.includes(scope));
  if (!satisfied) {
    // Отказ по скоупу: эффекта нет, квитанция не выдаётся.
    log({
      at,
      method: req.method,
      path,
      capabilityId,
      bindingRef: auth.bindingRef,
      bindingScopes: auth.scopes,
      profileId: auth.profileId,
      outcome: 'scope_denied',
      requiredScopes: capability.scopes,
    });
    send(res, 403, { error: { code: 'SCOPE_DENIED', capabilityId, requiredScopes: capability.scopes } });
    return;
  }

  const body = await readBody(req);
  const operationId = typeof body['operationId'] === 'string' ? body['operationId'] : randomUUID();
  const receipt = {
    receiptId: `rcpt-${randomUUID()}`,
    capabilityId,
    effect: capability.effect,
    operationId,
    bindingRef: auth.bindingRef,
    bindingScopes: auth.scopes,
    profileId: auth.profileId,
    at,
  };

  let result;
  if (capability.effect === 'write') {
    notes += 1;
    receipt.externalRef = `note-${notes}`;
    result = { noteId: receipt.externalRef, stored: true, text: typeof body['text'] === 'string' ? body['text'] : '' };
  } else {
    const searchId = typeof body['searchId'] === 'string' ? body['searchId'] : 'unknown';
    result = { searchId, state: 'in_progress', candidates: 3, updatedAt: at };
  }
  receipts.push(receipt);
  log({
    at,
    method: req.method,
    path,
    capabilityId,
    bindingRef: auth.bindingRef,
    bindingScopes: auth.scopes,
    profileId: auth.profileId,
    outcome: 'completed',
    receiptId: receipt.receiptId,
    externalRef: receipt.externalRef ?? null,
  });
  send(res, 200, { result, receipt });
}

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : PORT;
  process.stdout.write(`${JSON.stringify({ event: 'fake_remote_listening', host: HOST, port, log: LOG, tokenConfigured: TOKEN.length > 0 })}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
