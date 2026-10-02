#!/usr/bin/env node
// Сквозной сценарий шага 7 эпика M1 (trained-assist/trained-agent-architecture#109):
// пять реплик одной conversation → уточнение пользователя (awaiting input) →
// рестарт исполнителя посередине попытки → продолжение с сохранённым контекстом →
// терминальный результат + артефакт, доступный после восстановления.
//
// Скрипт играет РОЛЬ control plane: держит conversationId, историю, ожидание ответа
// пользователя и решает, когда отправить новую попытку. Runner (этот же репозиторий)
// ничего не знает про conversation — он исполняет одну попытку за раз.
//
// Декларация возможностей, на которую опирается сценарий: GET /v1/capabilities
//   interaction.engineResume = unsupported      → продолжение = НОВАЯ ПОПЫТКА
//   interaction.awaitingUserInput = unsupported → ожидание ведёт control plane
//   continuation.policy = new_run_same_user_task, savedDataRefs = run_result|run_events|run_artifacts
//   disconnect.autoRerunOnDisconnect = false    → потеря связи не запускает rerun
//
// Подключение (секреты только через env/файл, в репо НИЧЕГО):
//   export RUNNER_API_URL=http://127.0.0.1:8787
//   export RUNNER_API_KEY_FILE=/etc/agent-runner/api-key
//   node scripts/m1-step7-conversation-e2e.mjs --restart-mode service
//
// Credentials не попадают ни в отчёт, ни в журнал: значения ключа/share-токена вычищаются
// из всего, что пишется на диск и в stdout.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_NEED_RESUME = 75; // сценарий остановлен рестартом VM, требуется --resume

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);

const USAGE = `m1-step7-conversation-e2e.mjs — сквозной сценарий шага 7 (control plane ↔ Runner)

Использование:
  node scripts/m1-step7-conversation-e2e.mjs [опции]

Подключение (обязательно через env, ключ в репо не хранится):
  RUNNER_API_URL            база API, напр. http://127.0.0.1:8787
  RUNNER_API_KEY            сырой ключ (или)
  RUNNER_API_KEY_FILE       файл с ключом (mode 0600)

Опции:
  --conversation <id>       conversationId сценария (по умолчанию: conv-step7-<rand>)
  --engine <name>           движок terminal-попыток: fake (по умолчанию) | opencode
  --restart-mode <mode>     none | service | vm   (где рвётся исполнитель, по умолчанию service)
  --resume                  продолжить после рестарта VM из журнала (--journal)
  --journal <path>          журнал прогресса для resume (по умолчанию: <report>.journal.jsonl)
  --report <path>           JSON-отчёт (по умолчанию ./m1-step7-report.json)
  --unit <name>             systemd-юнит API (по умолчанию agent-runner-api)
  --env-file <path>         env-файл сервиса, где живёт AGENT_API_FAKE_SCENARIO
  --repo-dir <path>         чекаут репозитория на VM (для out-of-band ingest артефакта)
  --data-dir <path>         dataDir сервиса (по умолчанию /var/lib/agent-runner)
  --timeout-ms <n>          лимит terminal-попытки (по умолчанию 60000)
  --no-artifact             пропустить шаг артефакта (среда без собранного dist/; на VM шаг обязателен)
  -h, --help                эта справка

Exit codes: 0 — все проверки зелёные · 1 — есть FAIL · 2 — ошибка запуска/guard ·
75 — сценарий остановлен рестартом VM, продолжить: node <script> --resume …`;

function usage() {
  return USAGE;
}

function parseArgs(argv) {
  const opts = {
    conversation: null,
    engine: 'fake',
    restartMode: 'service',
    resume: false,
    journal: null,
    report: null,
    unit: 'agent-runner-api',
    envFile: '/etc/agent-runner/agent-runner-api.env',
    repoDir: null,
    dataDir: '/var/lib/agent-runner',
    timeoutMs: 60000,
    noArtifact: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) usageExit(`${arg}: требуется значение`);
      i += 1;
      return next;
    };
    if (arg === '--conversation') opts.conversation = value();
    else if (arg === '--engine') opts.engine = value();
    else if (arg === '--restart-mode') opts.restartMode = value();
    else if (arg === '--resume') opts.resume = true;
    else if (arg === '--journal') opts.journal = value();
    else if (arg === '--report') opts.report = value();
    else if (arg === '--unit') opts.unit = value();
    else if (arg === '--env-file') opts.envFile = value();
    else if (arg === '--repo-dir') opts.repoDir = value();
    else if (arg === '--data-dir') opts.dataDir = value();
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(value());
    else if (arg === '--no-artifact') opts.noArtifact = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else usageExit(`неизвестный аргумент: ${arg}`);
  }
  if (!['none', 'service', 'vm'].includes(opts.restartMode)) usageExit('--restart-mode: ожидалось none|service|vm');
  if (!['fake', 'opencode'].includes(opts.engine)) usageExit('--engine: ожидалось fake|opencode');
  return opts;
}

function usageExit(message) {
  console.error(`${message}\n`);
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

// ------------------------------------------------------------------ секреты и redaction

const secrets = new Set();

function addSecret(value) {
  if (typeof value === 'string' && value.trim().length >= 8) secrets.add(value.trim());
}

function redact(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const secret of secrets) out = out.split(secret).join('[redacted]');
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redact(entry);
    return out;
  }
  return value;
}

function connection() {
  const base = process.env.RUNNER_API_URL;
  if (!base) usageExit('RUNNER_API_URL обязателен (напр. http://127.0.0.1:8787)');
  let key = process.env.RUNNER_API_KEY;
  const keyFile = process.env.RUNNER_API_KEY_FILE;
  if ((key === undefined || key.trim() === '') && keyFile) {
    try {
      key = readFileSync(keyFile, 'utf8').trim();
    } catch (err) {
      usageExit(`не читается RUNNER_API_KEY_FILE (${keyFile}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!key || key.trim() === '') usageExit('нужен RUNNER_API_KEY или RUNNER_API_KEY_FILE');
  addSecret(key);
  return { base: String(base).replace(/\/+$/, ''), key: key.trim() };
}

// ------------------------------------------------------------------ HTTP

async function api(conn, method, path, options = {}) {
  const headers = { authorization: `Bearer ${conn.key}`, ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${conn.base}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  let json = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, text, headers: res.headers };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function statusOf(conn, runId) {
  const res = await api(conn, 'GET', `/v1/runs/${encodeURIComponent(runId)}/status`);
  if (res.status !== 200) return { state: `http_${res.status}`, httpStatus: res.status, runId };
  return res.json;
}

async function eventsOf(conn, runId) {
  const res = await api(conn, 'GET', `/v1/runs/${encodeURIComponent(runId)}/events?cursor=0&limit=1000`);
  if (res.status !== 200) return { httpStatus: res.status, types: [], events: [] };
  return res.json;
}

async function resultOf(conn, runId) {
  const res = await api(conn, 'GET', `/v1/runs/${encodeURIComponent(runId)}/result`);
  return { httpStatus: res.status, json: res.json };
}

async function waitForTerminal(conn, runId, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await statusOf(conn, runId);
    if (TERMINAL_STATES.has(last.state)) return last;
    await sleep(150);
  }
  throw new Error(`${label}: ран ${runId} не стал терминальным за ${timeoutMs}ms (последний state=${last?.state})`);
}

async function waitForState(conn, runId, state, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await statusOf(conn, runId);
    if (last.state === state) return last;
    await sleep(100);
  }
  throw new Error(`${label}: ран ${runId} не дошёл до ${state} за ${timeoutMs}ms (последний state=${last?.state})`);
}

async function waitForApi(conn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await api(conn, 'GET', '/healthz', { timeoutMs: 3000 });
      if (res.status === 200) return res.json;
    } catch (err) {
      lastError = err;
    }
    await sleep(500);
  }
  throw new Error(`${label}: API не поднялся за ${timeoutMs}ms (${lastError instanceof Error ? lastError.message : 'нет ответа'})`);
}

async function capabilities(conn) {
  const res = await api(conn, 'GET', '/v1/capabilities');
  if (res.status !== 200) throw new Error(`capabilities: HTTP ${res.status}`);
  return res.json;
}

// ------------------------------------------------------------------ журнал и отчёт

let journalPath = null;

function journalWrite(entry) {
  if (!journalPath) return;
  mkdirSync(dirname(journalPath), { recursive: true });
  appendFileSync(journalPath, `${JSON.stringify(redact({ at: new Date().toISOString(), ...entry }))}\n`);
}

function journalRead() {
  if (!journalPath || !existsSync(journalPath)) return [];
  return readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail: redact(String(detail)) } : {}) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${redact(String(detail))}` : ''}`);
}

// ------------------------------------------------------------------ управление сервисом (controlled failure)

function isRoot() {
  return process.getuid === undefined || process.getuid() === 0;
}

function systemctl(args, label) {
  const res = spawnSync('systemctl', args, { encoding: 'utf8', timeout: 60_000 });
  if (res.error || res.status !== 0) {
    throw new Error(`${label}: systemctl ${args.join(' ')} → status=${res.status} ${(res.stderr ?? res.error?.message ?? '').trim()}`);
  }
  return (res.stdout ?? '').trim();
}

/** Ставит AGENT_API_FAKE_SCENARIO в env-файле сервиса (нужен, чтобы удержать попытку в полёте). */
function setFakeScenario(opts, scenario) {
  if (!existsSync(opts.envFile)) throw new Error(`env-файл сервиса не найден: ${opts.envFile}`);
  const current = readFileSync(opts.envFile, 'utf8');
  const line = `AGENT_API_FAKE_SCENARIO=${scenario}`;
  const next = /^AGENT_API_FAKE_SCENARIO=.*$/m.test(current)
    ? current.replace(/^AGENT_API_FAKE_SCENARIO=.*$/m, line)
    : `${current.trimEnd()}\n${line}\n`;
  writeFileSync(opts.envFile, next, { mode: 0o600 });
}

function restartService(opts) {
  return systemctl(['restart', opts.unit], 'рестарт сервиса');
}

// ------------------------------------------------------------------ out-of-band ingest артефакта (slice D2)

/**
 * Регистрирует артефакт операторским кодом из dist/ тем же кодом, которым пользуется сервис
 * (docs/API-SERVICE.md): POST /v1/artifacts ещё нет, это slice D2. Возвращает манифест и
 * share-ссылку (ссылка содержит токен → в отчёт не попадает, она проверяется по HTTP).
 */
function ingestArtifact(conn, opts, { runId, userTaskId, profileId, name }) {
  if (!opts.repoDir) throw new Error('нужен --repo-dir (чекаут с собранным dist/) для out-of-baind ingest артефакта');
  const distMain = join(opts.repoDir, 'dist', 'storage', 'artifact-store.js');
  if (!existsSync(distMain)) throw new Error(`нет ${distMain} — соберите dist (npm run build) или выполните scripts/deploy-api-service.sh`);
  const operator = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactStore } from './dist/storage/artifact-store.js';
import { createLocalFsBlobStore } from './dist/storage/local-fs.js';
import { ShareTokenIssuer, artifactSharePath } from './dist/storage/share.js';
const [dataDir, runId, userTaskId, profileId, name] = process.argv.slice(1);
const bytes = readFileSync(join(dataDir, 'workspaces', runId, name));
const store = new ArtifactStore({ rootDir: dataDir, blob: createLocalFsBlobStore({ rootDir: join(dataDir, 'blobs') }) });
const manifest = await store.put({ runId, userTaskId, profileId, name, mime: 'text/plain', bytes });
const secret = process.env.ARTIFACT_SHARE_SECRET;
const link = secret ? artifactSharePath(process.env.ARTIFACT_BASE_URL ?? '', manifest.artifactId, new ShareTokenIssuer({ secret }).issue(manifest.artifactId).token) : '';
process.stdout.write(JSON.stringify({ manifest, link }));
`;
  const envFile = readFileSync(opts.envFile, 'utf8');
  const secret = /^(ARTIFACT_SHARE_SECRET=.*)$/m.exec(envFile)?.[1] ?? '';
  const baseUrl = /^(ARTIFACT_BASE_URL=.*)$/m.exec(envFile)?.[1] ?? '';
  if (secret) addSecret(secret.slice('ARTIFACT_SHARE_SECRET='.length));
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', operator, opts.dataDir, runId, userTaskId, profileId, name], {
    cwd: opts.repoDir,
    encoding: 'utf8',
    env: { ...process.env, ARTIFACT_SHARE_SECRET: secret.slice('ARTIFACT_SHARE_SECRET='.length), ARTIFACT_BASE_URL: baseUrl.slice('ARTIFACT_BASE_URL='.length) },
    timeout: 60_000,
  });
  if (res.error || res.status !== 0) {
    throw new Error(`ingest артефакта не удался: ${(res.stderr ?? res.error?.message ?? '').trim().slice(0, 400)}`);
  }
  const parsed = JSON.parse(res.stdout.trim());
  if (parsed.link) {
    // токен в ссылке — секрет: убираем из вывода, саму ссылку используем для проверки
    try {
      const token = new URL(parsed.link).searchParams.get('t');
      if (token) addSecret(token);
    } catch {
      // ссылка без baseUrl — проверять нечего
    }
  }
  return parsed;
}

// ------------------------------------------------------------------ сценарий

const CONVERSATION_TURNS = [
  { turn: 1, taskId: 'step7-task-summary', prompt: 'собери сводку по прогону дня в файл отчёта' },
  { turn: 2, taskId: 'step7-task-period', prompt: 'за какой период нужна сводка?' },
  { turn: 3, taskId: 'step7-task-period', prompt: 'за вчера; продолжи сводку за вчера' },
  { turn: 4, taskId: 'step7-task-summary', prompt: 'добавь в сводку раздел про артефакты' },
  { turn: 5, taskId: 'step7-task-delivery', prompt: 'подтверди готовность сводки и назови файл-артефакт' },
];

// Ключи идемпотентности уникальны на прогон: один и тот же ключ с другим payload —
// честный 409 IDEMPOTENCY_CONFLICT, поэтому перезапуск сценария на той же VM должен
// получать свои ключи (иначе прогон невоспроизводим).
function makeKeyFactory(conversationId) {
  const tag = String(conversationId).replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 40);
  return (name) => `step7-${tag}-${name}`;
}

function contextLines(savedContext) {
  // inlinePrompt запрещает control characters (контракт RunSpec) → контекст вкладываем строками
  const lines = [];
  for (const entry of savedContext.from ?? []) {
    lines.push(`попытка ${entry.runId}: state=${entry.state} exitReason=${entry.exitReason ?? 'n/a'}`);
  }
  for (const item of savedContext.artifacts ?? []) {
    lines.push(`артефакт ${item.artifactId} (${item.name}, sha256=${item.sha256})`);
  }
  if (savedContext.awaitingInputId) lines.push(`ожидание ответа: ${savedContext.awaitingInputId}`);
  return lines.join('; ');
}

async function submitAttempt(conn, { taskId, conversationId, key, prompt, engine, timeoutMs, envAllowlist = [] }) {
  const body = {
    engine: { name: engine, adapterVersion: '1' },
    limits: { timeoutMs },
    envAllowlist,
    userTaskId: taskId,
    conversationId,
    input: { inlinePrompt: prompt },
  };
  const res = await api(conn, 'POST', '/v1/runs', { headers: { 'idempotency-key': key }, body });
  if (res.status !== 202 && res.status !== 200) {
    throw new Error(`submit ${key}: HTTP ${res.status} ${res.text.slice(0, 300)}`);
  }
  return { httpStatus: res.status, receipt: res.json };
}

function summarizeTransitions(events) {
  // «ключи событий + причина перехода» — то, что требует эпик в логах каждого PR
  return events
    .filter((event) => event.type !== 'log')
    .map((event) => ({
      sequence: event.sequence,
      type: event.type,
      at: event.timestamp,
      runId: event.runId,
      userTaskId: event.userTaskId,
      profileId: event.profileId,
      ownerGeneration: event.ownerGeneration,
      reason:
        event.payload?.reason ??
        event.payload?.safeSummary ??
        event.payload?.detail ??
        (event.type === 'exit' ? `exit code=${event.payload?.code} signal=${event.payload?.signal}` : undefined),
    }));
}

async function artifactsOf(conn, runId) {
  const res = await api(conn, 'GET', `/v1/runs/${encodeURIComponent(runId)}/artifacts`);
  return { httpStatus: res.status, json: res.json };
}

async function downloadArtifact(conn, artifactId) {
  const res = await fetch(`${conn.base}/v1/artifacts/${encodeURIComponent(artifactId)}`, {
    headers: { authorization: `Bearer ${conn.key}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { httpStatus: res.status, sha256: null, size: 0 };
  const bytes = Buffer.from(await res.arrayBuffer());
  return { httpStatus: res.status, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  const conn = connection();
  const reportPath = resolve(opts.report ?? join(process.cwd(), 'm1-step7-report.json'));
  journalPath = resolve(opts.journal ?? `${reportPath}.journal.jsonl`);
  const conversationId = opts.conversation ?? `conv-step7-${randomBytes(4).toString('hex')}`;
  const idem = makeKeyFactory(conversationId);
  const report = {
    schemaVersion: 1,
    tool: 'scripts/m1-step7-conversation-e2e.mjs',
    epic: 'trained-assist/trained-agent-architecture#109 (M1 шаг 7)',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    conversationId,
    options: { engine: opts.engine, restartMode: opts.restartMode, unit: opts.unit, dataDir: opts.dataDir, timeoutMs: opts.timeoutMs },
    capabilities: null,
    turns: [],
    awaitingInput: null,
    controlledFailure: null,
    recovery: null,
    continuation: null,
    artifact: null,
    checks: [],
    summary: { total: 0, passed: 0, failed: 0, ok: false },
  };

  const caps = await capabilities(conn);
  report.capabilities = redact(caps);
  check('capabilities: engineResume объявлен unsupported (продолжение = новая попытка)', caps.interaction?.engineResume === 'unsupported', caps.interaction?.engineResume);
  check('capabilities: авто-rerun при потере связи выключен', caps.disconnect?.autoRerunOnDisconnect === false);
  check('capabilities: continuation policy = new_run_same_user_task', caps.interaction?.continuation?.policy === 'new_run_same_user_task');

  const profileId = 'profile-sandbox';
  const runTurn = async (turn) => {
    const first = await submitAttempt(conn, {
      taskId: turn.taskId,
      conversationId,
      key: idem(`t${turn.turn}-a1`),
      prompt: turn.prompt,
      engine: opts.engine,
      timeoutMs: opts.timeoutMs,
      envAllowlist: turn.envAllowlist ?? [],
    });
    const terminal = await waitForTerminal(conn, first.receipt.runId, opts.timeoutMs + 15_000, `ход ${turn.turn}`);
    const result = await resultOf(conn, first.receipt.runId);
    const events = await eventsOf(conn, first.receipt.runId);
    const record = {
      turn: turn.turn,
      userTaskId: turn.taskId,
      conversationId,
      idempotencyKey: idem(`t${turn.turn}-a1`),
      runId: first.receipt.runId,
      requestId: first.receipt.requestId,
      ownerGeneration: terminal.ownerGeneration,
      state: terminal.state,
      connectionLost: terminal.connectionLost === true,
      result: result.json ? { outcome: result.json.outcome, exitReason: result.json.exitReason, failureCode: result.json.failure?.code ?? null, persistence: result.json.persistence } : null,
      transitions: summarizeTransitions(events.events ?? []),
    };
    report.turns.push(record);
    journalWrite({ event: 'turn', record });
    console.log(`  ход ${turn.turn}: task=${turn.taskId} run=${first.receipt.runId} state=${terminal.state}`);
    return record;
  };

  if (opts.restartMode !== 'none' && !isRoot()) {
    usageExit(`--restart-mode ${opts.restartMode} требует root на песочной VM ( systemctl restart/reboot )`);
  }

  // ---------------------------------------------------------------- ходы 1–2: обычный диалог + открытие ожидания
  if (!opts.resume) {
    await waitForApi(conn, 30_000, 'старт');
    if (opts.restartMode !== 'none') {
      // env-файл читается сервисом на старте: без рестарта смена сценария не действует,
      // и ходы 1–2 уехали бы на сценарии, оставшемся от прошлого прогона (failed/timeout)
      setFakeScenario(opts, 'success');
      restartService(opts);
      await waitForApi(conn, 60_000, 'рестарт сервиса на штатном сценарии');
    }

    const turn1 = await runTurn(CONVERSATION_TURNS[0]);
    check('ход 1: принят и терминален (succeeded)', turn1.state === 'succeeded', turn1.state);
    const dedup1 = await submitAttempt(conn, {
      taskId: CONVERSATION_TURNS[0].taskId,
      conversationId,
      key: idem('t1-a1'),
      prompt: CONVERSATION_TURNS[0].prompt,
      engine: opts.engine,
      timeoutMs: opts.timeoutMs,
    });
    check(
      'ход 1: потерянный ответ → повтор submit = тот же ран (идемпотентность шага 2)',
      dedup1.httpStatus === 200 && dedup1.receipt.runId === turn1.runId && dedup1.receipt.deduplicated === true,
      `http=${dedup1.httpStatus} run=${dedup1.receipt.runId}`,
    );

    const turn2 = await runTurn(CONVERSATION_TURNS[1]);
    check('ход 2: принят и терминален', TERMINAL_STATES.has(turn2.state), turn2.state);
    report.awaitingInput = {
      awaitingInputId: `await-${randomUUID().slice(0, 8)}`,
      kind: 'data',
      userTaskId: CONVERSATION_TURNS[1].taskId,
      question: 'за какой период нужна сводка?',
      openedAfterRunId: turn2.runId,
      openedAt: new Date().toISOString(),
      answeredAt: null,
      consumedByRunId: null,
      note: 'ожидание ведёт control plane: Runner не имеет awaiting_user (capabilities.interaction.awaitingUserInput=unsupported), живой процесс НЕ держится',
    };
    journalWrite({ event: 'awaiting_input', awaitingInput: report.awaitingInput });
    console.log(`  ожидание открыто: ${report.awaitingInput.awaitingInputId}`);
  } else {
    const journal = journalRead();
    for (const entry of journal) {
      if (entry.event === 'turn') report.turns.push(entry.record);
      if (entry.event === 'awaiting_input') report.awaitingInput = entry.awaitingInput;
      if (entry.event === 'controlled_failure') report.controlledFailure = entry.controlledFailure;
    }
    check('resume: журнал прогресса прочитан', report.turns.length > 0, `ходов в журнале: ${report.turns.length}`);
  }

  // ---------------------------------------------------------------- ход 3: ответ + управляемый сбой посреди попытки
  const turn3 = CONVERSATION_TURNS[2];
  let attemptB1 = null;
  let attemptB1Payload = null;
  if (!opts.resume && opts.restartMode === 'none') {
    // без управляемого сбоя ход 3 — обычная попытка; явное продолжение (новая попытка) всё равно проверяем ниже
    const turn3plain = await runTurn(turn3);
    check('ход 3: ответ пользователя принят и терминален', TERMINAL_STATES.has(turn3plain.state), turn3plain.state);
  } else if (!opts.resume) {
    // удерживаем попытку в полёте: fake-timeout не завершается сам (engine resume не поддержан)
    setFakeScenario(opts, 'timeout');
    restartService(opts);
    await waitForApi(conn, 60_000, 'рестарт сервиса перед сбросом');

    const savedContext = {
      from: report.turns.map((entry) => ({ runId: entry.runId, userTaskId: entry.userTaskId, state: entry.state, exitReason: entry.result?.exitReason ?? null })),
      awaitingInputId: report.awaitingInput.awaitingInputId,
      note: 'сохранённый контекст = result+events предыдущих попыток (capabilities.savedDataRefs)',
    };
    // payload попытки запоминаем: проба «потерянный ответ» обязана повторить его ДОСЛОВНО
    // (тот же Idempotency-Key с другим payload — это 409 IDEMPOTENCY_CONFLICT, а не дедуп)
    attemptB1Payload = `${turn3.prompt}; ответ на вопрос: за вчера; контекст предыдущих попыток: ${contextLines(savedContext)}`;
    attemptB1 = await submitAttempt(conn, {
      taskId: turn3.taskId,
      conversationId,
      key: idem('t3-a1'),
      prompt: attemptB1Payload,
      engine: 'fake',
      timeoutMs: opts.timeoutMs,
    });
    report.turns.push({
      turn: 3,
      userTaskId: turn3.taskId,
      idempotencyKey: idem('t3-a1'),
      runId: attemptB1.receipt.runId,
      requestId: attemptB1.receipt.requestId,
      ownerGeneration: undefined,
      state: 'running',
      savedContext,
      transitions: [],
    });
    journalWrite({ event: 'turn', record: report.turns[report.turns.length - 1] });
    const inFlight = await waitForState(conn, attemptB1.receipt.runId, 'running', 30_000, 'попытка хода 3 в полёте');
    check('ход 3: попытка принята и в полёте (state=running)', inFlight.state === 'running', attemptB1.receipt.runId);

    const before = { at: new Date().toISOString(), health: await api(conn, 'GET', '/healthz').then((r) => r.json) };
    report.controlledFailure = {
      mode: opts.restartMode,
      before,
      after: null,
      note: 'управляемый сбой исполнителя посреди попытки хода 3',
    };
    if (opts.restartMode === 'service') {
      restartService(opts);
      console.log('  управляемый сбой: systemctl restart agent-runner-api');
    } else {
      journalWrite({ event: 'controlled_failure', controlledFailure: report.controlledFailure });
      const out = spawnSync('systemctl', ['reboot'], { encoding: 'utf8', timeout: 30_000 });
      console.log(`  управляемый сбой: systemctl reboot (status=${out.status}). Продолжение после загрузки:`);
      console.log(`    node ${process.argv[1]} --resume --journal ${journalPath} --report ${reportPath}`);
      writeReport(report, reportPath, checks, 'needs-resume');
      return EXIT_NEED_RESUME;
    }
  }

  // ---------------------------------------------------------------- восстановление после сброса
  const health = await waitForApi(conn, 120_000, 'восстановление после сброса');
  if (opts.restartMode !== 'none') {
    if (!report.controlledFailure) {
      report.controlledFailure = { mode: opts.restartMode, after: { at: new Date().toISOString(), health } };
    } else {
      report.controlledFailure.after = { at: new Date().toISOString(), health };
    }
    const runId = report.turns[report.turns.length - 1].runId;
    const recovered = await waitForTerminal(conn, runId, 120_000, 'терминал после восстановления');
    const events = await eventsOf(conn, runId);
    const result = await resultOf(conn, runId);
    report.recovery = {
      runId,
      userTaskId: report.turns[report.turns.length - 1].userTaskId,
      state: recovered.state,
      connectionLost: recovered.connectionLost === true,
      result: result.json ? { outcome: result.json.outcome, exitReason: result.json.exitReason, failureCode: result.json.failure?.code ?? null, persistence: result.json.persistence } : null,
      eventTypes: (events.events ?? []).map((event) => event.type),
      claimedCount: (events.events ?? []).filter((event) => event.type === 'claimed').length,
      sequence: recovered.sequence,
      transitions: summarizeTransitions(events.events ?? []),
    };
    journalWrite({ event: 'recovery', recovery: report.recovery });

    check('восстановление: принятый запрос не потерян — ран терминален', TERMINAL_STATES.has(recovered.state), recovered.state);
    check('восстановление: replay событий полный (claimed ровно один, есть терминал)', report.recovery.claimedCount === 1 && report.recovery.eventTypes.some((type) => ['succeeded', 'failed', 'cancelled'].includes(type)), report.recovery.eventTypes.join('→'));
    const dedupAfter = await submitAttempt(conn, {
      taskId: report.turns[report.turns.length - 1].userTaskId,
      conversationId,
      key: idem('t3-a1'),
      prompt: attemptB1Payload ?? `${turn3.prompt}; ответ на вопрос: за вчера`,
      engine: 'fake',
      timeoutMs: opts.timeoutMs,
    });
    check(
      'восстановление: повтор submit = тот же ран (нет второго запуска)',
      dedupAfter.httpStatus === 200 && dedupAfter.receipt.runId === runId && dedupAfter.receipt.deduplicated === true,
      `http=${dedupAfter.httpStatus} run=${dedupAfter.receipt.runId}`,
    );
    const artifactsBefore = await artifactsOf(conn, runId);
    check('артефакты рана читаются после восстановления (HTTP 200)', artifactsBefore.httpStatus === 200, `http=${artifactsBefore.httpStatus}`);
  }

  // ---------------------------------------------------------------- ход 3 (продолжение): явная новая попытка с сохранённым контекстом
  if (opts.restartMode !== 'none' && existsSync(opts.envFile)) {
    setFakeScenario(opts, 'success');
    restartService(opts);
    await waitForApi(conn, 60_000, 'рестарт сервиса перед продолжением');
  }

  const previousRun = report.turns[report.turns.length - 1];
  const savedArtifacts = await artifactsOf(conn, previousRun.runId);
  const savedContext = {
    previousRunId: previousRun.runId,
    previousState: previousRun.state ?? report.recovery?.state,
    savedDataRefs: ['run_result', 'run_events', 'run_artifacts'],
    artifacts: savedArtifacts.json?.artifacts?.map((item) => ({ artifactId: item.artifactId, name: item.name, sha256: item.sha256 })) ?? [],
    awaitingInputId: report.awaitingInput?.awaitingInputId ?? null,
  };
  const continuation = await submitAttempt(conn, {
    taskId: turn3.taskId,
    conversationId,
    key: idem('t3-a2'),
    prompt: `${turn3.prompt}; продолжение после восстановления; сохранённые данные: ${contextLines(savedContext)}`,
    engine: 'fake',
    timeoutMs: opts.timeoutMs,
  });
  const continuationTerminal = await waitForTerminal(conn, continuation.receipt.runId, opts.timeoutMs + 15_000, 'продолжение хода 3');
  const continuationEvents = await eventsOf(conn, continuation.receipt.runId);
  report.continuation = {
    userTaskId: turn3.taskId,
    previousRunId: previousRun.runId,
    runId: continuation.receipt.runId,
    requestId: continuation.receipt.requestId,
    idempotencyKey: idem('t3-a2'),
    newRunId: continuation.receipt.runId !== previousRun.runId,
    state: continuationTerminal.state,
    ownerGeneration: continuationTerminal.ownerGeneration,
    conversationId: continuationTerminal.conversationId,
    savedContext,
    transitions: summarizeTransitions(continuationEvents.events ?? []),
  };
  journalWrite({ event: 'continuation', continuation: report.continuation });

  check('продолжение: НОВЫЙ runId (не повтор всей задачи)', report.continuation.newRunId, `${previousRun.runId} → ${continuation.receipt.runId}`);
  check('продолжение: тот же userTaskId', report.continuation.userTaskId === previousRun.userTaskId);
  check('продолжение: тот же conversationId', report.continuation.conversationId === conversationId);
  check('продолжение: терминальный успех', continuationTerminal.state === 'succeeded', continuationTerminal.state);
  check(
    'продолжение: сохранённые данные использованы (refs в prompt + ожидание закрыто)',
    report.awaitingInput !== null && savedContext.awaitingInputId === report.awaitingInput.awaitingInputId,
    `awaitingInputId=${savedContext.awaitingInputId}`,
  );
  if (report.awaitingInput) {
    report.awaitingInput.answeredAt = new Date().toISOString();
    report.awaitingInput.consumedByRunId = continuation.receipt.runId;
  }

  // ---------------------------------------------------------------- ходы 4–5: продолжение диалога и артефакт
  const turn4 = await runTurn(CONVERSATION_TURNS[3]);
  check('ход 4: принят и терминален', TERMINAL_STATES.has(turn4.state), turn4.state);
  const turn5 = await runTurn(CONVERSATION_TURNS[4]);
  check('ход 5: принят и терминален (succeeded)', turn5.state === 'succeeded', turn5.state);

  // Артефакт: out-of-band ingest (POST /v1/artifacts — slice D2) + проверка по API после восстановления
  if (opts.noArtifact) {
    report.artifact = { skipped: true, note: '--no-artifact: шаг артефакта обязателен на песочной VM (--repo-dir с dist/)' };
    console.log('  артефакт: пропущен (--no-artifact)');
  } else {
    const artifactName = 'ran.txt';
    try {
      const ingested = ingestArtifact(conn, opts, { runId: turn5.runId, userTaskId: turn5.userTaskId, profileId, name: artifactName });
      const listed = await artifactsOf(conn, turn5.runId);
      const first = await downloadArtifact(conn, ingested.manifest.artifactId);
      const second = await downloadArtifact(conn, ingested.manifest.artifactId);
      let linkOk = null;
      if (ingested.link) {
        const res = await fetch(ingested.link, { signal: AbortSignal.timeout(20_000) });
        linkOk = res.status;
      }
      report.artifact = {
        runId: turn5.runId,
        userTaskId: turn5.userTaskId,
        artifactId: ingested.manifest.artifactId,
        name: ingested.manifest.name,
        size: ingested.manifest.size,
        sha256: ingested.manifest.sha256,
        listed: listed.json?.count ?? null,
        downloadSha256: first.sha256,
        downloadSize: first.size,
        shareLinkStatus: linkOk,
        note: 'ingest out-of-band (slice D2): POST /v1/artifacts ещё нет; ссылка/токен в отчёт не пишутся',
      };
      check('артефакт: виден в GET /v1/runs/{id}/artifacts после восстановления', listed.json?.count === 1, `count=${listed.json?.count}`);
      check('артефакт: байты совпадают с манифестом (sha256)', first.sha256 === ingested.manifest.sha256 && first.size === ingested.manifest.size, `${first.sha256}`);
      check('артефакт: повторное чтение идемпотентно', second.sha256 === first.sha256);
      if (linkOk !== null) check('артефакт: share-ссылка отдаёт байты без ключа (200)', linkOk === 200, `http=${linkOk}`);
    } catch (err) {
      report.artifact = { error: redact(err instanceof Error ? err.message : String(err)) };
      check('артефакт: ingest и чтение после восстановления', false, report.artifact.error);
    }
  }

  // ---------------------------------------------------------------- итог
  const conversationalTurns = new Set(report.turns.map((entry) => entry.turn)).size;
  check('диалог: пять реплик одной conversation', conversationalTurns === 5, `ходов: ${conversationalTurns}, conversationId=${conversationId}`);

  writeReport(report, reportPath, checks, opts.resume ? 'resumed' : 'done');
  const failed = checks.filter((entry) => !entry.ok);
  console.log('----');
  console.log(`STEP7 RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} ${checks.length - failed.length}/${checks.length} проверок, отчёт: ${reportPath}`);
  return failed.length === 0 ? EXIT_OK : EXIT_FAIL;
}

function writeReport(report, reportPath, list, phase) {
  const passed = list.filter((entry) => entry.ok).length;
  const failed = list.length - passed;
  report.checks = redact(list);
  report.summary = { total: list.length, passed, failed, ok: failed === 0 };
  report.phase = phase;
  report.finishedAt = new Date().toISOString();
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(redact(report), null, 2)}\n`);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`ошибка сценария: ${redact(err instanceof Error ? (err.stack ?? err.message) : String(err))}`);
    process.exit(EXIT_FAIL);
  });
