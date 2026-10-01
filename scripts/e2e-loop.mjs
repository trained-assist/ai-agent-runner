#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Step, buildIssueDraft, redact, sleep, summarize, validateEventChain } from './e2e-loop/checks.mjs';
import { ControlClient, request, submitRun, waitForStatus } from './e2e-loop/client.mjs';
import {
  stepArtifactDownload,
  stepCredentialScopes,
  stepEventsStreamReplay,
  stepFaultInjection,
  stepRecoveryRestart,
  stepSecurityProbes,
  stepSubmitIdempotency,
} from './e2e-loop/steps.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = dirname(SCRIPT_DIR);
const SERVER_PATH = join(SCRIPT_DIR, 'e2e-loop', 'server.mjs');

function usage() {
  return `E2E acceptance loop для ai-agent-runner (issue #2)

Использование:
  node scripts/e2e-loop.mjs [опции]
  ./scripts/e2e-loop.sh [опции]          # обёртка

Опции:
  --root <dir>            рабочий каталог данных (по умолчанию: временный)
  --report <path>         путь JSON-отчёта (по умолчанию: ./e2e-loop-report.json)
  --port <n>              фиксированный порт API (по умолчанию: случайный)
  --only <ids>            только перечисленные шаги (id через запятую)
  --skip <ids>            пропустить перечисленные шаги
  --keep-data             не удалять рабочий каталог после прогона
  --foreign-profile <p>   путь «чужого профиля» для пробы (по умолчанию: локальный фикстурный каталог)
  --sudo-policy <p>       deny (дефолт): passwordless sudo = FAIL пробы;
                          report: зафиксировать, но не валить шаг (нужно только для CI-хостов
                          вроде ubuntu-latest раннера, у которых NOPASSWD sudo штатен)
  --with-opencode         добавить прогон security-проб настоящим opencode (может вызывать модели!)
  --with-reboot           полный systemctl reboot VM (ТОЛЬКО под root, явно; шаг идёт последним)
  --reboot-resume <file>  внутренний режим продолжения после reboot (systemd unit)
  -h, --help              эта справка

Шаги: step-1-submit-idempotency, step-2-events-stream-replay, step-3-fault-injection,
      step-4-recovery-restart, step-5-security-probes, step-6-artifact,
      step-7-credential-scopes[, step-4b-reboot при --with-reboot]

Exit codes: 0 — все шаги зелёные, 1 — есть FAIL, 2 — ошибка запуска/guard.`;
}

function parseArgs(argv) {
  const opts = {
    root: null,
    report: null,
    port: null,
    only: null,
    skip: [],
    keepData: false,
    withReboot: false,
    withOpencode: false,
    sudoPolicy: 'deny',
    foreignProfile: null,
    rebootResume: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) {
        console.error(`missing value for ${arg}\n`);
        console.error(usage());
        process.exit(2);
      }
      index += 1;
      return next;
    };
    if (arg === '--root') opts.root = value();
    else if (arg === '--report') opts.report = value();
    else if (arg === '--port') opts.port = Number(value());
    else if (arg === '--only') opts.only = value().split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (arg === '--skip') opts.skip = value().split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (arg === '--keep-data') opts.keepData = true;
    else if (arg === '--with-reboot') opts.withReboot = true;
    else if (arg === '--with-opencode') opts.withOpencode = true;
    else if (arg === '--sudo-policy') {
      opts.sudoPolicy = value();
      if (opts.sudoPolicy !== 'deny' && opts.sudoPolicy !== 'report') {
        console.error('--sudo-policy: ожидалось deny|report');
        process.exit(2);
      }
    }
    else if (arg === '--foreign-profile') opts.foreignProfile = resolve(value());
    else if (arg === '--reboot-resume') opts.rebootResume = value();
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else {
      console.error(`unknown argument: ${arg}\n`);
      console.error(usage());
      process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------- dist build

function collectTsSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(join(REPO_ROOT, 'src'));
  files.push(join(SCRIPT_DIR, 'e2e-loop', 'tsconfig.build.json'));
  return files.sort();
}

function distStamp() {
  const hash = createHash('sha256');
  for (const file of collectTsSources()) {
    hash.update(file);
    hash.update(readFileSync(file));
  }
  hash.update(process.version);
  return hash.digest('hex');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureDist() {
  const dist = join(REPO_ROOT, '.e2e-dist');
  const stampPath = join(dist, '.stamp');
  const want = distStamp();
  if (existsSync(stampPath)) {
    try {
      if (readFileSync(stampPath, 'utf8') === want) return dist;
    } catch {
      // rebuild below
    }
  }
  const lock = join(REPO_ROOT, '.e2e-dist.lock');
  const deadline = Date.now() + 120000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 180000) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // retry below
      }
      if (Date.now() > deadline) throw new Error('timeout waiting for the .e2e-dist build lock');
      sleepSync(150);
    }
  }
  try {
    if (existsSync(stampPath)) {
      try {
        if (readFileSync(stampPath, 'utf8') === want) return dist;
      } catch {
        // rebuild below
      }
    }
    const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(tsc)) {
      console.error('typescript не найден в node_modules — выполните `npm ci` (нужны devDependencies, не только production).');
      process.exit(2);
    }
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    const build = spawnSync(process.execPath, [tsc, '-p', join(SCRIPT_DIR, 'e2e-loop', 'tsconfig.build.json')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (build.status !== 0) {
      console.error('сборка src/ через tsc не удалась:');
      console.error(build.stdout ?? '');
      console.error(build.stderr ?? '');
      process.exit(2);
    }
    writeFileSync(stampPath, want);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  return dist;
}

// ---------------------------------------------------------------- report

function redactDeep(value, secrets) {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactDeep(entry, secrets);
    return out;
  }
  return value;
}

function writeReportFile(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------- reboot resume

function systemctlAvailable() {
  const probe = spawnSync('systemctl', ['--version'], { encoding: 'utf8', timeout: 5000 });
  return probe.status === 0;
}

function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait) => {
    const tick = () => {
      if (existsSync(path)) return resolveWait(true);
      if (Date.now() > deadline) return resolveWait(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function rebootResume(statePath) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const reportPath = state.reportPath;
  const storeReady = await waitForFile(join(state.rootDir, 'runs', state.runId, 'state.json'), 120000);
  if (!storeReady) {
    console.error(`reboot-resume: durable store для ${state.runId} не появился за 120s`);
    process.exit(1);
  }
  const dist = ensureDist();
  const server = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      E2E_DIST: dist,
      E2E_ROOT_DIR: state.rootDir,
      E2E_PORT: String(state.port),
      E2E_CONTROL_TOKEN: state.controlToken,
      E2E_KEYS_PATH: state.keysPath,
      E2E_CREDS_PATH: state.credsPath,
      E2E_WITH_OPENCODE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let port = null;
  let stderrText = '';
  let buffer = '';
  server.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const parsed = JSON.parse(line);
        if (parsed.event === 'e2e_server_listening') port = parsed.port;
      } catch {
        // ignore non-json
      }
      index = buffer.indexOf('\n');
    }
  });
  server.stderr.on('data', (chunk) => {
    stderrText += String(chunk);
  });
  const startDeadline = Date.now() + 30000;
  while (port === null && Date.now() < startDeadline) await sleep(50);
  if (port === null) {
    console.error(`reboot-resume: сервер не поднялся; stderr=${stderrText.slice(-800)}`);
    server.kill('SIGKILL');
    process.exit(1);
  }

  const base = `http://127.0.0.1:${port}`;
  const control = new ControlClient(base, state.controlToken);
  const step = new Step('step-4b-reboot', 'Полный reboot VM: принятый запрос восстанавливается, повторный submit ≠ второй run');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const pendingIndex = report.steps.findIndex((entry) => entry.id === step.id);
  const pending = pendingIndex >= 0 ? report.steps[pendingIndex] : { checks: [], reproduction: null };
  step.checks.push(...(pending.checks ?? []));
  step.reproduction = pending.reproduction ?? `node scripts/e2e-loop.mjs --root ${state.rootDir} --with-reboot --only step-4b-reboot`;
  step.startedAt = Date.now();

  const finish = (exitCode) => {
    const entry = step.finish();
    if (pendingIndex >= 0) report.steps[pendingIndex] = entry;
    else report.steps.push(entry);
    report.summary = summarize(report.steps);
    report.summary.finalized = true;
    report.finishedAt = new Date().toISOString();
    writeReportFile(reportPath, report);
    const failedChecks = entry.checks.filter((check) => !check.ok);
    console.log(`${entry.status} ${entry.id} (${entry.durationMs}ms)`);
    for (const check of failedChecks) console.log(`  FAIL ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
    console.log('----');
    console.log(`E2E LOOP RESULT: ${report.summary.ok ? 'PASS' : 'FAIL'} ${report.summary.passed}/${report.summary.total} шагов, отчёт: ${reportPath}`);
    if (!report.summary.ok) console.log(`reproduction: ${entry.reproduction}`);
    server.kill('SIGTERM');
    setTimeout(() => process.exit(exitCode), 500).unref();
  };

  try {
    const key = state.key;
    const statusResponse = await request(base, `/v1/runs/${encodeURIComponent(state.runId)}/status`, { key });
    const status = statusResponse.json ?? {};
    step.check('status читается после reboot', statusResponse.status === 200, `HTTP ${statusResponse.status}`);
    step.check('run финализирован как failed/worker_crash (не rerun)', status.state === 'failed', `state=${status.state}`);

    const resultResponse = await request(base, `/v1/runs/${encodeURIComponent(state.runId)}/result`, { key });
    const result = resultResponse.json ?? {};
    step.check('result пережил reboot', resultResponse.status === 200, `HTTP ${resultResponse.status}`);
    step.check('exitReason=worker_crash, код WORKER_CRASH', result.exitReason === 'worker_crash' && result.failure?.code === 'WORKER_CRASH', `exitReason=${result.exitReason} code=${result.failure?.code}`);

    const eventsResponse = await request(base, `/v1/runs/${encodeURIComponent(state.runId)}/events?cursor=0&limit=1000`, { key });
    const eventsPage = eventsResponse.json ?? {};
    const chain = validateEventChain(eventsPage.events ?? [], { requireTerminal: true });
    step.check('events replay после reboot полный (claimed→…→failed)', chain.ok, chain.problems.join('; '));
    step.check('started виден после reboot (события на диске)', (eventsPage.events ?? []).some((event) => event.type === 'started'));
    step.check('claimed ровно один', (eventsPage.events ?? []).filter((event) => event.type === 'claimed').length === 1);

    const duplicate = await submitRun(base, key, state.idempotencyKey, state.body);
    step.check('повторный submit после reboot: HTTP 200', duplicate.status === 200, `HTTP ${duplicate.status}`);
    step.check('повторный submit вернул тот же runId', duplicate.json?.runId === state.runId, `${duplicate.json?.runId} vs ${state.runId}`);
    step.check('повторный submit deduplicated=true', duplicate.json?.deduplicated === true, `got ${String(duplicate.json?.deduplicated)}`);

    const health = await control.health();
    step.check('admissions не выросли (нет второго run)', health.admissions === state.preReboot.admissions, `${state.preReboot.admissions}→${health.admissions}`);
    step.check(
      'engine стартовал ровно 1 раз',
      (health.startsByEngine['fake-timeout'] ?? 0) === state.preReboot.startsFakeTimeout,
      `${state.preReboot.startsFakeTimeout} vs ${health.startsByEngine['fake-timeout']}`,
    );
    step.check('ровно одна запись этого run в store', health.runsDetail.filter((entry) => entry.runId === state.runId).length === 1);

    for (const file of ['state.json', 'events.jsonl', 'result.json']) {
      step.check(`durable store: ${file} существует после reboot`, existsSync(join(state.rootDir, 'runs', state.runId, file)));
    }
  } catch (err) {
    step.fail('reboot-resume упал с исключением', err instanceof Error ? err.message : String(err));
  }

  try {
    spawnSync('systemctl', ['disable', 'e2e-loop-resume.service'], { stdio: 'ignore', timeout: 15000 });
    rmSync('/etc/systemd/system/e2e-loop-resume.service', { force: true });
    spawnSync('systemctl', ['daemon-reload'], { stdio: 'ignore', timeout: 15000 });
  } catch {
    // unit cleanup is best-effort
  }

  finish(step.status === 'PASS' ? 0 : 1);
  await new Promise(() => {});
}

// ---------------------------------------------------------------- reboot step

async function stepRebootPre(ctx, step) {
  step.reproduction = `node scripts/e2e-loop.mjs --root ${ctx.rootDir} --with-reboot --only step-4b-reboot`;
  step.check('запуск от root (требование --with-reboot)', process.getuid === undefined || process.getuid() === 0, `uid=${process.getuid?.()}`);
  step.check('systemctl доступен', systemctlAvailable());
  if (step.status !== 'PASS') return;

  const body = {
    engine: { name: 'fake-timeout', adapterVersion: '1' },
    limits: { timeoutMs: 180000 },
    envAllowlist: [],
    input: { inlinePrompt: 'e2e step 4b: in-flight run across a full reboot' },
  };
  const submit = await submitRun(ctx.base, ctx.key, 'e2e-step-4b-reboot', body);
  step.check('run принят до reboot: HTTP 202', submit.status === 202, `HTTP ${submit.status} ${submit.text.slice(0, 160)}`);
  if (submit.status !== 202) return;
  const runId = submit.json.runId;
  const running = await waitForStatus(ctx.base, ctx.key, runId, (status) => status.state === 'running', 10000, 'run running before reboot');
  step.check('run перешёл в running до reboot', running.state === 'running', `state=${running.state}`);
  const health = await ctx.control.health();
  step.check('activeRuns ≥ 1 перед reboot', health.activeRuns >= 1, `activeRuns=${health.activeRuns}`);
  if (step.status !== 'PASS') return;

  const statePath = join(ctx.rootDir, 'reboot-state.json');
  const state = {
    statePath,
    rootDir: ctx.rootDir,
    reportPath: ctx.reportPath,
    port: ctx.port,
    controlToken: ctx.controlToken,
    keysPath: ctx.keysPath,
    credsPath: ctx.credsPath,
    key: ctx.key,
    runId,
    idempotencyKey: 'e2e-step-4b-reboot',
    body,
    preReboot: { admissions: health.admissions, startsFakeTimeout: health.startsByEngine['fake-timeout'] ?? 0 },
    node: process.execPath,
    script: SCRIPT_PATH,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  step.check('reboot-state сохранён', existsSync(statePath), statePath);

  const unitPath = '/etc/systemd/system/e2e-loop-resume.service';
  const unit = `[Unit]
Description=ai-agent-runner e2e acceptance loop reboot resume
After=network.target

[Service]
Type=oneshot
ExecStart=${process.execPath} ${SCRIPT_PATH} --reboot-resume ${statePath}
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
`;
  try {
    writeFileSync(unitPath, unit);
    step.check('systemd resume unit записан', existsSync(unitPath), unitPath);
  } catch (err) {
    step.fail('systemd resume unit записан', String(err));
    return;
  }
  const reload = spawnSync('systemctl', ['daemon-reload'], { encoding: 'utf8', timeout: 20000 });
  step.check('systemctl daemon-reload', reload.status === 0, (reload.stderr ?? '').trim());
  const enable = spawnSync('systemctl', ['enable', 'e2e-loop-resume.service'], { encoding: 'utf8', timeout: 20000 });
  step.check('systemctl enable e2e-loop-resume', enable.status === 0, (enable.stderr ?? '').trim());
  if (step.status !== 'PASS') return;

  step.check('reboot запущен: отчёт продолжит resume после загрузки', true, 'pending until reboot completes');
  ctx.persistPendingStep(step);
  ctx.writeReport();

  const reboot = spawnSync('systemctl', ['reboot'], { encoding: 'utf8', timeout: 30000 });
  if (reboot.error || reboot.status !== 0) {
    step.check('systemctl reboot', false, `status=${reboot.status} error=${reboot.error ? reboot.error.code : 'none'} stderr=${(reboot.stderr ?? '').trim()}`);
    return;
  }
  await new Promise((resolvePark) => setTimeout(resolvePark, 600000));
  step.check('машина не перезагрузилась за 600s', false, 'parked process timed out');
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  if (opts.rebootResume) {
    await rebootResume(opts.rebootResume);
    return 0;
  }
  if (opts.withReboot) {
    const uid = process.getuid?.();
    if (uid !== 0 || !systemctlAvailable()) {
      console.error('--with-reboot требует root и systemd: запускайте под root явно; в дефолтном прогоне reboot не выполняется.');
      return 2;
    }
  }

  const definitions = [
    { id: 'step-1-submit-idempotency', title: 'Submit → receipt: идемпотентный дубль = тот же run', run: stepSubmitIdempotency },
    { id: 'step-2-events-stream-replay', title: 'Events stream/replay по cursor: полнота порядка, reconnect без rerun', run: stepEventsStreamReplay },
    { id: 'step-3-fault-injection', title: 'Fault injection: nonzero/startup/timeout/crash → структурированный outcome', run: stepFaultInjection },
    { id: 'step-4-recovery-restart', title: 'Recovery после kill -9 процесса runner: durable store, без rerun', run: stepRecoveryRestart },
    { id: 'step-5-security-probes', title: 'Security-пробы изнутри рана: чужой профиль/sudo/metadata/secrets.env → deny', run: stepSecurityProbes },
    { id: 'step-6-artifact', title: 'Артефакт: агент создаёт файл, клиент забирает через API и сверяет sha256', run: stepArtifactDownload },
    { id: 'step-7-credential-scopes', title: 'Креды со скоупами: scope read не пишет, креды не в events/log/receipt/workspace', run: stepCredentialScopes },
  ];
  if (opts.withReboot) {
    definitions.push({ id: 'step-4b-reboot', title: 'Полный systemctl reboot VM (только root): durable recovery, rerun отсутствует', run: stepRebootPre });
  }

  let selected = definitions;
  if (opts.only) {
    selected = definitions.filter((definition) => opts.only.some((needle) => definition.id.includes(needle)));
    if (selected.length === 0) {
      console.error(`--only не сопоставил ни одного шага; доступны: ${definitions.map((definition) => definition.id).join(', ')}`);
      return 2;
    }
  }
  if (opts.skip.length > 0) selected = selected.filter((definition) => !opts.skip.some((needle) => definition.id.includes(needle)));

  const startedAt = new Date().toISOString();
  const rootDir = opts.root ? resolve(opts.root) : mkdtempSync(join(tmpdir(), 'ai-agent-runner-e2e-'));
  mkdirSync(rootDir, { recursive: true });
  const reportPath = resolve(opts.report ?? join(process.cwd(), 'e2e-loop-report.json'));

  const dist = ensureDist();
  const controlToken = randomBytes(24).toString('hex');
  const clientKey = `ak_${randomBytes(24).toString('hex')}`;
  const keysPath = join(rootDir, 'e2e-keys.json');
  writeFileSync(
    keysPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        principals: [
          {
            keyHash: createHash('sha256').update(clientKey, 'utf8').digest('hex'),
            principalId: 'e2e-client',
            profileId: 'profile-e2e',
            scopes: ['runs:read', 'runs:write'],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const creds = [
    { env: 'E2E_CRED_READ', scope: 'read', value: `sk-e2e-read-${randomBytes(18).toString('hex')}` },
    { env: 'E2E_CRED_WRITE', scope: 'write', value: `sk-e2e-write-${randomBytes(18).toString('hex')}` },
  ];
  const credsPath = join(rootDir, 'e2e-credentials.json');
  writeFileSync(credsPath, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });

  const fixturesDir = join(rootDir, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  const foreignCanary = `E2E-CANARY-FOREIGN-${randomBytes(12).toString('hex')}`;
  const secretsValue = `E2E_FAKE_SECRET=${randomBytes(16).toString('hex')}`;
  let foreignProfile = join(fixturesDir, 'foreign-profile');
  let foreignProfileExists = false;
  if (opts.foreignProfile) {
    foreignProfile = opts.foreignProfile;
    foreignProfileExists = existsSync(foreignProfile);
  } else {
    mkdirSync(foreignProfile, { recursive: true });
    writeFileSync(join(foreignProfile, 'profile.db'), `${foreignCanary}\n`, { mode: 0o600 });
    chmodSync(foreignProfile, 0o000);
    foreignProfileExists = true;
  }
  const secretsEnv = join(fixturesDir, 'secrets.env');
  writeFileSync(secretsEnv, `${secretsValue}\n`, { mode: 0o000 });
  const secrets = [foreignCanary, secretsValue, ...creds.map((entry) => entry.value)];

  const report = {
    schemaVersion: 1,
    tool: 'scripts/e2e-loop.mjs',
    issue: '#2',
    startedAt,
    finishedAt: null,
    env: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      rootDir,
      port: null,
      flags: [
        ...(opts.withReboot ? ['--with-reboot'] : []),
        ...(opts.withOpencode ? ['--with-opencode'] : []),
        ...(opts.keepData ? ['--keep-data'] : []),
        ...(opts.foreignProfile ? ['--foreign-profile'] : []),
        ...(opts.sudoPolicy !== 'deny' ? [`--sudo-policy ${opts.sudoPolicy}`] : []),
      ],
    },
    steps: [],
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, ok: false, finalized: false },
  };
  const saveReport = () => writeReportFile(reportPath, redactDeep(report, secrets));
  saveReport();

  const ctx = {
    opts,
    rootDir,
    reportPath,
    key: clientKey,
    controlToken,
    keysPath,
    credsPath,
    creds,
    secrets,
    fixtures: { foreignProfile, foreignProfileExists, secretsEnv, metadataUrl: 'http://169.254.169.254/latest/meta-data/' },
    base: '',
    port: null,
    control: null,
    server: null,
    logs: [],
    writeReport: saveReport,
    getServerLog() {
      return this.logs.join('\n');
    },
    persistPendingStep(step) {
      const entry = step.finish();
      entry.status = 'PENDING';
      report.steps.push(entry);
    },
    async killServer(signal = 'SIGKILL') {
      const handle = this.server;
      if (!handle) return { killed: false, detail: 'no server handle' };
      if (handle.exited) {
        this.logs.push(...handle.lines, handle.stderr);
        return { killed: false, detail: `already exited: ${JSON.stringify(handle.exited)}` };
      }
      handle.child.kill(signal);
      const deadline = Date.now() + 8000;
      while (!handle.exited && Date.now() < deadline) await sleep(25);
      this.logs.push(...handle.lines, handle.stderr);
      return {
        killed: Boolean(handle.exited),
        detail: handle.exited ? `exit=${JSON.stringify(handle.exited)}` : 'server survived the signal',
      };
    },
    async startServer(port = 0) {
      const handle = await spawnServer(port, { dist, rootDir, controlToken, keysPath, credsPath, withOpencode: opts.withOpencode });
      this.server = handle;
      const actual = await waitListened(handle);
      this.port = actual;
      this.base = `http://127.0.0.1:${actual}`;
      this.control = new ControlClient(this.base, controlToken);
      return actual;
    },
  };

  console.log('E2E acceptance loop (issue #2)');
  console.log(`  root:   ${rootDir}`);
  console.log(`  report: ${reportPath}`);
  console.log(`  steps:  ${selected.map((definition) => definition.id).join(', ')}`);

  let exitCode = 0;
  try {
    await ctx.startServer(opts.port ?? 0);
    report.env.port = ctx.port;
    saveReport();

    for (const definition of selected) {
      const step = new Step(definition.id, definition.title);
      try {
        await definition.run(ctx, step);
      } catch (err) {
        const serverTail = ctx.server?.exited
          ? ` | сервер упал: ${JSON.stringify(ctx.server.exited)} stderr=${ctx.server.stderr.slice(-600)}`
          : '';
        step.fail('шаг прерван исключением', `${err instanceof Error ? err.message : String(err)}${serverTail}`);
      }
      if (step.status === 'FAIL' && !step.reproduction) {
        step.reproduction = `node scripts/e2e-loop.mjs --root ${rootDir} --only ${definition.id}`;
      }
      const entry = step.finish();
      if (entry.status === 'FAIL') entry.issueDraft = buildIssueDraft(step);
      report.steps.push(entry);
      saveReport();

      console.log(`${entry.status} ${entry.id} (${entry.durationMs}ms)`);
      if (entry.status === 'FAIL') {
        for (const check of entry.checks.filter((item) => !item.ok)) {
          console.log(`  FAIL ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
        }
        console.log(`  reproduction: ${entry.reproduction}`);
        exitCode = 1;
      }
      if (definition.id === 'step-4b-reboot') break; // шаг паркуется до перезагрузки
    }
  } finally {
    if (ctx.server && !ctx.server.exited) {
      const stopped = await ctx.killServer('SIGTERM');
      if (!stopped.killed && ctx.server && !ctx.server.exited) {
        try {
          ctx.server.child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }

  report.summary = { ...summarize(report.steps), finalized: true };
  report.finishedAt = new Date().toISOString();
  if (report.summary.failed > 0) report.env.dataRetained = true;
  saveReport();

  console.log('----');
  console.log(`E2E LOOP RESULT: ${report.summary.ok ? 'PASS' : 'FAIL'} ${report.summary.passed}/${report.summary.total} шагов, отчёт: ${reportPath}`);
  for (const entry of report.steps.filter((item) => item.status === 'FAIL')) {
    console.log(`  issue draft: [${entry.issueDraft?.title ?? entry.id}] reproduction: ${entry.reproduction}`);
  }

  if (report.summary.failed > 0 && !opts.keepData) {
    console.log(`  данные прогона сохранены для reproduction: ${rootDir}`);
  }
  if (opts.keepData || report.summary.failed > 0) {
    console.log(`  --keep-data: каталог ${rootDir} не удалён`);
  } else {
    try {
      if (!opts.foreignProfile && existsSync(foreignProfile)) chmodSync(foreignProfile, 0o700);
      rmSync(rootDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`  не удалось удалить ${rootDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return exitCode;
}

async function spawnServer(port, options) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      E2E_DIST: options.dist,
      E2E_ROOT_DIR: options.rootDir,
      E2E_PORT: String(port),
      E2E_CONTROL_TOKEN: options.controlToken,
      E2E_KEYS_PATH: options.keysPath,
      E2E_CREDS_PATH: options.credsPath,
      E2E_WITH_OPENCODE: options.withOpencode ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const handle = { child, port: null, lines: [], stderr: '', exited: null };
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      handle.lines.push(line);
      try {
        const parsed = JSON.parse(line);
        if (parsed.event === 'e2e_server_listening') handle.port = parsed.port;
      } catch {
        // non-json line
      }
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    handle.stderr += String(chunk);
  });
  child.on('exit', (code, signal) => {
    handle.exited = { code, signal };
  });
  return handle;
}

async function waitListened(handle, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (handle.port === null && !handle.exited && Date.now() < deadline) await sleep(25);
  if (handle.port === null) {
    throw new Error(`server did not start; exited=${JSON.stringify(handle.exited)} stderr=${handle.stderr.slice(-800)}`);
  }
  return handle.port;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  // Сравниваем через realpath: на macOS /var — симmlink на /private/var,
  // argv[1] (обёртка передаёт абсолютный путь) и import.meta.url могут различаться.
  try {
    return realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH);
  } catch {
    return resolve(process.argv[1]) === resolve(SCRIPT_PATH);
  }
}

if (isDirectRun()) {
  const flushAndExit = (code) => {
    process.stdout.write('', () => {
      process.stderr.write('', () => process.exit(code));
    });
  };
  main()
    .then((code) => {
      flushAndExit(code);
    })
    .catch((err) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      flushAndExit(1);
    });
}
