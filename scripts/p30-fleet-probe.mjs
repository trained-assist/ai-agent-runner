#!/usr/bin/env node
// Проба приёмки P30 (карточка #69, этап I10): multi-worker/region contract на одной VM.
//
// Топология: два настоящих API-процесса воркеров в одном namespace песочницы в РАЗНЫХ
// регионах (sandbox-a = sandbox-ru, sandbox-b = sandbox-eu), общий реестр владения
// задачами, политика размещения в config каждого воркера, детерминированный fake-движок
// (free-only). Проверяется контракт размещения (регион × провайдер × credentials ×
// резидентность), drain и fencing при управляемом сбое — включая отсутствие двойного
// исполнения после failover.
//
// Запуск (из корня репозитория, после npm ci && npm run build):
//   sudo scripts/recreate-sandbox.sh --namespace p30-$(date -u +%Y%m%d) \
//     --regions sandbox-ru,sandbox-eu \
//     --placement scripts/fixtures/p30-sandbox-placement-policy.json \
//     --client-engines fake,opencode,claude,codex --owner sandbox
//   node scripts/p30-fleet-probe.mjs --fleet-root /var/lib/agent-runner-fleet --namespace p30-…
//
// Опции:
//   --out <dir>        каталог транскрипта (по умолчанию docs/evidence/p30-fleet)
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
  process.stderr.write('usage: p30-fleet-probe.mjs --fleet-root <dir> --namespace <id> [--out <dir>] [--keep] [--only <step>]\n');
  process.exit(2);
}

const FLEET_ROOT = resolve(fleetRootFlag);
const NAMESPACE = namespaceFlag;
const NS_ROOT = join(FLEET_ROOT, NAMESPACE);
const PROVISIONING = join(NS_ROOT, 'provisioning.json');
const OUT_DIR = outFlag ? resolve(outFlag) : join(REPO, 'docs', 'evidence', 'p30-fleet');

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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ---------------------------------------------------------------- worker process

class Worker {
  constructor(spec, key, bucket, region) {
    this.spec = spec;
    this.workerId = spec.workerId;
    this.releaseId = spec.releaseId;
    this.port = spec.port;
    this.region = region;
    this.base = `http://127.0.0.1:${spec.port}`;
    this.key = key;
    this.env = readEnvFile(spec.envFile);
    this.child = null;
    this.logPath = spec.logFile;
    this.bucket = bucket;
    this.fakeScenario = 'success';
    this.exitInfo = null;
  }

  start() {
    this.child = spawn(process.execPath, [join(DIST, 'api', 'main.js')], {
      env: { ...process.env, ...this.env, AGENT_API_FAKE_SCENARIO: this.fakeScenario },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      const tail = this.bucket.slice(-3).join(' | ') || '(no output)';
      throw new Error(`${err instanceof Error ? err.message : String(err)}; ${this.workerId} output: ${tail}`);
    }
  }

  /** Перезапуск процесса — как рестарт юнита: recover() разбирает незавершённые раны. */
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
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }

  /**
   * Управляемый сбой: SIGKILL процесса воркера и его движка (на реальной машине движок
   * умирает вместе с ней), никакой финализации. Осиротевший движок убивается по pid из
   * state.json рана: иначе recover() честно пометил бы ран orphaned, а не потерянным.
   */
  async killHard(runId) {
    if (!this.child || this.child.exitCode !== null) return false;
    const pid = this.child.pid;
    let enginePid = null;
    if (runId !== undefined) {
      try {
        const state = JSON.parse(readFileSync(join(this.spec.dataDir, 'runs', runId, 'state.json'), 'utf8'));
        enginePid = typeof state.pid === 'number' ? state.pid : null;
      } catch {
        enginePid = null;
      }
    }
    this.child.kill('SIGKILL');
    if (enginePid !== null && enginePid !== pid) {
      try {
        process.kill(enginePid, 'SIGKILL');
      } catch {
        // движок уже мёртв
      }
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && this.child.exitCode === null) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    return this.exitInfo !== null && pid !== undefined;
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

async function waitTerminal(worker, runId, timeoutMs = 30_000, key) {
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

function runsCount(spec) {
  const runsDir = join(spec.dataDir, 'runs');
  return existsSync(runsDir) ? readdirSync(runsDir).length : 0;
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
  if (workerSpecs.length < 2) throw new Error(`two workers are required for the multi-region simulation, got ${workerSpecs.length}`);
  if (provisioning.regions === undefined || provisioning.regions.length !== workerSpecs.length) {
    throw new Error('provisioning has no per-worker regions; re-create the namespace with --regions sandbox-ru,sandbox-eu');
  }

  const principalIdForKey = (key, spec) => {
    const registry = JSON.parse(readFileSync(spec.keyRegistry, 'utf8'));
    const hit = registry.principals.find((principal) => principal.keyHash === hashOf(key));
    if (!hit) throw new Error(`key is not registered for ${spec.workerId} (no matching keyHash in ${spec.keyRegistry})`);
    return hit.principalId;
  };

  const regionByWorker = new Map(workerSpecs.map((spec, index) => [spec.workerId, provisioning.regions[index]]));
  a = new Worker(workerSpecs[0], readKey(workerSpecs[0].keyFile), logLines.a, regionByWorker.get(workerSpecs[0].workerId));
  b = new Worker(workerSpecs[1], readKey(workerSpecs[1].keyFile), logLines.b, regionByWorker.get(workerSpecs[1].workerId));
  // RU-воркер работает с зависающим движком: задача живёт до управляемого сбоя.
  a.fakeScenario = 'timeout';
  const clientKey = readKey(join(NS_ROOT, 'config', 'client-api-key'));
  const outsiderKey = readKey(join(NS_ROOT, 'config', 'outsider-api-key'));
  const clientPrincipal = principalIdForKey(clientKey, workerSpecs[0]);
  const ownerStore = provisioning.ownerStore;
  const steps = [];
  // Ран, принятый RU-воркером до drain: на нём проверяется failover без двойного исполнения.
  let failoverRunA = null;
  // Операторские действия в реестре (drain/перехват) пишутся в журнал того воркера,
  // чью запись они меняют — как это делает сервис воркера (main.ts).
  const journalFor = (spec) =>
    new release.PromotionJournal({
      path: join(spec.dataDir, 'promotion.jsonl'),
      releaseId: spec.releaseId,
      workerId: spec.workerId,
      region: regionByWorker.get(spec.workerId),
    });
  const appendOwnerEvent = (journal, event) => {
    const kind = { drained: 'drain', failover_granted: 'failover', fenced: 'fenced' }[event.event];
    if (kind === undefined) return;
    journal.append({
      kind,
      reason: event.reason,
      ownerGeneration: event.ownerGeneration,
      detail: {
        principalId: event.principalId,
        userTaskId: event.userTaskId,
        ...(event.previousOwnerWorkerId !== undefined ? { previousOwnerWorkerId: event.previousOwnerWorkerId } : {}),
      },
    });
  };
  const placementPathA = join(workerSpecs[0].configDir, 'placement.json');
  const placementPathB = join(workerSpecs[1].configDir, 'placement.json');
  if (!existsSync(placementPathA) || !existsSync(placementPathB)) {
    throw new Error('placement policy is not configured for both workers; re-create the namespace with --placement scripts/fixtures/p30-sandbox-placement-policy.json');
  }
  const policyJsonA = readFileSync(placementPathA, 'utf8');
  const policyJsonB = readFileSync(placementPathB, 'utf8');
  const originalPlacementB = JSON.parse(policyJsonB);

  record('probe_started', {
    namespace: NAMESPACE,
    fleetRoot: FLEET_ROOT,
    sourceCommit: provisioning.sourceCommit,
    candidateReleaseId: provisioning.candidateReleaseId,
    previousReleaseId: provisioning.previousReleaseId,
    outDir: OUT_DIR,
    topology: 'client → worker A (sandbox-ru) + worker B (sandbox-eu), общий реестр владения, placement policy на каждый воркер',
    fidelity:
      'настоящие процессы: API+Runner обоих воркеров, placement-политика, реестр владения; эмуляция: движок fake (free-only), два региона ОДНОЙ машины; настоящие RU/EU workers и прод не трогаются',
    keysConfigured: secrets.length,
  });

  const runStep = async (id, fn) => {
    if (onlyFlag && onlyFlag !== id) return undefined;
    const value = await fn();
    steps.push(id);
    return value;
  };

  // -- 1. Чистая песочница: namespace создан заново, placement настроен, прогонов не было.
  await runStep('sandbox_fresh', async () => {
    const runsBefore = workerSpecs.map((spec) => runsCount(spec));
    check('namespace создан заново: ни одного рана до прогона', runsBefore.every((count) => count === 0), `runs до прогона: ${runsBefore.join('/')}`);

    const policyA = JSON.parse(policyJsonA);
    const policyB = JSON.parse(policyJsonB);
    check(
      'политика размещения одинаково настроена на обоих воркерах',
      JSON.stringify(policyA) === JSON.stringify(policyB) && policyA.authority === 'sandbox_probe' && policyA.dataResidency.decided === false,
      `policyId ${policyA.policyId}, authority ${policyA.authority}, dataResidency.decided ${policyA.dataResidency.decided}`,
    );
    check(
      'регионы воркеров различны (симуляция двух зон на одной машине)',
      regionByWorker.get(workerSpecs[0].workerId) !== regionByWorker.get(workerSpecs[1].workerId),
      `${regionByWorker.get(workerSpecs[0].workerId)} / ${regionByWorker.get(workerSpecs[1].workerId)}`,
    );
    check(
      'в provisioning-манифесте нет значений секретов',
      !JSON.stringify(provisioning).includes(a.key) && !JSON.stringify(provisioning).toLowerCase().includes('ak_'),
    );
    record('sandbox_fresh', {
      runsBefore,
      regions: { a: a.region, b: b.region },
      policyId: policyA.policyId,
      dataResidencyDecided: policyA.dataResidency.decided,
      replacedNamespaces: readdirSync(FLEET_ROOT).filter((entry) => entry.startsWith(`${NAMESPACE}.replaced-`)),
    });
  });

  // -- 1a. Порты свободны: иначе «воркер не поднялся» неотличим от чужого сервиса на порту.
  await runStep('ports_free', async () => {
    for (const worker of [a, b]) {
      const taken = await portInUse(worker.port);
      check(`порт ${worker.port} свободен до старта ${worker.workerId}`, !taken, taken ? 'порт занят посторонним процессом' : '');
    }
  });

  // -- 2. Оба воркера поднимаются: закреплённый релиз, свой регион, placement на месте.
  await runStep('workers_started', async () => {
    a.start();
    b.start();
    await a.waitHealthy();
    await b.waitHealthy();
    const releaseA = (await a.get('/v1/release')).body;
    const releaseB = (await b.get('/v1/release')).body;
    check('релиз A закреплён', releaseA.release.releaseId === provisioning.candidateReleaseId && releaseA.release.sourceCommit === provisioning.sourceCommit, `${releaseA.release.releaseId}@${releaseA.release.sourceCommit.slice(0, 8)}`);
    check('релиз B закреплён на предыдущем', releaseB.release.releaseId === provisioning.previousReleaseId, releaseB.release.releaseId);
    check(
      'воркеры в разных регионах и с разными workerId/портами',
      releaseA.release.region === a.region && releaseB.release.region === b.region && releaseA.release.workerId !== releaseB.release.workerId && a.port !== b.port,
      `${releaseA.release.workerId}:${releaseA.release.region}:${a.port} / ${releaseB.release.workerId}:${releaseB.release.region}:${b.port}`,
    );
    check('платные профили выключены у обоих воркеров', releaseA.release.paidProfilesAllowed === false && releaseB.release.paidProfilesAllowed === false);
    check('политика placement опубликована в /v1/release', releaseA.placement?.policyId === JSON.parse(policyJsonA).policyId && releaseB.placement?.policyId === JSON.parse(policyJsonB).policyId, `${releaseA.placement?.policyId} / ${releaseB.placement?.policyId}`);
    check('резидентность данных заявлена как нерешённая', releaseA.placement?.dataResidency?.decided === false && releaseB.placement?.dataResidency?.decided === false);
    const caps = (await a.get('/v1/capabilities')).body;
    check(
      'capabilities объявляет placement и повторную проверку Runner-ом',
      caps.promotion.placement !== null && caps.promotion.placement.workerRegion === a.region && caps.promotion.placement.runnerRechecksEngineRegion === true,
      JSON.stringify(caps.promotion.placement?.allowedEngines ?? null),
    );
    record('workers_started', {
      a: { workerId: releaseA.release.workerId, region: releaseA.release.region, releaseId: releaseA.release.releaseId, port: a.port, placement: releaseA.placement },
      b: { workerId: releaseB.release.workerId, region: releaseB.release.region, releaseId: releaseB.release.releaseId, port: b.port, placement: releaseB.placement },
      capabilities: { placement: caps.promotion.placement },
    });
    return { releaseA, releaseB };
  });

  // -- 3. Матрица размещения на уровне политики: регион × провайдер × credentials × резидентность.
  await runStep('placement_matrix', async () => {
    const policy = release.validatePlacementPolicy(JSON.parse(policyJsonA)).value;
    const ru = { workerId: a.workerId, region: a.region };
    const eu = { workerId: b.workerId, region: b.region };
    const cases = [
      { subject: { engineName: 'fake' }, ru: 'place', eu: 'place' },
      { subject: { engineName: 'opencode', model: 'free-ladder/grok' }, ru: 'place', eu: 'place' },
      { subject: { engineName: 'opencode', model: 'zen/grok' }, ru: 'PROVIDER_REGION_FORBIDDEN', eu: 'place' },
      { subject: { engineName: 'claude' }, ru: 'REGION_ENGINE_FORBIDDEN', eu: 'REGION_EXPLICIT_PROFILE_REQUIRED' },
      { subject: { engineName: 'codex' }, ru: 'REGION_ENGINE_FORBIDDEN', eu: 'REGION_EXPLICIT_PROFILE_REQUIRED' },
      { subject: { engineName: 'gemini' }, ru: 'REGION_ENGINE_UNDECLARED', eu: 'REGION_ENGINE_UNDECLARED' },
      { subject: { engineName: 'fake', credentialBindings: [{ ref: 'sb-llm', scope: 'llm:call' }] }, ru: 'CREDENTIAL_REGION_FORBIDDEN', eu: 'place' },
      { subject: { engineName: 'fake', credentialBindings: [{ ref: 'sb-x', scope: 'unknown:scope' }] }, ru: 'CREDENTIAL_SCOPE_UNDECLARED', eu: 'CREDENTIAL_SCOPE_UNDECLARED' },
      { subject: { engineName: 'fake', regionConstraints: { dataResidency: 'sandbox-ru' } }, ru: 'DATA_RESIDENCY_UNDECIDED', eu: 'DATA_RESIDENCY_UNDECIDED' },
    ];
    const matrix = [];
    let ok = true;
    for (const testCase of cases) {
      const onRu = release.decidePlacement(policy, ru, testCase.subject);
      const onEu = release.decidePlacement(policy, eu, testCase.subject);
      const actualRu = onRu.place ? 'place' : onRu.code;
      const actualEu = onEu.place ? 'place' : onEu.code;
      const matched = actualRu === testCase.ru && actualEu === testCase.eu;
      ok = ok && matched;
      matrix.push({ ...testCase.subject, expected: { ru: testCase.ru, eu: testCase.eu }, actual: { ru: actualRu, eu: actualEu }, matched });
    }
    check('матрица размещения совпала с контрактом (все 9 сценариев)', ok, matrix.filter((row) => !row.matched).map((row) => `${row.engineName ?? ''}: ${JSON.stringify(row.actual)}`).join(' | ') || 'все совпали');
    check(
      'OpenCode вне RU: провайдер разрешён в обеих зонах, но zen только в EU',
      matrix.find((row) => row.model === 'free-ladder/grok')?.actual.ru === 'place' && matrix.find((row) => row.model === 'zen/grok')?.actual.ru === 'PROVIDER_REGION_FORBIDDEN',
    );
    const claudeRow = matrix.find((row) => row.engineName === 'claude');
    const codexRow = matrix.find((row) => row.engineName === 'codex');
    check(
      'Claude/Codex не в RU, в EU — только с явным профилем (его нет)',
      claudeRow?.actual.ru === 'REGION_ENGINE_FORBIDDEN' && claudeRow?.actual.eu === 'REGION_EXPLICIT_PROFILE_REQUIRED' && codexRow?.actual.ru === 'REGION_ENGINE_FORBIDDEN' && codexRow?.actual.eu === 'REGION_EXPLICIT_PROFILE_REQUIRED',
      `claude ${claudeRow?.actual.ru}/${claudeRow?.actual.eu}, codex ${codexRow?.actual.ru}/${codexRow?.actual.eu}`,
    );
    const screened = release.screenWorkers(policy, [{ ...ru, draining: false }, { ...eu, draining: true }], { engineName: 'claude' });
    check('screenWorkers оставляет только подходящего и называет причину отказа', screened.eligible.length === 0 && screened.rejected.length === 2 && screened.rejected.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0), screened.rejected.map((entry) => `${entry.workerId}:${entry.code}`).join(', '));
    record('placement_matrix', { matrix, screen: screened, allowedEngines: { ru: release.allowedEnginesForRegion(policy, ru.region), eu: release.allowedEnginesForRegion(policy, eu.region) } });
  });

  // -- 4. Отказы на уровне сервиса: до записи рана, с причиной в журнале.
  await runStep('placement_http', async () => {
    const runsBefore = workerSpecs.map((spec) => runsCount(spec));

    const claudeRu = await a.post('/v1/runs', { userTaskId: 'task-claude-ru', engine: { name: 'claude', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 30_000 } }, 'p30-claude-ru', clientKey);
    check('Claude в RU отклонён политикой региона', claudeRu.status === 403 && claudeRu.body.error.code === 'REGION_ENGINE_FORBIDDEN', `HTTP ${claudeRu.status} ${claudeRu.body?.error?.code ?? ''}`);
    const claudeEu = await b.post('/v1/runs', { userTaskId: 'task-claude-eu', engine: { name: 'claude', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 30_000 } }, 'p30-claude-eu', clientKey);
    check('Claude в EU требует явный профиль', claudeEu.status === 403 && claudeEu.body.error.code === 'REGION_EXPLICIT_PROFILE_REQUIRED', `HTTP ${claudeEu.status} ${claudeEu.body?.error?.code ?? ''}`);
    const codexRu = await a.post('/v1/runs', { userTaskId: 'task-codex-ru', engine: { name: 'codex', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 30_000 } }, 'p30-codex-ru', clientKey);
    check('Codex в RU отклонён политикой региона', codexRu.status === 403 && codexRu.body.error.code === 'REGION_ENGINE_FORBIDDEN', `HTTP ${codexRu.status} ${codexRu.body?.error?.code ?? ''}`);

    const zenRu = await a.post('/v1/runs', { userTaskId: 'task-zen-ru', engine: { name: 'opencode', adapterVersion: '1', modelSettings: { model: 'zen/grok' } }, envAllowlist: [], limits: { timeoutMs: 30_000 } }, 'p30-zen-ru', clientKey);
    check('OpenCode/zen в RU отклонён провайдером', zenRu.status === 403 && zenRu.body.error.code === 'PROVIDER_REGION_FORBIDDEN', `HTTP ${zenRu.status} ${zenRu.body?.error?.code ?? ''}`);
    const zenEu = await b.post('/v1/runs', { userTaskId: 'task-zen-eu', engine: { name: 'opencode', adapterVersion: '1', modelSettings: { model: 'zen/grok' } }, envAllowlist: [], limits: { timeoutMs: 30_000 } }, 'p30-zen-eu', clientKey);
    check('OpenCode/zen в EU: регион пройден, отказ уже по платному флагу', zenEu.status === 403 && zenEu.body.error.code === 'PAID_PROFILE_DISABLED', `HTTP ${zenEu.status} ${zenEu.body?.error?.code ?? ''}`);

    const credRu = await a.post('/v1/runs', { userTaskId: 'task-cred-ru', engine: { name: 'fake', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 30_000 }, credentialBindings: [{ ref: 'sb-llm', scope: 'llm:call', status: 'active' }] }, 'p30-cred-ru', clientKey);
    check('credential scope вне региона воркера отклонён', credRu.status === 403 && credRu.body.error.code === 'CREDENTIAL_REGION_FORBIDDEN', `HTTP ${credRu.status} ${credRu.body?.error?.code ?? ''}`);
    const residency = await b.post('/v1/runs', { userTaskId: 'task-residency', engine: { name: 'fake', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 30_000 }, regionConstraints: { dataResidency: 'sandbox-ru' } }, 'p30-residency', clientKey);
    check('требование резидентности без решения владельца — отказ, а не молчаливый выбор', residency.status === 409 && residency.body.error.code === 'DATA_RESIDENCY_UNDECIDED' && residency.body.error.details.ownerDecisionRequired === true, `HTTP ${residency.status} ${residency.body?.error?.code ?? ''}`);

    const runsAfterRefusals = workerSpecs.map((spec) => runsCount(spec));
    check('после отказов размещения ни одного рана создано не было', JSON.stringify(runsBefore) === JSON.stringify(runsAfterRefusals), `runs: ${runsBefore.join('/')} → ${runsAfterRefusals.join('/')}`);

    const journalA = readJsonl(join(workerSpecs[0].dataDir, 'promotion.jsonl'));
    const placementRefusals = journalA.filter((entry) => entry.kind === 'placement_refused');
    check('отказы размещения записаны в durable-журнал с причиной', placementRefusals.length >= 3 && placementRefusals.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0), `${placementRefusals.length} записей`);

    // Положительный путь: разрешённый ран проходит placement и логируется с регионом.
    const accepted = await b.post('/v1/runs', { userTaskId: 'task-placement-ok', engine: { name: 'fake', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 30_000 }, credentialBindings: [{ ref: 'sb-fixture', scope: 'sandbox:fixture', status: 'active' }] }, 'p30-ok-eu', clientKey);
    check('разрешённый в EU ран принят', accepted.status === 202, `HTTP ${accepted.status}`);
    if (accepted.status === 202) await waitTerminal(b, accepted.body.runId, 30_000, clientKey);
    const admitted = logLines.b.filter((line) => line.includes('"event":"placement_admitted"')).map((line) => JSON.parse(line));
    check('placement_admitted записан с регионом и причинами', admitted.length >= 1 && admitted[0].placement.region === b.region && Array.isArray(admitted[0].placement.reasons), `${admitted.length} записей`);

    // Явный профиль решается политикой, а не зашит в код: включаем профиль в EU-конфиге
    // и видим, что региональный гейт пропускает (останавливает уже paid-флаг).
    const flipped = JSON.parse(policyJsonB);
    flipped.engines.claude.explicitProfileRef = 'owner-decision/p30-explicit-profile-drill';
    writeFileSync(placementPathB, `${JSON.stringify(flipped, null, 2)}\n`, 'utf8');
    await b.restart();
    const claudeEuAfter = await b.post('/v1/runs', { userTaskId: 'task-claude-eu-profiled', engine: { name: 'claude', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 30_000 } }, 'p30-claude-eu-profiled', clientKey);
    check(
      'явный профиль в политике открывает регион EU (далее отказывает paid-флаг)',
      claudeEuAfter.status === 403 && claudeEuAfter.body.error.code === 'PAID_PROFILE_DISABLED',
      `HTTP ${claudeEuAfter.status} ${claudeEuAfter.body?.error?.code ?? ''}`,
    );
    writeFileSync(placementPathB, `${JSON.stringify(originalPlacementB, null, 2)}\n`, 'utf8');
    await b.restart();
    const restored = (await b.get('/v1/release')).body;
    check('политика возвращена к исходной (drill не оставил следов)', restored.placement.engines.claude.explicitProfileRef === null && JSON.parse(policyJsonB).engines.claude.explicitProfileRef === null);

    record('placement_http', {
      refusals: {
        claudeRu: claudeRu.body?.error,
        claudeEu: claudeEu.body?.error,
        codexRu: codexRu.body?.error,
        zenRu: zenRu.body?.error,
        zenEu: zenEu.body?.error,
        credRu: credRu.body?.error,
        residency: residency.body?.error,
      },
      runsBefore,
      runsAfterRefusals,
      journalPlacementRefusals: placementRefusals.map((entry) => ({ seq: entry.seq, reason: entry.reason, code: entry.detail?.code })),
      accepted: { runId: accepted.body?.runId, placement: admitted[0]?.placement },
      explicitProfileDrill: { claudeEuAfter: { status: claudeEuAfter.status, code: claudeEuAfter.body?.error?.code }, restoredPolicyId: restored.placement.policyId },
    });
  });

  // -- 5. Drain: воркер в drain не берёт новых задач, принятые доигрывает он сам (AC-323).
  await runStep('drain_before_failover', async () => {
    const inFlight = await a.post('/v1/runs', { userTaskId: 'task-failover', engine: { name: 'fake', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 120_000 }, input: { inlinePrompt: 'accepted before drain' } }, 'p30-failover-1', clientKey);
    check('задача принята RU-воркером до drain', inFlight.status === 202, `HTTP ${inFlight.status}`);
    await waitFor(async () => (await a.get(`/v1/runs/${inFlight.body.runId}/status`, clientKey)).body?.state === 'running', 15_000, 'in-flight run on the RU worker');

    const ru = new release.DispatchOwnerStore({
      path: ownerStore,
      workerId: workerSpecs[0].workerId,
      onEvent: (event) => appendOwnerEvent(journalFor(workerSpecs[0]), event),
    });
    ru.drain('p30 probe: RU worker is draining before the regional switch');
    check('drain отмечен в реестре', ru.isDraining() === true);
    check('drain записан в журнал воркера с причиной', journalFor(workerSpecs[0]).byKind('drain').length === 1);

    const refusedNew = await a.post('/v1/runs', { userTaskId: 'task-new-after-drain', engine: { name: 'fake', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 30_000 } }, 'p30-after-drain', clientKey);
    check('новая задача в drain не принимается (503 WORKER_DRAINING)', refusedNew.status === 503 && refusedNew.body.error.code === 'WORKER_DRAINING', `HTTP ${refusedNew.status} ${refusedNew.body?.error?.code ?? ''}`);

    const stillRunning = (await a.get(`/v1/runs/${inFlight.body.runId}/status`, clientKey)).body;
    check('принятая до drain задача продолжает исполняться у прежнего владельца', stillRunning.state === 'running', `state ${stillRunning.state}`);

    const euAttempt = await b.post('/v1/runs', { userTaskId: 'task-new-after-drain', engine: { name: 'fake', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 30_000 } }, 'p30-after-drain-eu', clientKey);
    check('второй воркер принимает новые задачи во время drain первого', euAttempt.status === 202, `HTTP ${euAttempt.status}`);
    if (euAttempt.status === 202) await waitTerminal(b, euAttempt.body.runId, 30_000, clientKey);

    failoverRunA = inFlight.body.runId;
    record('drain_before_failover', {
      inFlight: { runId: inFlight.body.runId, stateAfterDrain: stillRunning.state },
      refusedNew: { status: refusedNew.status, code: refusedNew.body?.error?.code },
      euAccepted: euAttempt.status,
    });
    return { inFlight };
  });

  // -- 6. Управляемый сбой и failover: ровно одно исполнение (AC-173).
  await runStep('failover_no_double_execution', async () => {
    const sharedTask = 'task-failover';
    const ruOwners = new release.DispatchOwnerStore({
      path: ownerStore,
      workerId: workerSpecs[0].workerId,
      onEvent: (event) => appendOwnerEvent(journalFor(workerSpecs[0]), event),
    });
    const euOwners = new release.DispatchOwnerStore({
      path: ownerStore,
      workerId: workerSpecs[1].workerId,
      onEvent: (event) => appendOwnerEvent(journalFor(workerSpecs[1]), event),
    });
    const control = new release.DispatchOwnerStore({ path: ownerStore, workerId: 'probe-control-plane' });
    if (failoverRunA === null) throw new Error('failover step requires the drain step to run first (use the full probe, not --only)');
    const receiptA = { runId: failoverRunA };

    const doubleDispatch = await b.post('/v1/runs', { userTaskId: sharedTask, engine: { name: 'fake', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 30_000 } }, 'p30-failover-eu-1', clientKey);
    check('второй воркер не берёт задачу первого (409, владелец назван)', doubleDispatch.status === 409 && doubleDispatch.body.error.code === 'TASK_OWNED_BY_OTHER_WORKER', doubleDispatch.body?.error?.details?.ownerWorkerId ?? '');
    check('у второго воркера нет рана по чужой задаче', (await b.get(`/v1/runs/${receiptA.runId}/status`, clientKey)).status === 404);

    const noSignal = control.takeover(clientPrincipal, sharedTask, 'run-preview');
    check('молчание сети не считается failover', noSignal.outcome === 'partition_is_not_failover', noSignal.outcome);

    // Управляемый сбой: SIGKILL процесса RU-воркера с живым раном — никакой финализации.
    const killed = await a.killHard(receiptA.runId);
    check('процесс RU-воркера убит (SIGKILL, без финализации)', killed === true, a.exitInfo ? `signal ${a.exitInfo.signal ?? a.exitInfo.code}` : 'процесс не умер');

    // Воркер поднимается: recover() записывает потерю без скрытого rerun (ARCHITECTURE §9).
    a.start();
    await a.waitHealthy();
    await waitFor(async () => ['failed', 'succeeded', 'cancelled'].includes((await a.get(`/v1/runs/${receiptA.runId}/status`, clientKey)).body?.state), 20_000, 'crashed run terminal after restart');
    const crashed = (await a.get(`/v1/runs/${receiptA.runId}/result`, clientKey)).body;
    const crashEvents = (await a.get(`/v1/runs/${receiptA.runId}/events`, clientKey)).body;
    check('после рестарта ран записан потерянным, без скрытого rerun', crashed.outcome === 'failed' && crashed.failure?.code === 'WORKER_CRASH', `${crashed.outcome} / ${crashed.failure?.code}`);
    check('движок после падения не запускался повторно', crashEvents.events.filter((event) => event.type === 'started').length === 1, `started ${crashEvents.events.filter((event) => event.type === 'started').length}`);
    const recoveryLines = logLines.a.filter((line) => line.includes('"event":"recovered"')).map((line) => JSON.parse(line));
    const lostLine = recoveryLines.find((entry) => entry.lost >= 1);
    check('recovery-строка в логе RU-воркера содержит потерю рана', lostLine !== undefined, lostLine ? `lost=${lostLine.lost}, orphaned=${lostLine.orphaned}, scanned=${lostLine.scanned}` : `${recoveryLines.length} строк recovered, ни одной с lost>=1`);

    // До перехода: записи прежнего владельца исключены (его ран терминально потерян,
    // реестр ещё держит его владельцем, новый воркер не видит его записей).
    const prior = control.get(clientPrincipal, sharedTask);
    check(
      'прежний владелец ещё в реестре, его попытка не активна (drain не отдаёт принятое)',
      prior?.ownerWorkerId === workerSpecs[0].workerId && (prior.state === 'owned' || prior.state === 'draining'),
      JSON.stringify(prior),
    );
    check('новый воркер не видит записей прежнего владельца (404)', (await b.get(`/v1/runs/${receiptA.runId}/status`, clientKey)).status === 404);
    check('процесс прежнего владельца жив и не пишет по задаче', a.exitInfo === null && prior.runId === receiptA.runId, `pid alive=${a.exitInfo === null}`);

    // Явный сигнал: оператор объявляет прежнего владельца мёртвым, задача уходит в EU.
    const takeover = euOwners.takeover(clientPrincipal, sharedTask, null, { source: 'operator', reason: 'worker sandbox-a killed during the drain drill; owner declared dead' });
    check('перехват по явному сигналу разрешён', takeover.outcome === 'granted' && takeover.generation === 2, `${takeover.outcome} gen ${takeover.generation ?? ''}`);
    const fencedJournal = [...readJsonl(join(workerSpecs[0].dataDir, 'promotion.jsonl')), ...readJsonl(join(workerSpecs[1].dataDir, 'promotion.jsonl'))].filter(
      (entry) => entry.kind === 'fenced',
    );
    check('fencing записан в durable-журнал с причиной и поколением', fencedJournal.length >= 1 && fencedJournal.some((entry) => String(entry.reason).includes('fenced at generation')), `${fencedJournal.length} записей`);

    const second = await b.post('/v1/runs', { userTaskId: sharedTask, engine: { name: 'fake', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 30_000 }, input: { inlinePrompt: 'after explicit failover' } }, 'p30-failover-eu-2', clientKey);
    check('новый владелец принял задачу (202)', second.status === 202, `HTTP ${second.status}`);
    const terminal = second.status === 202 ? await waitTerminal(b, second.body.runId, 30_000, clientKey) : null;
    check('результат получен у нового владельца', terminal?.result.outcome === 'succeeded', `${terminal?.result.outcome ?? ''}`);

    // Зомби: прежний владелец вернулся и пытается дописать — третей копии не должно быть.
    ruOwners.undrain('p30 probe: worker restored after the drill, fencing must still refuse it');
    const late = await a.post('/v1/runs', { userTaskId: sharedTask, engine: { name: 'fake', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: 30_000 } }, 'p30-failover-a-late', clientKey);
    check('поздняя попытка прежнего владельца отклонена (fenced, 409)', late.status === 409 && late.body.error.code === 'TASK_OWNED_BY_OTHER_WORKER', `HTTP ${late.status} ${late.body?.error?.code ?? ''}`);
    const ruRunsAfter = readdirSync(join(workerSpecs[0].dataDir, 'runs'));
    check(
      'у прежнего владельца ровно один ран — тот, что был до сбоя (нет второго исполнения)',
      ruRunsAfter.length === 1 && ruRunsAfter[0] === receiptA.runId,
      `${ruRunsAfter.length} ранов: ${ruRunsAfter.join(', ')}`,
    );

    const registry = control.get(clientPrincipal, sharedTask);
    check('реестр: новый владелец, поколение +1, прежний указан как предыдущий', registry?.ownerWorkerId === workerSpecs[1].workerId && registry.previousOwnerWorkerId === workerSpecs[0].workerId && registry.ownerGeneration === 2, JSON.stringify(registry));
    const claimed = terminal?.events.events.filter((event) => event.type === 'claimed') ?? [];
    const sequences = terminal?.events.events.map((event) => event.sequence) ?? [];
    check('реплей нового владельца без дублей и пропусков', terminal !== null && claimed.length === 1 && sequences.every((sequence, index) => sequence === index + 1), `${sequences.length} событий, claimed ${claimed.length}`);

    // Ровно один исполнитель на задачу за весь сценарий.
    const attempts = [
      { workerId: workerSpecs[0].workerId, runId: receiptA.runId, outcome: crashed.outcome },
      { workerId: workerSpecs[1].workerId, runId: second.body?.runId, outcome: terminal?.result.outcome },
    ];
    const succeeded = attempts.filter((attempt) => attempt.outcome === 'succeeded');
    check('ровно один успешный результат на задачу (нет двойного исполнения)', succeeded.length === 1 && succeeded[0].runId === second.body?.runId, JSON.stringify(attempts));

    record('failover_no_double_execution', {
      sharedTask,
      attempts,
      crashedRun: { runId: receiptA.runId, outcome: crashed.outcome, failure: crashed.failure, eventTypes: crashEvents.events.map((event) => event.type) },
      doubleDispatch: { status: doubleDispatch.status, code: doubleDispatch.body?.error?.code, details: doubleDispatch.body?.error?.details },
      takeoverWithoutSignal: noSignal,
      priorOwnerWritesExcluded: { ownerWorkerId: prior.ownerWorkerId, runId: prior.runId, runOutcome: crashed.outcome, processAlive: a.exitInfo === null, euSeesRun: 404 },
      takeover: { workerId: registry.ownerWorkerId, runId: second.body?.runId, ownerGeneration: registry.ownerGeneration, previousOwnerWorkerId: registry.previousOwnerWorkerId },
      lateAttempt: { status: late.status, code: late.body?.error?.code },
      registry,
      newOwnerEvents: { count: sequences.length, claimed: claimed.length, sequences },
      fencedJournal: fencedJournal.map((entry) => ({ seq: entry.seq, reason: entry.reason, ownerGeneration: entry.ownerGeneration })),
      limits: [
        'volume/файловая доступность между воркерами не доказана: корни dataDir у воркеров раздельны по построению; сохранность volume и чтение workspace новым владельцем проверяются отдельно на настоящих RU/EU воркерах и в отдельной карточке',
        'два региона — это две логические зоны одной машины (VM2); сетевой partition эмулируется отсутствием сигнала в реестре (partition_is_not_failover)',
      ],
    });
  });

  // -- 7. Логи: release/config/worker/region/ownerGeneration + placement/drain/failover/fencing.
  await runStep('logs', async () => {
    const journalA = readJsonl(join(workerSpecs[0].dataDir, 'promotion.jsonl'));
    const journalB = readJsonl(join(workerSpecs[1].dataDir, 'promotion.jsonl'));
    const kinds = new Set([...journalA, ...journalB].map((entry) => entry.kind));
    check(
      'журнал содержит release/config/cohort/placement/drain/failover/fenced',
      ['release_pinned', 'cohort_configured', 'placement_refused', 'drain', 'failover', 'fenced'].every((kind) => kinds.has(kind)),
      [...kinds].join(','),
    );
    const seqs = journalA.map((entry) => entry.seq);
    check('seq в журнале монотонный и без дыр', seqs.every((sequence, index) => sequence === index + 1), seqs.join(','));
    check(
      'у каждой записи журнала есть причина и workerId',
      [...journalA, ...journalB].every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0 && typeof entry.workerId === 'string' && entry.workerId.length > 0),
      `${journalA.length + journalB.length} записей`,
    );

    const parsedA = logLines.a.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter((entry) => entry !== null);
    const parsedB = logLines.b.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter((entry) => entry !== null);
    check(
      'в логах сервиса есть releaseId/workerId/region у каждой строки (прод и песочница различимы)',
      parsedA.length > 0 && parsedB.length > 0 && [...parsedA, ...parsedB].every((entry) => entry.releaseId && entry.workerId && entry.region),
      `${parsedA.length}/${parsedB.length} строк`,
    );
    const submits = [...parsedA, ...parsedB].filter((entry) => entry.event === 'submit' && entry.outcome === 'accepted');
    check(
      'строки приёма несут userTaskId/runId/ownerGeneration и регион размещения',
      submits.length > 0 && submits.every((entry) => entry.userTaskId && entry.runId && typeof entry.ownerGeneration === 'number'),
      `${submits.length} строк приёма`,
    );
    const refusals = [...parsedA, ...parsedB].filter((entry) => entry.event === 'placement_refused');
    check('отказы placement в логах сервиса содержат причину и код', refusals.length >= 3 && refusals.every((entry) => entry.reason && entry.code), `${refusals.length} строк`);
    const ownership = [...parsedA, ...parsedB].filter((entry) => String(entry.event ?? '').startsWith('ownership_'));
    check('переходы владения (drain/failover/fenced) попали в логи сервиса', ownership.length >= 2, ownership.map((entry) => entry.event).join(','));

    record('logs', {
      journalKinds: [...kinds],
      journalSeqA: seqs,
      journalA: journalA.map((entry) => ({ seq: entry.seq, kind: entry.kind, reason: entry.reason, releaseId: entry.releaseId, workerId: entry.workerId, region: entry.region, ownerGeneration: entry.ownerGeneration })),
      serviceLogSample: [...parsedA, ...parsedB]
        .filter((entry) => ['api_listening', 'placement_admitted', 'placement_refused', 'submit', 'ownership_claimed', 'ownership_drained', 'ownership_fenced', 'ownership_failover_granted', 'recovered'].includes(entry.event))
        .slice(0, 40)
        .map((entry) => ({ ts: entry.ts, event: entry.event, releaseId: entry.releaseId, workerId: entry.workerId, region: entry.region, runId: entry.runId, userTaskId: entry.userTaskId, ownerGeneration: entry.ownerGeneration, code: entry.code, reason: entry.reason, engine: entry.engine })),
      logLineCounts: { a: parsedA.length, b: parsedB.length },
    });
  });

  // -- 8. Секреты не попали в транскрипт.
  await runStep('no_secrets', async () => {
    const serialized = JSON.stringify({ results, checks }, null, 2);
    const leaked = secrets.filter((secret) => serialized.includes(secret));
    check('значения ключей в транскрипте нет', leaked.length === 0, `${secrets.length} секретов проверено`);
    const shareSecrets = workerSpecs.map((spec) => readEnvFile(spec.envFile)['ARTIFACT_SHARE_SECRET']).filter((value) => typeof value === 'string' && value.length > 0);
    check('share-секреты в транскрипте нет', shareSecrets.every((secret) => !serialized.includes(secret)), `${shareSecrets.length} шар-секретов проверено`);
    check('в логах воркеров нет заголовков с ключом', ![...logLines.a, ...logLines.b].some((line) => line.includes('Bearer ')), `${logLines.a.length + logLines.b.length} строк`);
    record('no_secrets', { secretsChecked: secrets.length, shareSecretsChecked: shareSecrets.length });
  });

  // -- 9. Открытые решения и границы доказанного — честно, без молчаливых утверждений.
  await runStep('open_decisions', async () => {
    const residency = JSON.parse(policyJsonA).dataResidency;
    check('резидентность данных остаётся открытым решением владельца', residency.decided === false && residency.decisionRef === null, `decided=${residency.decided}`);
    check(
      'прод-VM и настоящие RU/EU воркеры не использовались (только песочница)',
      provisioning.region !== 'production' && provisioning.fleetRoot.includes(NAMESPACE),
      provisioning.fleetRoot,
    );
    record('open_decisions', {
      dataResidency: {
        status: 'не решено',
        note: 'placement отказывает с DATA_RESIDENCY_UNDECIDED и не выбирает регион хранения; утверждение политики резидентности — отдельное решение владельца с policyId/decisionRef',
        policy: residency,
      },
      existingWorkers: {
        status: 'не тронуты',
        note: 'существующие RU/EU workers (прод) не изменялись: их часть карточки P30 — после readiness, с shell-доступом к RU VM (AC-31)',
      },
      shellAccessRuVm: { status: 'нет', ac: 'AC-31', note: 'без shell-доступа к RU VM региональная приёмка на реальной машине недоказуема — блокер на стороне владельца' },
      blockers: [],
    });
  });

  const transcript = {
    schemaVersion: 1,
    probe: 'P30 — Multi-worker/region contract (карточка #69, этап I10)',
    generatedAt: new Date().toISOString(),
    namespace: NAMESPACE,
    fleetRoot: FLEET_ROOT,
    sourceCommit: provisioning.sourceCommit,
    releases: { candidate: provisioning.candidateReleaseId, previous: provisioning.previousReleaseId },
    topology:
      workerSpecs
        .map((spec, index) => `${spec.workerId} (${provisioning.regions[index]}, ${spec.releaseId}) на 127.0.0.1:${spec.port}`)
        .join(' + ') + `, общий реестр владения ${provisioning.ownerStore}`,
    fidelity:
      'настоящие процессы: API+Runner обоих воркеров, placement-политика, реестр владения, журнал переходов; эмуляция: два региона одной машины (VM2), движок fake (free-only), сетевой partition = молчание в реестре; настоящие RU/EU workers и прод не трогались',
    stepsRun: steps,
    steps: results,
    checks,
    journal: {
      a: readJsonl(join(workerSpecs[0].dataDir, 'promotion.jsonl')),
      b: readJsonl(join(workerSpecs[1].dataDir, 'promotion.jsonl')),
    },
    serviceLogLines: { a: logLines.a.length, b: logLines.b.length },
    openDecisions: results.find((entry) => entry.step === 'open_decisions') ?? null,
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
  if (a) await a.stop();
  if (b) await b.stop();
  process.stderr.write(`${JSON.stringify({ event: 'probe_failed', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined })}\n`);
  process.exit(1);
});