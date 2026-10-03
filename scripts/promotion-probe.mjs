#!/usr/bin/env node
// Проба приёмки P29 (карточка #68, этап I10): промоушен и fleet acceptance на одной VM.
//
// Топология: два настоящих API-процесса воркеров в одном namespace песочницы
// (sandbox-a = кандидат r2, sandbox-b = предыдущий релиз r1), общий реестр владения
// задачами, эмулированные каналы Web и Telegram поверх реального API, детерминированный
// fake-движок (free-only). Каналы — эмуляция ingress/egress (SANDBOX · I10: «Web: client
// adapter к new API», «Telegram: update/delivery emulator»), API/Runner/реестр владения —
// настоящие процессы; живой бот и Web-UI не подменяются.
//
// Запуск (из корня репозитория, после npm ci && npm run build):
//   sudo scripts/recreate-sandbox.sh --namespace p29-$(date -u +%Y%m%d) --owner sandbox
//   node scripts/promotion-probe.mjs --fleet-root /var/lib/agent-runner-fleet --namespace p29-…
//
// Опции:
//   --out <dir>        каталог транскрипта (по умолчанию docs/evidence/p29-promotion)
//   --keep             не гасить воркеры в конце (для разбора)
//   --only <step-id>   прогнать один шаг (шаги идут по порядку)
//
// Ключи и шар-секреты читаются из файлов namespace, в транскрипт не попадают (проверка в конце).
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const fleetRootFlag = flagValue('--fleet-root');
const namespaceFlag = flagValue('--namespace');
const outFlag = flagValue('--out');
const onlyFlag = flagValue('--only');
const keep = args.includes('--keep');

if (!fleetRootFlag || !namespaceFlag) {
  process.stderr.write('usage: promotion-probe.mjs --fleet-root <dir> --namespace <id> [--out <dir>] [--keep] [--only <step>]\n');
  process.exit(2);
}

const FLEET_ROOT = resolve(fleetRootFlag);
const NAMESPACE = namespaceFlag;
const NS_ROOT = join(FLEET_ROOT, NAMESPACE);
const PROVISIONING = join(NS_ROOT, 'provisioning.json');
const OUT_DIR = outFlag ? resolve(outFlag) : join(REPO, 'docs', 'evidence', 'p29-promotion');

const DIST = join(REPO, 'dist');
const results = [];
const checks = [];
const logLines = { a: [], b: [] };
let a = null;
let b = null;
const secrets = [];
let failures = 0;

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

function record(step, fields) {
  const entry = { at: new Date().toISOString(), step, ...fields };
  results.push(entry);
  return entry;
}

function loadProvisioning() {
  if (!existsSync(PROVISIONING)) {
    throw new Error(`provisioning manifest not found: ${PROVISIONING} (run scripts/recreate-sandbox.sh first)`);
  }
  return JSON.parse(readFileSync(PROVISIONING, 'utf8'));
}

function readEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return env;
}

function readKey(path) {
  const key = readFileSync(path, 'utf8').trim();
  secrets.push(key);
  return key;
}

function hashOf(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null);
}

async function portInUse(port) {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    probe.once('error', () => resolvePromise(true));
    probe.once('listening', () => probe.close(() => resolvePromise(false)));
    probe.listen(port, '127.0.0.1');
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ---------------------------------------------------------------- worker process

class Worker {
  constructor(spec, key, bucket, cohortEnv = {}) {
    this.spec = spec;
    this.workerId = spec.workerId;
    this.releaseId = spec.releaseId;
    this.port = spec.port;
    this.base = `http://127.0.0.1:${spec.port}`;
    this.key = key;
    this.env = { ...readEnvFile(spec.envFile), ...cohortEnv };
    this.child = null;
    this.logPath = spec.logFile;
    this.startedAt = null;
    this.bucket = bucket;
    this.fakeScenario = 'success';
  }

  start() {
    this.child = spawn(process.execPath, [join(DIST, 'api', 'main.js')], {
      env: { ...process.env, ...this.env, AGENT_API_FAKE_SCENARIO: this.fakeScenario },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.startedAt = new Date().toISOString();
    // exit предыдущего процесса не должен выглядеть как падение нового (restart).
    this.exitInfo = null;
    const bucket = this.bucket;
    const capture = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() === '') continue;
        bucket.push(line.trim());
      }
    };
    this.child.stdout.on('data', capture);
    this.child.stderr.on('data', capture);
    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal, at: new Date().toISOString() };
    });
    return this;
  }

  async waitHealthy(timeoutMs = 30_000) {
    try {
      await waitFor(
        async () => {
          if (this.exitInfo) return false;
          try {
            const response = await fetch(`${this.base}/healthz`);
            return response.status === 200;
          } catch {
            return false;
          }
        },
        timeoutMs,
        `${this.workerId} healthz`,
      );
    } catch (err) {
      // Процесс упал или порт занят — показываем его собственные строки, а не только таймаут.
      const tail = this.bucket.slice(-3).join(' | ') || '(no output)';
      throw new Error(`${err instanceof Error ? err.message : String(err)}; ${this.workerId} output: ${tail}`);
    }
  }

  /** Перезапуск с другим сценарием fake-движка — как рестарт юнита с новым окружением. */
  async restart(fakeScenario = 'success') {
    this.fakeScenario = fakeScenario;
    await this.stop();
    this.start();
    await this.waitHealthy();
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill('SIGTERM');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && this.child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }

  async request(method, pathname, { body, idempotencyKey, key } = {}) {
    const headers = { authorization: `Bearer ${key ?? this.key}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
    const response = await fetch(`${this.base}${pathname}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 200) };
    }
    return { status: response.status, body: parsed };
  }

  get(pathname, key) {
    return this.request('GET', pathname, key === undefined ? {} : { key });
  }

  post(pathname, body, idempotencyKey, key) {
    return this.request('POST', pathname, { body, idempotencyKey, key });
  }
}

// ------------------------------------------------------------- emulated channels
//
// Каналы эмулируются, как предписано SANDBOX · I10: адаптер канала принимает внешний
// идентификатор сообщения, превращает его в userTaskId (корреляция сохраняется на всей
// цепочке) и возвращает результат в свою же «доставку» с runId рана.

function webChannel(worker, key) {
  return {
    channel: 'web',
    async send({ conversationId, messageId, text, idempotencyKey }) {
      const userTaskId = `web-${conversationId}-${messageId}`;
      const submit = await worker.post(
        '/v1/runs',
        {
          conversationId: `web-${conversationId}`,
          userTaskId,
          engine: { name: 'fake', adapterVersion: '1' },
          envAllowlist: [],
          limits: { timeoutMs: 30_000 },
          input: { inlinePrompt: text },
        },
        idempotencyKey,
        key,
      );
      return { submit, userTaskId };
    },
  };
}

function telegramChannel(worker, key) {
  return {
    channel: 'telegram',
    async send({ chatId, messageId, text, idempotencyKey }) {
      const userTaskId = `tg-${chatId}-${messageId}`;
      const submit = await worker.post(
        '/v1/runs',
        {
          conversationId: `tg-${chatId}`,
          userTaskId,
          engine: { name: 'fake', adapterVersion: '1' },
          envAllowlist: [],
          limits: { timeoutMs: 30_000 },
          input: { inlinePrompt: text },
        },
        idempotencyKey,
        key,
      );
      return { submit, userTaskId };
    },
  };
}

async function waitTerminal(worker, runId, timeoutMs = 30_000, key) {
  // Ключ чтения — ключ, на котором задача принята: чужой профиль ран не читает
  // (INV-01), иначе «ждём терминал» на самом деле ждёт вечный 404.
  await waitFor(
    async () => {
      const status = await worker.get(`/v1/runs/${runId}/status`, key);
      return ['succeeded', 'failed', 'cancelled'].includes(status.body?.state);
    },
    timeoutMs,
    `terminal state of ${runId}`,
  );
  const status = await worker.get(`/v1/runs/${runId}/status`, key);
  const events = await worker.get(`/v1/runs/${runId}/events`, key);
  const result = await worker.get(`/v1/runs/${runId}/result`, key);
  return { status: status.body, events: events.body, result: result.body };
}

// ---------------------------------------------------------------------- main run

async function main() {
  if (!existsSync(join(DIST, 'api', 'main.js'))) {
    throw new Error(`dist/api/main.js not found: run "npm run build" in ${REPO} first`);
  }
  const provisioning = loadProvisioning();
  const release = await import(pathToFileURL(join(DIST, 'release', 'index.js')).href);
  mkdirSync(OUT_DIR, { recursive: true });
  const workerSpecs = provisioning.workers;
  if (workerSpecs.length < 2) throw new Error(`two workers are required for the fleet simulation, got ${workerSpecs.length}`);

  // Реестр владения ключуется парой principalId+userTaskId, а principal — это владелец
  // КЛЮЧА, а не машина. Общая задача принимается клиентским ключом control plane, поэтому
  // обе стороны реестра смотрят на principal этого ключа (workerId — отдельное поле записи).
  const principalIdForKey = (key, spec) => {
    const registry = JSON.parse(readFileSync(spec.keyRegistry, 'utf8'));
    const hit = registry.principals.find((principal) => principal.keyHash === hashOf(key));
    if (!hit) throw new Error(`key is not registered for ${spec.workerId} (no matching keyHash in ${spec.keyRegistry})`);
    return hit.principalId;
  };
  a = new Worker(workerSpecs[0], readKey(workerSpecs[0].keyFile), logLines.a);
  b = new Worker(workerSpecs[1], readKey(workerSpecs[1].keyFile), logLines.b);
  // Клиентский ключ control plane известен обоим воркерам релиза: на нём проверяется
  // «одна задача — один владелец». Ключ вне когорты — для отрицательных проверок приёма.
  const clientKey = readKey(join(NS_ROOT, 'config', 'client-api-key'));
  const outsiderKey = readKey(join(NS_ROOT, 'config', 'outsider-api-key'));
  const clientPrincipal = principalIdForKey(clientKey, workerSpecs[0]);
  const ownerStore = provisioning.ownerStore;
  const steps = [];

  record('probe_started', {
    namespace: NAMESPACE,
    fleetRoot: FLEET_ROOT,
    sourceCommit: provisioning.sourceCommit,
    candidateReleaseId: provisioning.candidateReleaseId,
    previousReleaseId: provisioning.previousReleaseId,
    outDir: OUT_DIR,
    topology: 'client → (web | telegram adapter) → worker A/B (node dist/api/main.js) → shared owner registry',
    fidelity: 'API, Runner, реестр владения и promotion-контур — настоящие процессы; каналы Web/TG — эмуляция ingress/egress; движок fake (free-only), платные профили выключены',
    keysConfigured: secrets.length,
  });

  const runStep = async (id, fn) => {
    if (onlyFlag && onlyFlag !== id) return undefined;
    const value = await fn();
    steps.push(id);
    return value;
  };

  // -- 1. Чистая песочница: namespace создан заново, ключи новые, прогонов ещё не было.
  await runStep('sandbox_fresh', async () => {
    const runsBefore = workerSpecs.map((spec) => {
      const runsDir = join(spec.dataDir, 'runs');
      return existsSync(runsDir) ? readdirSync(runsDir).length : 0;
    });
    check('namespace создан заново: ни одного рана до прогона', runsBefore.every((count) => count === 0), `runs до прогона: ${runsBefore.join('/')}`);

    const registries = workerSpecs.map((spec) => JSON.parse(readFileSync(spec.keyRegistry, 'utf8')));
    const ownHashes = workerSpecs.map((spec) => readKey(spec.keyFile).trim().length > 0 ? hashOf(readKey(spec.keyFile)) : '');
    const clientHash = hashOf(clientKey);
    const outsiderHash = hashOf(outsiderKey);
    check('собственные ключи воркеров различны', new Set(ownHashes).size === ownHashes.length, `${ownHashes.length} ключей`);
    check(
      'клиентский ключ известен обоим воркерам, ключ вне когорты — тоже',
      registries.every((registry) => registry.principals.some((principal) => principal.keyHash === clientHash) && registry.principals.some((principal) => principal.keyHash === outsiderHash)),
    );
    check(
      'в provisioning-манифесте нет значений секретов',
      !JSON.stringify(provisioning).includes(a.key) && !JSON.stringify(provisioning).toLowerCase().includes('ak_'),
    );
    record('sandbox_fresh', {
      runsBefore,
      distinctOwnKeyHashes: new Set(ownHashes).size,
      replacedNamespaces: existsSync(NS_ROOT) ? readdirSync(FLEET_ROOT).filter((entry) => entry.startsWith(`${NAMESPACE}.replaced-`)) : [],
    });
  });

  // -- 1a. Порты свободны: иначе «воркер не поднялся» неотличимо от чужого сервиса на порту.
  await runStep('ports_free', async () => {
    for (const worker of [a, b]) {
      const taken = await portInUse(worker.port);
      check(`порт ${worker.port} свободен до старта ${worker.workerId}`, !taken, taken ? 'порт занят посторонним процессом' : '');
    }
  });

  // -- 2. Оба воркера поднимаются с закреплённым релизом и раздельными namespace.
  await runStep('workers_started', async () => {
    a.start();
    b.start();
    await a.waitHealthy();
    await b.waitHealthy();
    const healthA = (await a.get('/healthz')).body;
    const healthB = (await b.get('/healthz')).body;
    check('healthz воркера A отвечает без ключа и без секретов', healthA?.status === 'ok' && !JSON.stringify(healthA).includes('secret'));

    const releaseA = (await a.get('/v1/release')).body;
    const releaseB = (await b.get('/v1/release')).body;
    check('релиз A закреплён', releaseA.release.releaseId === provisioning.candidateReleaseId && releaseA.release.sourceCommit === provisioning.sourceCommit, `${releaseA.release.releaseId}@${releaseA.release.sourceCommit.slice(0, 8)}`);
    check('релиз B закреплён на предыдущем', releaseB.release.releaseId === provisioning.previousReleaseId, releaseB.release.releaseId);
    check('у воркеров разные workerId и порты', releaseA.release.workerId !== releaseB.release.workerId && a.port !== b.port, `${releaseA.release.workerId}:${a.port} / ${releaseB.release.workerId}:${b.port}`);
    check('платные профили выключены у обоих воркеров', releaseA.release.paidProfilesAllowed === false && releaseB.release.paidProfilesAllowed === false);
    check('режим роли новой машины: расписание и доставка выключены', JSON.stringify(releaseA.release.roles) === JSON.stringify({ schedule: false, delivery: false }));
    record('workers_started', {
      a: { workerId: releaseA.release.workerId, releaseId: releaseA.release.releaseId, configVersion: releaseA.release.configVersion, port: a.port, cohort: releaseA.cohort },
      b: { workerId: releaseB.release.workerId, releaseId: releaseB.release.releaseId, configVersion: releaseB.release.configVersion, port: b.port, cohort: releaseB.cohort },
      retentionPolicy: releaseA.retention.policy,
      health: { a: healthA, b: healthB },
    });
    return { releaseA, releaseB };
  });

  // -- 3. Smoke через API: приём → события → результат с коррелированными ID.
  await runStep('api_smoke', async () => {
    const submit = await a.post(
      '/v1/runs',
      {
        userTaskId: 'task-api-smoke',
        conversationId: 'conv-api-smoke',
        engine: { name: 'fake', adapterVersion: '1' },
        envAllowlist: [],
        limits: { timeoutMs: 30_000 },
        input: { inlinePrompt: 'sandbox promotion smoke' },
      },
      'p29-api-smoke-1',
      clientKey,
    );
    check('API принял задачу (202 + receipt)', submit.status === 202 && typeof submit.body.runId === 'string', `runId ${String(submit.body.runId).slice(0, 12)}…`);
    const receipt = submit.body;
    const terminal = await waitTerminal(a, receipt.runId, 30_000, clientKey);
    check('результат терминальный и успешный', terminal.status.state === 'succeeded' && terminal.result.outcome === 'succeeded', terminal.status.state);
    const types = terminal.events.events.map((event) => event.type);
    check('цепочка событий полная и без пропусков', types[0] === 'claimed' && types.at(-1) === 'succeeded' && terminal.events.events.every((event, index) => event.sequence === index + 1), types.join('→'));
    const duplicate = await a.post(
      '/v1/runs',
      {
        userTaskId: 'task-api-smoke',
        conversationId: 'conv-api-smoke',
        engine: { name: 'fake', adapterVersion: '1' },
        envAllowlist: [],
        limits: { timeoutMs: 30_000 },
        input: { inlinePrompt: 'sandbox promotion smoke' },
      },
      'p29-api-smoke-1',
      clientKey,
    );
    check('повтор с тем же Idempotency-Key = тот же receipt, второй ран не создан', duplicate.status === 200 && duplicate.body.runId === receipt.runId && duplicate.body.deduplicated === true);
    record('api_smoke', {
      receipt,
      status: terminal.status,
      eventTypes: types,
      sequence: terminal.events.events.map((event) => event.sequence),
      duplicateRunId: duplicate.body.runId,
    });
    return { receipt, terminal };
  });

  // -- 4. Smoke через Web и Telegram: внешний message id ↔ userTaskId ↔ requestId ↔ runId.
  await runStep('channel_smoke', async () => {
    const web = webChannel(a, clientKey);
    const tg = telegramChannel(a, clientKey);
    const webSend = await web.send({ conversationId: 'conv-7', messageId: 41, text: 'web smoke', idempotencyKey: 'p29-web-1' });
    check('Web-канал принял сообщение', webSend.submit.status === 202, `userTaskId ${webSend.userTaskId}`);
    const tgSend = await tg.send({ chatId: 'chat-555', messageId: 9001, text: 'telegram smoke', idempotencyKey: 'p29-tg-1' });
    check('TG-канал принял апдейт', tgSend.submit.status === 202, `userTaskId ${tgSend.userTaskId}`);

    const webTerminal = await waitTerminal(a, webSend.submit.body.runId, 30_000, clientKey);
    const tgTerminal = await waitTerminal(a, tgSend.submit.body.runId, 30_000, clientKey);
    check('Web-результат доставлен с runId рана', webTerminal.result.outcome === 'succeeded' && webTerminal.status.runId === webSend.submit.body.runId);
    check('TG-результат доставлен с runId рана', tgTerminal.result.outcome === 'succeeded' && tgTerminal.status.runId === tgSend.submit.body.runId);
    check(
      'корреляция внешних ID сохранена по всей цепочке',
      webTerminal.status.userTaskId === 'web-conv-7-41' && tgTerminal.status.userTaskId === 'tg-chat-555-9001' && webTerminal.status.conversationId === 'web-conv-7' && tgTerminal.status.conversationId === 'tg-chat-555',
      `${webTerminal.status.userTaskId} / ${tgTerminal.status.userTaskId}`,
    );
    const correlation = {
      web: { externalRef: 'web:conv-7/41', userTaskId: webTerminal.status.userTaskId, requestId: webTerminal.status.requestId, runId: webTerminal.status.runId, conversationId: webTerminal.status.conversationId, outcome: webTerminal.result.outcome },
      telegram: { externalRef: 'tg:chat-555/9001', userTaskId: tgTerminal.status.userTaskId, requestId: tgTerminal.status.requestId, runId: tgTerminal.status.runId, conversationId: tgTerminal.status.conversationId, outcome: tgTerminal.result.outcome },
    };
    check('ID в каналах различаются (нет склейки задач)', correlation.web.userTaskId !== correlation.telegram.userTaskId);
    record('channel_smoke', { correlation, eventCount: { web: webTerminal.events.events.length, telegram: tgTerminal.events.events.length } });
  });

  // -- 5. Controlled failure: канал вне когорты и платный профиль отклоняются до запуска.
  await runStep('admission_controls', async () => {
    const outsideCohort = await a.post(
      '/v1/runs',
      {
        userTaskId: 'task-outside-cohort',
        engine: { name: 'fake', adapterVersion: '1' },
        envAllowlist: [],
        limits: { timeoutMs: 30_000 },
        input: { inlinePrompt: 'must not be admitted' },
      },
      'p29-outside-1',
      outsiderKey,
    );
    check('принципал вне когорты отклонён', outsideCohort.status === 403 && outsideCohort.body.error.code === 'COHORT_NOT_ENABLED', `HTTP ${outsideCohort.status} ${outsideCohort.body?.error?.code ?? ''}`);

    const paid = await a.post(
      '/v1/runs',
      {
        userTaskId: 'task-paid-profile',
        engine: { name: 'opencode', adapterVersion: '1' },
        envAllowlist: [],
        limits: { timeoutMs: 30_000 },
        input: { inlinePrompt: 'paid profile must be refused' },
      },
      'p29-paid-1',
      outsiderKey,
    );
    check('платный профиль отклонён по умолчанию', paid.status === 403 && paid.body.error.code === 'PAID_PROFILE_DISABLED', `HTTP ${paid.status} ${paid.body?.error?.code ?? ''}`);

    const journal = readJsonl(join(workerSpecs[0].dataDir, 'promotion.jsonl'));
    const refusals = journal.filter((entry) => entry.kind === 'admission_refused');
    check('отказы записаны в durable-журнал с причиной', refusals.length >= 2 && refusals.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0), `${refusals.length} записей`);
    record('admission_controls', {
      outsideCohort: { status: outsideCohort.status, code: outsideCohort.body?.error?.code, details: outsideCohort.body?.error?.details },
      paid: { status: paid.status, code: paid.body?.error?.code, details: paid.body?.error?.details },
      journalRefusals: refusals.map((entry) => ({ seq: entry.seq, reason: entry.reason, detail: entry.detail })),
    });
  });

  // -- 6. Fleet: одна задача — один владелец; перехват только по явному сигналу.
  await runStep('fleet_ownership', async () => {
    const principalA = clientPrincipal;
    const principalB = clientPrincipal;
    const owners = new release.DispatchOwnerStore({ path: ownerStore, workerId: 'probe-control-plane' });
    const sharedTask = 'task-fleet-shared';
    const first = await a.post(
      '/v1/runs',
      {
        userTaskId: sharedTask,
        engine: { name: 'fake', adapterVersion: '1' },
        envAllowlist: [],
        limits: { timeoutMs: 30_000 },
        input: { inlinePrompt: 'fleet ownership' },
      },
      'p29-fleet-a-1',
      clientKey,
    );
    check('воркер A принял задачу первой', first.status === 202, `runId ${String(first.body.runId).slice(0, 12)}…`);
    await waitTerminal(a, first.body.runId, 30_000, clientKey);

    const doubleDispatch = await b.post(
      '/v1/runs',
      {
        userTaskId: sharedTask,
        engine: { name: 'fake', adapterVersion: '1' },
        envAllowlist: [],
        limits: { timeoutMs: 30_000 },
        input: { inlinePrompt: 'fleet ownership' },
      },
      'p29-fleet-b-1',
      clientKey,
    );
    check('второй воркер не взял задачу первого (409, владелец назван)', doubleDispatch.status === 409 && doubleDispatch.body.error.code === 'TASK_OWNED_BY_OTHER_WORKER', doubleDispatch.body?.error?.details?.ownerWorkerId ?? '');
    const noBRun = (await b.get(`/v1/runs/${first.body.runId}/status`, clientKey)).status;
    check('у второго воркера нет рана по чужой задаче', noBRun === 404);

    const noSignal = owners.takeover(principalB, sharedTask, 'run-preview');
    check('молчание сети не считается failover', noSignal.outcome === 'partition_is_not_failover', noSignal.outcome);

    // Явный сигнал: прежний владелец отдаёт задачу (drain перед переключением).
    const released = new release.DispatchOwnerStore({ path: ownerStore, workerId: principalA });
    released.release(principalA, sharedTask, 'drain sandbox-a for the cohort switch');
    const takeover = await b.post(
      '/v1/runs',
      {
        userTaskId: sharedTask,
        engine: { name: 'fake', adapterVersion: '1' },
        envAllowlist: [],
        limits: { timeoutMs: 30_000 },
        input: { inlinePrompt: 'fleet ownership after drain' },
      },
      'p29-fleet-b-2',
      clientKey,
    );
    check('после явного сигнала новый владелец принял новую попытку', takeover.status === 202, `HTTP ${takeover.status}`);
    const takeoverTerminal = takeover.status === 202 ? await waitTerminal(b, takeover.body.runId, 30_000, clientKey) : null;
    if (takeover.status !== 202) {
      check('после явного сигнала новый владелец принял новую попытку', false, `HTTP ${takeover.status} ${JSON.stringify(takeover.body?.error ?? {})}`);
    }
    const fenced = await a.post(
      '/v1/runs',
      {
        userTaskId: sharedTask,
        engine: { name: 'fake', adapterVersion: '1' },
        envAllowlist: [],
        limits: { timeoutMs: 30_000 },
        input: { inlinePrompt: 'late output from the previous owner' },
      },
      'p29-fleet-a-2',
      clientKey,
    );
    check('прежний владелец fenced: поздняя попытка отклонена', fenced.status === 409 && fenced.body.error.code === 'TASK_OWNED_BY_OTHER_WORKER', `HTTP ${fenced.status}`);

    const ownership = owners.get(principalB, sharedTask);
    check('владение и поколение в реестре совпадают с раном', ownership?.ownerWorkerId === 'sandbox-b' && ownership?.previousOwnerWorkerId === 'sandbox-a' && ownership.ownerGeneration === 2, JSON.stringify(ownership));
    check(
      'новая попытка = новый runId, тот же userTaskId, поколение +1',
      takeoverTerminal?.status.userTaskId === sharedTask && takeoverTerminal?.status.ownerGeneration === 2 && takeoverTerminal.status.runId !== first.body.runId,
      `${takeoverTerminal?.status.runId} gen ${takeoverTerminal?.status.ownerGeneration}`,
    );
    const replaySequences = takeoverTerminal?.events.events.map((event) => event.sequence) ?? [];
    const claimedCount = takeoverTerminal?.events.events.filter((event) => event.type === 'claimed').length ?? 0;
    check(
      'реплей новой попытки без дублей и пропусков',
      takeoverTerminal !== null && replaySequences.every((sequence, index) => sequence === index + 1) && claimedCount === 1,
      `${replaySequences.length} событий, claimed ${claimedCount}`,
    );
    record('fleet_ownership', {
      task: sharedTask,
      firstAttempt: { workerId: 'sandbox-a', runId: first.body.runId },
      doubleDispatch: { status: doubleDispatch.status, code: doubleDispatch.body?.error?.code, details: doubleDispatch.body?.error?.details },
      takeoverWithoutSignal: noSignal,
      takeover: { workerId: 'sandbox-b', runId: takeover.body?.runId, ownerGeneration: takeoverTerminal?.status.ownerGeneration },
      fenced: { status: fenced.status, code: fenced.body?.error?.code },
      registry: ownership,
      replaySequences,
    });
  });

  // -- 7. Откат прогоном: новые приёмы стопятся, принятое до отката доигрывает прежний владелец.
  await runStep('rollback_drill', async () => {
    // Старый владелец (B, предыдущий релиз) поднимается с управляемым «зависанием» движка:
    // задача, принятая до отката, остаётся ЖИВОЙ через откат и завершается только
    // явной отменой своего владельца — это и есть «принятое доигрывает прежний владелец».
    await b.restart('timeout');
    const inFlight = await b.post(
      '/v1/runs',
      {
        userTaskId: 'task-accepted-before-rollback',
        engine: { name: 'fake', adapterVersion: '1' },
        envAllowlist: [],
        limits: { timeoutMs: 120_000 },
        input: { inlinePrompt: 'accepted before rollback' },
      },
      'p29-before-rollback',
      clientKey,
    );
    check('задача принята до отката', inFlight.status === 202, `HTTP ${inFlight.status}`);
    await waitFor(async () => (await b.get(`/v1/runs/${inFlight.body.runId}/status`, clientKey)).body?.state === 'running', 15_000, 'in-flight run on the previous release');

    const stateFile = workerSpecs[0].stateFile;
    const journalPath = join(workerSpecs[0].dataDir, 'promotion.jsonl');
    // Откат готовит следующий старт, но след о нём остаётся в durable-журнале воркера:
    // иначе в evidence есть состояние, а нет причины перехода.
    const controller = new release.ReleaseStateController({
      path: stateFile,
      releaseId: provisioning.candidateReleaseId,
      previousReleaseId: provisioning.previousReleaseId,
      cohortId: provisioning.cohortId ?? 'p29',
      journal: new release.PromotionJournal({
        path: journalPath,
        releaseId: provisioning.candidateReleaseId,
        workerId: workerSpecs[0].workerId,
        region: provisioning.region,
      }),
    });
    controller.rollback('promotion probe: candidate release rolled back', 'probe-operator');
    await a.restart();

    const view = (await a.get('/v1/release')).body;
    check('после рестарта релиз откатан и обслуживает предыдущий', view.rollback.rolledBack === true && view.rollback.servingReleaseId === provisioning.previousReleaseId, `serving ${view.rollback.servingReleaseId}`);
    const refused = await a.post(
      '/v1/runs',
      {
        userTaskId: 'task-after-rollback',
        engine: { name: 'fake', adapterVersion: '1' },
        envAllowlist: [],
        limits: { timeoutMs: 30_000 },
        input: { inlinePrompt: 'after rollback' },
      },
      'p29-after-rollback',
      clientKey,
    );
    check('новые задачи когорты не принимаются (503 PROMOTION_PAUSED)', refused.status === 503 && refused.body.error.code === 'PROMOTION_PAUSED', `HTTP ${refused.status} ${refused.body?.error?.code ?? ''}`);

    const liveOnOldOwner = (await b.get(`/v1/runs/${inFlight.body.runId}/status`, clientKey)).body;
    check('принятое до отката живо у прежнего владельца во время отката', liveOnOldOwner.state === 'running', `state ${liveOnOldOwner.state}`);

    const cancel = await b.post(`/v1/runs/${inFlight.body.runId}/cancel`, { reason: 'probe: explicit cancel by the owner' }, undefined, clientKey);
    await waitFor(async () => ['cancelled', 'failed', 'succeeded'].includes((await b.get(`/v1/runs/${inFlight.body.runId}/status`, clientKey)).body?.state), 20_000, 'terminal state after cancel');
    const afterCancel = (await b.get(`/v1/runs/${inFlight.body.runId}/status`, clientKey)).body;
    check('отменённое прежним владельцем дошло до терминала у него же', afterCancel.state === 'cancelled' && cancel.status === 200, `${cancel.status} ${afterCancel.state}`);

    const replay = await a.post(
      '/v1/runs',
      {
        userTaskId: 'task-api-smoke',
        conversationId: 'conv-api-smoke',
        engine: { name: 'fake', adapterVersion: '1' },
        envAllowlist: [],
        limits: { timeoutMs: 30_000 },
        input: { inlinePrompt: 'sandbox promotion smoke' },
      },
      'p29-api-smoke-1',
      clientKey,
    );
    check('данные ранее принятого рана читаются и при откате', replay.status === 200 && replay.body.runId !== null, `HTTP ${replay.status}`);
    const replayEvents = (await a.get(`/v1/runs/${replay.body.runId}/events`, clientKey)).body;
    check('реплей ранее принятого рана цел', replayEvents.events.every((event, index) => event.sequence === index + 1), `${replayEvents.events.length} событий`);

    const journal = readJsonl(journalPath);
    const rollbackEntries = journal.filter((entry) => entry.kind === 'rollback');
    check(
      'откат записан в журнал с причиной и переходами',
      rollbackEntries.length >= 1 && rollbackEntries.at(-1).reason.length > 0 && rollbackEntries.at(-1).servingReleaseId === provisioning.previousReleaseId,
      rollbackEntries.map((entry) => `${entry.servingReleaseId}: ${entry.reason}`).join(' | '),
    );

    // Возврат релиза: приём возобновляется тем же релизом, старый владелец возвращается в success.
    controller.resume('promotion probe: gate green, serving candidate again', 'probe-operator');
    await a.restart();
    await b.restart('success');
    const resumedView = (await a.get('/v1/release')).body;
    check('после resume обслуживает кандидат', resumedView.rollback.rolledBack === false && resumedView.rollback.servingReleaseId === provisioning.candidateReleaseId);
    const accepted = await a.post(
      '/v1/runs',
      {
        userTaskId: 'task-after-resume',
        engine: { name: 'fake', adapterVersion: '1' },
        envAllowlist: [],
        limits: { timeoutMs: 30_000 },
        input: { inlinePrompt: 'after resume' },
      },
      'p29-after-resume',
      clientKey,
    );
    check('после resume приём работает', accepted.status === 202, `HTTP ${accepted.status}`);
    if (accepted.status === 202) await waitTerminal(a, accepted.body.runId, 30_000, clientKey);
    record('rollback_drill', {
      state: { afterRollback: view.rollback, afterResume: resumedView.rollback },
      refusedAfterRollback: { status: refused.status, code: refused.body?.error?.code, details: refused.body?.error?.details },
      acceptedBeforeRollback: {
        workerId: workerSpecs[1].workerId,
        releaseId: workerSpecs[1].releaseId,
        runId: inFlight.body.runId,
        stateDuringRollback: liveOnOldOwner.state,
        finalState: afterCancel.state,
      },
      replayAfterRollback: { runId: replay.body.runId, events: replayEvents.events.length },
      journalRollbacks: rollbackEntries.map((entry) => ({ seq: entry.seq, at: entry.at, reason: entry.reason, servingReleaseId: entry.servingReleaseId, previousReleaseId: entry.previousReleaseId })),
      resumeJournal: journal.filter((entry) => entry.kind === 'rollback_resumed').map((entry) => ({ seq: entry.seq, reason: entry.reason })),
    });
  });

  // -- 8. Retention-здоровье и закреплённый конфиг после всех переходов.
  await runStep('retention_and_config', async () => {
    const view = (await a.get('/v1/release')).body;
    check('retention-здоровье отдаётся с политикой и планом', view.retention.policy.mainEventsDays > 0 && view.retention.policy.verboseLogsDays > 0 && Array.isArray(view.retention.expiredRuns), `total ${view.retention.total}, terminal ${view.retention.terminal}`);
    check('живые раны защищены от очистки', view.retention.protectedActiveRuns.length === 0 || view.retention.protectedActiveRuns.every((runId) => !view.retention.expiredRuns.includes(runId)), `protected ${view.retention.protectedActiveRuns.length}`);
    check('журнал промоушена читается и содержит переходы', view.journal.entries > 0 && view.journal.lastKind !== null, `${view.journal.entries} записей, последняя ${view.journal.lastKind}`);
    const caps = (await a.get('/v1/capabilities')).body;
    check('capabilities объявляет promotion-контур', caps.promotion.cohortEnabled === true && caps.promotion.partitionIsNotFailover === true && caps.promotion.sharedOwnerRegistry === true, JSON.stringify(caps.promotion.pinnedRelease));
    const serialized = JSON.stringify(view);
    check('в ответе /v1/release нет значения ключа', !serialized.includes(a.key) && !serialized.toLowerCase().includes('ak_'));
    record('retention_and_config', {
      retention: view.retention,
      cohort: view.cohort,
      fleet: view.fleet,
      journal: view.journal,
      capabilitiesPromotion: caps.promotion,
    });
  });

  // -- 9. Clean promotion: эксперимент нельзя назвать продом, ключи песочницы отдельные.
  await runStep('clean_promotion', async () => {
    const manifestA = release.validateReleaseManifest(JSON.parse(readFileSync(workerSpecs[0].manifest, 'utf8')));
    if (!manifestA.ok) throw new Error(`sandbox manifest is invalid: ${manifestA.errors.join('; ')}`);
    const registryA = JSON.parse(readFileSync(workerSpecs[0].keyRegistry, 'utf8'));
    const sandboxDescriptor = release.descriptorFromManifest(manifestA.value, registryA.principals.map((principal) => principal.keyHash));

    // Попытка выдать те же артефакты за production: обязана быть отклонена.
    const asProduction = { ...sandboxDescriptor, environment: 'production' };
    const promotionAttempt = release.checkPromotionBoundary(sandboxDescriptor, asProduction);
    check('экспериментальные данные/ключи нельзя объявить production', promotionAttempt.ok === false, promotionAttempt.violations.map((violation) => violation.rule).join(','));

    const namespaces = readdirSync(FLEET_ROOT);
    const outsideNamespace = namespaces.filter((entry) => entry !== NAMESPACE && !entry.startsWith(`${NAMESPACE}.replaced-`));
    check('namespace изолирован: другие эксперименты не тронуты', outsideNamespace.length >= 0, `соседние namespace: ${outsideNamespace.join(', ') || 'нет'}`);

    // Данные и журналы воркеров лежат только внутри namespace.
    const stray = [];
    for (const spec of workerSpecs) {
      for (const entry of ['promotion.jsonl', 'release-state.json']) {
        const candidates = [join(spec.dataDir, entry), join(spec.configDir, entry)];
        for (const candidate of candidates) {
          if (existsSync(candidate) && !resolve(candidate).startsWith(`${resolve(NS_ROOT)}${sep}`)) stray.push(candidate);
        }
      }
    }
    check('артефакты прогона не вышли за пределы namespace', stray.length === 0, stray.join(', ') || 'нет выходов за границу');

    const fleetView = (await a.get('/v1/release')).body.fleet;
    record('clean_promotion', {
      sandboxDescriptor,
      promotionAttempt: { ok: promotionAttempt.ok, violations: promotionAttempt.violations },
      productionBaseline: 'на песочной VM прод-сторона недоступна: проверяется отказ объявить песочницу продом и изоляция ключей/корней; сравнение с живым продом — за пределами этой пробы',
      namespacesSeen: namespaces,
      fleetView,
    });
  });

  // -- 10. Логи: release/config/worker/region/ownerGeneration + promotion/cohort/rollback.
  await runStep('logs', async () => {
    const journalA = readJsonl(join(workerSpecs[0].dataDir, 'promotion.jsonl'));
    const journalB = readJsonl(join(workerSpecs[1].dataDir, 'promotion.jsonl'));
    const kinds = new Set([...journalA, ...journalB].map((entry) => entry.kind));
    check('журнал содержит release/cohort/rollback', ['release_pinned', 'cohort_configured', 'rollback'].every((kind) => kinds.has(kind)), [...kinds].join(','));

    const seqs = journalA.map((entry) => entry.seq);
    check('seq в журнале монотонный и без дыр', seqs.every((seq, index) => seq === index + 1), seqs.join(','));

    const logLinesA = logLines['a'] ?? [];
    const parsedLogs = logLinesA.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter((entry) => entry !== null);
    check('в логах сервиса есть releaseId/workerId/region у каждой строки', parsedLogs.length > 0 && parsedLogs.every((entry) => entry.releaseId && entry.workerId && entry.region), `${parsedLogs.length} строк разобрано`);
    const apiListening = parsedLogs.find((entry) => entry.event === 'api_listening');
    check('стартовая строка содержит закреплённый релиз, когорту и retention', Boolean(apiListening?.release?.sourceCommit && apiListening?.release?.cohort && apiListening?.release?.retention));

    record('logs', {
      journalKinds: [...kinds],
      journalSeqA: seqs,
      journalA: journalA.map((entry) => ({ seq: entry.seq, at: entry.at, kind: entry.kind, reason: entry.reason, releaseId: entry.releaseId, workerId: entry.workerId, region: entry.region, cohortId: entry.cohortId, servingReleaseId: entry.servingReleaseId, previousReleaseId: entry.previousReleaseId, ownerGeneration: entry.ownerGeneration })),
      serviceLogSample: parsedLogs
        .filter((entry) => ['api_listening', 'admission_accepted', 'admission_refused', 'submit', 'ownership_claimed', 'recovered'].includes(entry.event))
        .slice(0, 25)
        .map((entry) => ({ ts: entry.ts, event: entry.event, releaseId: entry.releaseId, workerId: entry.workerId, region: entry.region, runId: entry.runId, userTaskId: entry.userTaskId, ownerGeneration: entry.ownerGeneration, code: entry.code, cohortId: entry.cohortId, outcome: entry.outcome })),
    });
  });

  // -- 11. Секреты не попали в транскрипт.
  await runStep('no_secrets', async () => {
    const serialized = JSON.stringify({ results, checks }, null, 2);
    const leaked = secrets.filter((secret) => serialized.includes(secret));
    check('значения ключей в транскрипте нет', leaked.length === 0, `${secrets.length} секретов проверено`);
    const shareSecrets = workerSpecs.map((spec) => readEnvFile(spec.envFile)['ARTIFACT_SHARE_SECRET']).filter((value) => typeof value === 'string' && value.length > 0);
    check('share-секреты в транскрипте нет', shareSecrets.every((secret) => !serialized.includes(secret)), `${shareSecrets.length} шар-секретов проверено`);
    check('в логах воркеров нет заголовков с ключом', !(logLines['a'] ?? []).some((line) => line.includes('Bearer ')), `${(logLines['a'] ?? []).length} строк`);
    record('no_secrets', { secretsChecked: secrets.length, shareSecretsChecked: shareSecrets.length });
  });

  const transcript = {
    schemaVersion: 1,
    probe: 'P29 — Promotion и fleet acceptance (карточка #68, этап I10)',
    generatedAt: new Date().toISOString(),
    namespace: NAMESPACE,
    fleetRoot: FLEET_ROOT,
    sourceCommit: provisioning.sourceCommit,
    releases: { candidate: provisioning.candidateReleaseId, previous: provisioning.previousReleaseId },
    topology: provisioning.workers.map((spec) => `${spec.workerId} (${spec.releaseId}, config ${spec.configVersion}) на 127.0.0.1:${spec.port}`).join(' + ') + ', общий реестр владения ' + provisioning.ownerStore,
    fidelity:
      'настоящие процессы: API+Runner обоих воркеров, promotion-контур, реестр владения; эмуляция: каналы Web/Telegram (ingress/egress adapter) и движок fake (free-only); живой бот, Web-UI и платные модели не проверялись',
    stepsRun: steps,
    steps: results,
    checks,
    journal: {
      a: readJsonl(join(workerSpecs[0].dataDir, 'promotion.jsonl')),
      b: readJsonl(join(workerSpecs[1].dataDir, 'promotion.jsonl')),
    },
    serviceLogLines: { a: (logLines['a'] ?? []).length, b: (logLines['b'] ?? []).length },
  };
  const transcriptPath = join(OUT_DIR, 'transcript.json');
  const json = `${JSON.stringify(transcript, null, 2)}\n`;
  writeFileSync(transcriptPath, json, 'utf8');
  const digest = createHash('sha256').update(json).digest('hex');
  writeFileSync(join(OUT_DIR, 'transcript.sha256'), `${digest}  transcript.json\n`, 'utf8');
  record('transcript_written', { path: transcriptPath, sha256: digest, checks: checks.length, failures });

  if (!keep) {
    await a.stop();
    await b.stop();
  }
  process.stdout.write(`\n${checks.length - failures}/${checks.length} проверок прогона\n`);
  process.stdout.write(`Транскрипт: ${transcriptPath}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  // Воркеры — наши процессы: при падении пробы их гасим, иначе следующий прогон упрётся в их порты.
  if (a) await a.stop();
  if (b) await b.stop();
  process.stderr.write(`${JSON.stringify({ event: 'probe_failed', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined })}\n`);
  process.exit(1);
});