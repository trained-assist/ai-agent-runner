import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.env.E2E_DIST;
if (!dist) {
  console.error('E2E_DIST is required (compiled src directory)');
  process.exit(2);
}
const rootDir = process.env.E2E_ROOT_DIR;
const keysPath = process.env.E2E_KEYS_PATH;
const credsPath = process.env.E2E_CREDS_PATH ?? '';
const controlToken = process.env.E2E_CONTROL_TOKEN ?? '';
if (!rootDir || !keysPath || !controlToken) {
  console.error('E2E_ROOT_DIR, E2E_KEYS_PATH and E2E_CONTROL_TOKEN are required');
  process.exit(2);
}

const load = (relative) => import(pathToFileURL(join(dist, relative)).href);
const { AgentApi } = await load('api/service.js');
const { createAgentApiServer } = await load('api/server.js');
const { KeyRegistry } = await load('api/auth.js');
const { FaultRegistry, FAULT_POINTS } = await load('faults/registry.js');
const { FakeEngine } = await load('adapters/engine/fake-engine.js');
const { OpenCodeAdapter } = await load('adapters/engine/opencode-adapter.js');
const { handleForChild } = await load('adapters/engine/process-tree.js');

class ScriptEngine {
  constructor(name, scriptFile) {
    this.name = name;
    this.scriptPath = join(here, scriptFile);
  }

  async start(ctx) {
    const meta = {
      engine: this.name,
      runId: ctx.spec.runId,
      bindings: ctx.spec.credentialBindings ?? [],
      inlinePrompt: ctx.spec.input?.inlinePrompt ?? null,
    };
    const child = spawn(process.execPath, [this.scriptPath, JSON.stringify(meta)], {
      cwd: ctx.cwd,
      env: ctx.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return handleForChild(child, { onLog: ctx.onLog, onExit: ctx.onExit });
  }
}

const adapters = {
  fake: new FakeEngine('success'),
  'fake-nonzero': new FakeEngine('nonzero-exit'),
  'fake-timeout': new FakeEngine('timeout'),
  'fake-crash': new FakeEngine('crash'),
  'fake-startup': new FakeEngine('startup-failure'),
  'fake-slow': new ScriptEngine('fake-slow', 'engine-scripts/slow.mjs'),
  probe: new ScriptEngine('probe', 'engine-scripts/probe.mjs'),
  artifact: new ScriptEngine('artifact', 'engine-scripts/artifact.mjs'),
  cred: new ScriptEngine('cred', 'engine-scripts/cred.mjs'),
};
if (process.env.E2E_WITH_OPENCODE === '1') adapters.opencode = new OpenCodeAdapter();

const startsByEngine = {};
for (const [name, adapter] of Object.entries(adapters)) {
  const originalStart = adapter.start.bind(adapter);
  adapters[name] = {
    name,
    start: async (ctx) => {
      startsByEngine[name] = (startsByEngine[name] ?? 0) + 1;
      return originalStart(ctx);
    },
  };
}

let creds = [];
if (credsPath && existsSync(credsPath)) {
  creds = JSON.parse(readFileSync(credsPath, 'utf8'));
  for (const entry of creds) process.env[entry.env] = entry.value;
}
const credByValue = new Map(creds.map((entry) => [entry.value, entry]));
const credAttempts = [];

const faults = new FaultRegistry();
const logToStdout = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);

const service = new AgentApi({
  rootDir,
  adapters,
  host: { region: 'sandbox-eu', environment: 'sandbox' },
  faults,
  cancelGraceMs: 500,
  logger: logToStdout,
  // Рабочие каталоги ранов в этом цикле сохраняются намеренно: шаг 6 проверяет байты и
  // права файла, который движок создал в workspace, а маршрут /download этого harness'а
  // читает именно его. Уборка workspace (issue #52) проверяется отдельно — на обычных
  // настройках в тестах жизненного цикла и в пробе границы на песочной VM.
  retainWorkspaces: true,
});
await service.recover();
const keys = KeyRegistry.loadFile(keysPath);
const apiServer = createAgentApiServer(service, { keys, logger: logToStdout });

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function hasControlToken(req) {
  const presented = req.headers['x-e2e-control-token'];
  if (typeof presented !== 'string' || presented.length !== controlToken.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(controlToken));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 1_000_000) continue;
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return {};
  return JSON.parse(text);
}

async function handleControl(url, req, res) {
  const path = url.pathname;
  if (path === '/_e2e/cred/read' || path === '/_e2e/cred/write') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
    const presented = req.headers['x-e2e-credential'];
    const credential = typeof presented === 'string' ? credByValue.get(presented) : undefined;
    if (!credential) {
      credAttempts.push({ at: new Date().toISOString(), env: null, scope: null, action: path.endsWith('/read') ? 'read' : 'write', outcome: 'unknown_credential' });
      return sendJson(res, 401, { error: { code: 'CREDENTIAL_UNKNOWN', message: 'credential is not registered' } });
    }
    await readJsonBody(req).catch(() => ({}));
    const action = path.endsWith('/read') ? 'read' : 'write';
    const allowed = action === 'read' || credential.scope === 'write';
    credAttempts.push({
      at: new Date().toISOString(),
      env: credential.env,
      scope: credential.scope,
      action,
      outcome: allowed ? 'allowed' : 'denied',
    });
    if (!allowed) {
      return sendJson(res, 403, {
        error: { code: 'SCOPE_DENIED', message: `credential scope "${credential.scope}" does not allow write` },
      });
    }
    return sendJson(res, 200, { ok: true, action, scope: credential.scope });
  }

  if (!hasControlToken(req)) return sendJson(res, 403, { error: { code: 'CONTROL_DENIED', message: 'bad control token' } });

  if (path === '/_e2e/health' && req.method === 'GET') {
    const health = service.runner.health();
    const admissions = service.store.listAll();
    return sendJson(res, 200, {
      ok: true,
      activeRuns: health.activeRuns,
      runs: health.runs,
      droppedLogCount: health.droppedLogCount,
      admissions: admissions.length,
      startsByEngine: { ...startsByEngine },
      credAttempts: credAttempts.length,
      runsDetail: admissions.map((record) => ({
        runId: record.runId,
        engine: record.spec.engine.name,
        state: service.runner.getRun(record.runId)?.state ?? null,
      })),
    });
  }

  if (path === '/_e2e/fault' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const point = body.point;
    if (!FAULT_POINTS.includes(point)) {
      return sendJson(res, 400, { error: { code: 'INVALID_FAULT', message: `unknown fault point: ${String(point)}` } });
    }
    const spec = { kind: body.kind ?? 'throw' };
    if (spec.kind !== 'throw' && spec.kind !== 'connection_lost') {
      return sendJson(res, 400, { error: { code: 'INVALID_FAULT', message: 'only throw|connection_lost are exposable over http' } });
    }
    if (body.once === true) spec.once = true;
    if (Number.isInteger(body.count) && body.count > 0) spec.count = body.count;
    faults.inject(point, spec);
    return sendJson(res, 200, { ok: true, point, spec });
  }

  if (path === '/_e2e/fault/clear' && req.method === 'POST') {
    await readJsonBody(req).catch(() => ({}));
    faults.clear();
    return sendJson(res, 200, { ok: true });
  }

  if (path === '/_e2e/cred/attempts' && req.method === 'GET') {
    return sendJson(res, 200, { attempts: credAttempts });
  }

  return sendJson(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: `no control route for ${path}` } });
}

function handleDownload(url, req, res) {
  const match = /^\/v1\/runs\/([^/]+)\/download$/.exec(url.pathname);
  if (!match || req.method !== 'GET') {
    return sendJson(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'download supports GET only' } });
  }
  const runId = decodeURIComponent(match[1]);
  const principal = keys.authenticate(req.headers['authorization']);
  if (!principal) return sendJson(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'a valid Bearer API key is required' } });
  if (!principal.scopes.includes('runs:read')) {
    return sendJson(res, 403, { error: { code: 'SCOPE_DENIED', message: `principal "${principal.principalId}" is missing scope "runs:read"` } });
  }
  const record = service.store.getByRun(runId);
  if (!record || record.principalId !== principal.principalId) {
    return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `unknown run ${runId}` } });
  }
  const ref = url.searchParams.get('ref');
  if (!ref || ref.includes('\0')) {
    return sendJson(res, 400, { error: { code: 'INVALID_REF', message: 'ref query parameter is required' } });
  }
  const base = resolve(record.spec.cwd);
  const target = resolve(base, ref);
  if (target === base || !target.startsWith(`${base}${sep}`)) {
    return sendJson(res, 400, { error: { code: 'INVALID_REF', message: 'ref must resolve inside the run workspace' } });
  }
  if (!existsSync(target)) return sendJson(res, 404, { error: { code: 'ARTIFACT_NOT_FOUND', message: `no artifact ${ref} for run ${runId}` } });
  let stat;
  try {
    stat = statSync(target);
  } catch (err) {
    return sendJson(res, 404, { error: { code: 'ARTIFACT_NOT_FOUND', message: String(err && err.message) } });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: { code: 'ARTIFACT_NOT_FOUND', message: `${ref} is not a regular file` } });
  if (stat.size > 8 * 1024 * 1024) return sendJson(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'artifact exceeds 8MiB' } });
  const bytes = readFileSync(target);
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': bytes.length,
    'x-e2e-sha256': createHash('sha256').update(bytes).digest('hex'),
    'x-e2e-file-mode': (stat.mode & 0o777).toString(8),
  });
  res.end(bytes);
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://e2e.local');
    if (url.pathname.startsWith('/_e2e/')) {
      await handleControl(url, req, res);
      return;
    }
    if (/^\/v1\/runs\/[^/]+\/download$/.test(url.pathname)) {
      handleDownload(url, req, res);
      return;
    }
    apiServer.emit('request', req, res);
  })().catch((err) => {
    if (res.headersSent) res.end();
    else sendJson(res, 500, { error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } });
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logToStdout({ event: 'e2e_server_shutdown', signal });
  try {
    server.closeAllConnections?.();
  } catch {
    // ignore
  }
  server.close(() => process.exit(0));
  try {
    service.dispose({ killProcesses: true });
  } catch {
    // ignore
  }
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logToStdout({ event: 'e2e_server_uncaught', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

const port = Number(process.env.E2E_PORT ?? 0);
server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  process.env.E2E_GATEWAY_URL = `http://127.0.0.1:${actual}/_e2e/cred`;
  process.stdout.write(`${JSON.stringify({ event: 'e2e_server_listening', port: actual })}\n`);
});
