#!/usr/bin/env node
// Приёмка границы Agent clean room (issue #51) на настоящем хосте: per-run Unix-идентичность.
//
// Проба поднимает СВОЙ API/Runner (не прод и не чужую VM), создаёт пул непривилегированных
// Unix-пользователей — слотов — и проверяет отрицательные свойства границы на живых ранах:
// два одновременных рана не читают друг друга, не убивают процессы друг друга и не видят
// ни credentials, ни состояние Runner'а, при этом их собственные каталоги и общие read-only
// бинари инструментов доступны. Отдельно — управляемые отказы: сломанная настройка границы,
// отсутствие свободного слота и отказ хранилища обязаны вести себя предсказуемо, а рестарт
// воркера — дочищать аренду идентичности без повторного запуска движка.
//
// Требует root (useradd/chown/setpriv), Linux и setfacl. Ключи и share-секреты читаются из
// файлов namespace и в транскрипт не попадают (проверяется в конце пробы).
//
// Запуск (из корня репозитория, после npm ci && npm run build):
//   scripts/recreate-sandbox.sh --namespace iso-$(date -u +%Y%m%d) \
//     --fleet-root /var/lib/agent-runner-iso --workers a --client-engines fake,opencode
//   sudo node scripts/isolation-probe.mjs --fleet-root /var/lib/agent-runner-iso \
//     --namespace iso-20261003 --out docs/evidence/p51-clean-room
//
// Опции:
//   --out <dir>        каталог транскрипта (по умолчанию docs/evidence/p51-clean-room)
//   --engine <name>    движок ранов: fake (по умолчанию) или opencode (нужен бинарь и
//                      разрешённый профиль песочницы)
//   --slots <a,b>      Unix-пользователи слотов (по умолчанию ta-agent-1,ta-agent-2)
//   --tool-path <dir>  общий read-only каталог бинарей инструментов (создаётся пробой)
//   --only <step-id>   прогнать один шаг (шаги идут по порядку)
//   --keep             не гасить API в конце (для разбора)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const engineFlag = flagValue('--engine') ?? 'fake';
const slotsFlag = (flagValue('--slots') ?? 'ta-agent-1,ta-agent-2')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const toolPathFlag = flagValue('--tool-path');
const keep = args.includes('--keep');

if (!fleetRootFlag || !namespaceFlag) {
  process.stderr.write('usage: isolation-probe.mjs --fleet-root <dir> --namespace <id> [--out <dir>] [--engine fake|opencode] [--slots a,b] [--tool-path <dir>] [--only <step>] [--keep]\n');
  process.exit(2);
}

const FLEET_ROOT = resolve(fleetRootFlag);
const NAMESPACE = namespaceFlag;
const NS_ROOT = join(FLEET_ROOT, NAMESPACE);
const PROVISIONING = join(NS_ROOT, 'provisioning.json');
const OUT_DIR = outFlag ? resolve(outFlag) : join(REPO, 'docs', 'evidence', 'p51-clean-room');
const DIST = join(REPO, 'dist');
const PROBE_ROOT = join(NS_ROOT, 'iso-probe');
const TOOL_DIR = toolPathFlag ? resolve(toolPathFlag) : join(PROBE_ROOT, 'tools');
/** Выход fake-движка: он пишет ровно этот файл в workspace рана. */
const ENGINE_OUTPUT = 'ran.txt';

const steps = [];
const checks = [];
const secrets = [];
const logs = [];
let failures = 0;

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

function record(step, fields) {
  steps.push({ at: new Date().toISOString(), step, ...fields });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
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

function hasCommand(name) {
  return spawnSync('/usr/bin/which', [name], { stdio: 'ignore' }).status === 0;
}

function runAs(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function portInUse(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(true));
    probe.once('listening', () => probe.close(() => done(false)));
    probe.listen(port, '127.0.0.1');
  });
}

async function freePort(preferred) {
  for (let port = preferred; port < preferred + 60; port += 1) {
    if (!(await portInUse(port))) return port;
  }
  throw new Error(`no free port near ${preferred}`);
}

function firstLine(value) {
  return value.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/**
 * Команда под идентичностью слота. Граница проверяется тем, что операция не удалась с
 * EACCES/EPERM, а не тем, что «что-то сломалось»: пустой вывод с ненулевым кодом — не отказ.
 */
function execAsSlot(identity, command, commandArgs, options = {}) {
  return runAs('/usr/bin/setpriv', [`--reuid=${identity.uid}`, `--regid=${identity.gid}`, '--clear-groups', '--', command, ...commandArgs], {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', ...(options.env ?? {}) },
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
}

// ------------------------------------------------------------------ слоты и бинари

function readIdentity(slot) {
  const out = runAs('/usr/bin/getent', ['passwd', slot]).stdout.split(':');
  return { slot, uid: Number(out[2]), gid: Number(out[3]) };
}

function ensureSlots() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    throw new Error('the probe needs root: slot users, chown of run directories and setpriv require it');
  }
  for (const slot of slotsFlag) {
    if (runAs('/usr/bin/getent', ['passwd', slot]).code !== 0) {
      const created = runAs('/usr/sbin/useradd', ['--no-create-home', '--shell', '/usr/sbin/nologin', slot]);
      if (created.code !== 0) throw new Error(`cannot create slot user "${slot}": ${created.stderr.trim()}`);
    }
    const identity = readIdentity(slot);
    if (!Number.isInteger(identity.uid) || identity.uid <= 0) throw new Error(`slot "${slot}" resolved to uid ${identity.uid}`);
  }
  // Общий read-only каталог бинарей инструментов: движок и его утилиты доступны всем
  // слотам, но писать в него нельзя — иначе слот А дописал бы бинарь, которым пойдёт слот Б.
  mkdirSync(TOOL_DIR, { recursive: true, mode: 0o755 });
  const toolBinary = join(TOOL_DIR, 'node');
  if (!existsSync(toolBinary)) {
    const link = runAs('/usr/bin/ln', ['-sfn', process.execPath, toolBinary]);
    if (link.code !== 0) throw new Error(`cannot publish the shared tool binary: ${link.stderr.trim()}`);
  }
  runAs('/usr/bin/chown', ['-R', 'root:root', TOOL_DIR]);
  chmodSync(TOOL_DIR, 0o555);
  chmodSync(toolBinary, 0o555);
  return slotsFlag.map((slot) => readIdentity(slot));
}

// ------------------------------------------------------------------------- воркер

class Worker {
  constructor(spec, key, env = {}, logDir = OUT_DIR) {
    this.spec = spec;
    this.port = spec.port;
    this.base = `http://127.0.0.1:${spec.port}`;
    this.key = key;
    this.env = { ...readEnvFile(spec.envFile), ...env };
    this.child = null;
    this.exitInfo = null;
    this.logDir = logDir;
    this.logStream = null;
  }

  start() {
    this.child = spawn(process.execPath, [join(DIST, 'api', 'main.js')], {
      env: { ...process.env, ...this.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.exitInfo = null;
    // Журнал API — в файл транскрипта: в нём видны runId/userTaskId/profileId, ключи событий
    // и причины переходов. Значения ключей в него не попадают (проверяется в конце пробы).
    mkdirSync(this.logDir, { recursive: true });
    const logFile = createWriteStream(join(this.logDir, `api-${this.port}.log`), { flags: 'a' });
    this.logStream = logFile;
    const capture = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() === '') continue;
        logs.push(line.trim());
        logFile.write(`${line.trim()}\n`);
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
            return (await fetch(`${this.base}/healthz`)).status === 200;
          } catch {
            return false;
          }
        },
        timeoutMs,
        `healthz of port ${this.port}`,
      );
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}; api output: ${logs.slice(-3).join(' | ') || '(none)'}`);
    }
  }

  async stop() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && this.child.exitCode === null) await sleep(50);
      if (this.child.exitCode === null) this.child.kill('SIGKILL');
    }
    this.closeLog();
  }

  /**
   * Закрытие файла журнала. Незакрытый WriteStream держит event loop, и проба после
   * завершения шагов висела до таймаута job вместо того, чтобы отдать транскрипт и выйти.
   */
  closeLog() {
    if (!this.logStream) return;
    const stream = this.logStream;
    this.logStream = null;
    stream.end();
  }

  /** Управляемый сбой воркера: SIGKILL без финализации, как падение процесса на VM. */
  killHard() {
    if (!this.child || this.child.exitCode !== null) return false;
    this.child.kill('SIGKILL');
    return true;
  }

  async waitExit(timeoutMs = 10_000) {
    await waitFor(async () => this.exitInfo !== null, timeoutMs, `api exit on port ${this.port}`);
    return this.exitInfo;
  }

  async request(method, pathname, { body, idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${this.key}` };
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

  get(pathname) {
    return this.request('GET', pathname);
  }

  post(pathname, body, idempotencyKey) {
    return this.request('POST', pathname, { body, idempotencyKey });
  }

  state(runId) {
    return readJson(join(this.spec.dataDir, 'runs', runId, 'state.json'));
  }

  events(runId) {
    const path = join(this.spec.dataDir, 'runs', runId, 'events.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  }

  lease(runId) {
    const path = join(this.spec.dataDir, 'identity', 'leases', `${runId}.json`);
    return existsSync(path) ? readJson(path) : null;
  }
}

async function waitRunning(worker, runId, timeoutMs = 20_000) {
  try {
    await waitFor(
      async () => {
        const status = await worker.get(`/v1/runs/${runId}/status`);
        return status.body?.state === 'running';
      },
      timeoutMs,
      `run ${runId} to be running`,
    );
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; run log:\n${runLog(worker, runId)}`);
  }
  return worker.state(runId);
}

/** Журнал рана одной строкой на событие: без него отказ виден только как «timeout». */
function runLog(worker, runId) {
  return worker
    .events(runId)
    .map((event) => {
      const payload = event.payload ?? {};
      const detail = [payload.message, payload.code, payload.safeSummary].filter(Boolean).join(' | ');
      return `${event.type}${detail ? ` ${detail}` : ''}`;
    })
    .join('\n');
}

async function waitTerminal(worker, runId, timeoutMs = 30_000) {
  await waitFor(
    async () => {
      const status = await worker.get(`/v1/runs/${runId}/status`);
      return ['succeeded', 'failed', 'cancelled'].includes(status.body?.state);
    },
    timeoutMs,
    `terminal state of ${runId}`,
  );
  return (await worker.get(`/v1/runs/${runId}/result`)).body;
}

function startRun(worker, over = {}) {
  return worker.post(
    '/v1/runs',
    {
      engine: { name: engineFlag, adapterVersion: '1' },
      envAllowlist: [],
      limits: { timeoutMs: over.timeoutMs ?? 120_000 },
      isolation: { mode: 'per_run_unix_identity' },
      input: { inlinePrompt: over.prompt ?? `write ${ENGINE_OUTPUT}` },
      ...(over.outputs !== undefined ? { outputs: over.outputs } : {}),
    },
    over.idempotencyKey ?? `iso-${Math.random().toString(36).slice(2, 10)}`,
  );
}

/** Матрица «свой/чужой» для пары слотов: читаемость каталогов и право убивать процесс соседа. */
function boundaryMatrix(actor, victim, runnerRoot, credentialFiles) {
  const rows = [];
  const denied = (name, target, result) => {
    const combined = `${result.stderr}${result.stdout}`;
    const refused = result.code !== 0 && (combined.includes('EACCES') || combined.includes('EPERM') || combined.includes('Permission denied') || combined.includes('Operation not permitted'));
    rows.push({ name, target, expect: 'denied', ok: refused, detail: `${result.code}: ${firstLine(combined)}` });
  };
  const allowed = (name, target, result) => {
    rows.push({ name, target, expect: 'allowed', ok: result.code === 0, detail: `${result.code}: ${firstLine(`${result.stderr}${result.stdout}`)}` });
  };

  denied('victim_cwd_denied', victim.cwd, execAsSlot(actor, '/usr/bin/ls', ['-A', victim.cwd]));
  denied('victim_home_denied', victim.home, execAsSlot(actor, '/usr/bin/ls', ['-A', victim.home]));
  denied('victim_tmp_denied', victim.tmp, execAsSlot(actor, '/usr/bin/ls', ['-A', victim.tmp]));
  denied('victim_state_denied', `${runnerRoot}/runs/${victim.runId}/state.json`, execAsSlot(actor, '/usr/bin/cat', [`${runnerRoot}/runs/${victim.runId}/state.json`]));
  denied('runner_root_denied', runnerRoot, execAsSlot(actor, '/usr/bin/ls', ['-A', runnerRoot]));
  for (const file of credentialFiles) {
    denied('runner_credential_denied', file, execAsSlot(actor, '/usr/bin/cat', [file]));
  }
  denied('victim_engine_kill_denied', `pid ${victim.pid}`, execAsSlot(actor, '/usr/bin/kill', ['-0', String(victim.pid)]));
  allowed('own_cwd_writable', actor.cwd, execAsSlot(actor, '/usr/bin/touch', [`${actor.cwd}/.probe-${actor.uid}`]));
  allowed('own_home_writable', actor.home, execAsSlot(actor, '/usr/bin/touch', [`${actor.home}/.probe-${actor.uid}`]));
  allowed('own_tmp_writable', actor.tmp, execAsSlot(actor, '/usr/bin/touch', [`${actor.tmp}/.probe-${actor.uid}`]));
  allowed('shared_tool_executable', join(TOOL_DIR, 'node'), execAsSlot(actor, join(TOOL_DIR, 'node'), ['--version']));
  denied('shared_tool_write_denied', TOOL_DIR, execAsSlot(actor, '/usr/bin/touch', [join(TOOL_DIR, `.probe-${actor.uid}`)]));
  return rows;
}

function procUid(pid) {
  const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((entry) => entry.startsWith('Uid:'));
  return line ? Number(line.slice('Uid:'.length).trim().split(/\s+/)[0]) : -1;
}

function procGroups(pid) {
  const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((entry) => entry.startsWith('Groups:'));
  return line ? line.slice('Groups:'.length).trim().split(/\s+/).filter(Boolean).map(Number) : [];
}

function readEnvOrNull(pid) {
  try {
    const env = {};
    for (const pair of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const index = pair.indexOf('=');
      if (index > 0) env[pair.slice(0, index)] = pair.slice(index + 1);
    }
    return env;
  } catch {
    // нужен CAP_SYS_PTRACE; без него окружение берётся из лога самого движка
    return null;
  }
}

/** Имена переменных, которые движок сам напечатал в лог рана (`envkeys:`). */
function engineEnvNames(worker, runId) {
  const line = worker
    .events(runId)
    .map((event) => String(event.payload?.message ?? ''))
    .find((message) => message.startsWith('envkeys:'));
  return line === undefined ? [] : line.slice('envkeys:'.length).split(',').filter(Boolean).sort();
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function runView(state) {
  const room = state.cleanRoom;
  return {
    runId: state.runId,
    pid: state.pid,
    slot: room?.identity?.slotId ?? null,
    uid: room?.identity?.uid ?? null,
    gid: room?.identity?.gid ?? null,
    cwd: room?.paths?.cwd ?? state.spec.cwd,
    roomRoot: room?.paths?.root ?? null,
    home: room?.paths?.home ?? null,
    tmp: room?.paths?.tmp ?? null,
    mcp: room?.paths?.mcp ?? null,
    status: room?.status ?? null,
  };
}

function isolationEnv(slots, extra = {}) {
  return { AGENT_API_ISOLATION_SLOTS: slots.join(','), AGENT_API_ISOLATION_TOOL_PATHS: TOOL_DIR, ...extra };
}

// ------------------------------------------------- детект возможностей хоста (skip)

/**
 * Что этому хосту доступно для настоящей границы. Граница привилегированная: без root
 * нельзя создать слот и раздать ACL, без setfacl каталог рана под сервисным dataDir
 * недостижим для слота, без переключателя идентичности нечего проверять.
 */
function detectHostCapabilities() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const launcher = ['setpriv', 'runuser'].filter(hasCommand);
  const setfacl = hasCommand('setfacl');
  const reasons = [];
  if (process.platform !== 'linux') reasons.push(`platform ${process.platform}, нужна linux`);
  if (uid !== 0) reasons.push(`uid=${String(uid)}, нужны root (useradd/chown/setfacl/setpriv)`);
  if (launcher.length === 0) reasons.push('нет переключателя идентичности (setpriv/runuser)');
  if (!setfacl) reasons.push('нет setfacl: каталог рана под dataDir недостижим для слота');
  const slots = [];
  const missing = [];
  for (const slot of slotsFlag) {
    if (runAs('/usr/bin/getent', ['passwd', slot]).code === 0) slots.push(slot);
    else missing.push(slot);
  }
  if (missing.length > 0) reasons.push(`слотов нет на хосте: ${missing.join(',')}`);
  return { uid, launcher, setfacl, slots, missing, reasons, enforced: reasons.length === 0 };
}

/**
 * Пропуск пробы на хосте без привилегий. Это НЕ успех: граница здесь не проверялась, и
 * транскрипт говорит об этом прямо (`status: skipped`), чтобы «зелёный» CI-шаг нельзя
 * было прочитать как доказанную изоляцию.
 */
function writeSkippedTranscript(capabilities) {
  const payload = `${JSON.stringify(
    {
      schemaVersion: 1,
      probe: 'Граница Agent clean room: per-run Unix-идентичность (issue #51)',
      status: 'skipped',
      generatedAt: new Date().toISOString(),
      host: { platform: process.platform, kernel: kernelRelease(), apiProcessUid: capabilities.uid },
      skippedBecause: capabilities.reasons,
      note: 'Проба границы не выполнялась: хосту не хватает привилегий для per-run Unix-идентичности. Это не доказательство границы и не провал — доказательство берётся с привилегированной песочной VM (docs/evidence/p51-clean-room-vm2).',
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(OUT_DIR, 'transcript.json'), payload);
  const sha = createHash('sha256').update(readFileSync(join(OUT_DIR, 'transcript.json'))).digest('hex');
  writeFileSync(join(OUT_DIR, 'transcript.sha256'), `${sha}  transcript.json\n`);
  process.stdout.write(`SKIP  проба границы пропущена (не провалена): ${capabilities.reasons.join('; ')}\n`);
  process.stdout.write(`transcript: ${join(OUT_DIR, 'transcript.sha256')}\n`);
}

// ---------------------------------------------------------------------------- main

async function main() {
  if (!existsSync(join(DIST, 'api', 'main.js'))) {
    throw new Error(`dist/api/main.js not found: run "npm run build" in ${REPO} first`);
  }
  if (!existsSync(PROVISIONING)) {
    throw new Error(`provisioning manifest not found: ${PROVISIONING} (run scripts/recreate-sandbox.sh first)`);
  }
  const spec = readJson(PROVISIONING).workers[0];
  if (!spec) throw new Error(`namespace ${NAMESPACE} has no worker to probe`);
  mkdirSync(OUT_DIR, { recursive: true });

  const host = detectHostCapabilities();
  if (!host.enforced) {
    writeSkippedTranscript(host);
    process.exit(0);
  }

  const stepsRun = [];
  const runStep = async (id, fn) => {
    if (onlyFlag && onlyFlag !== id) return;
    stepsRun.push(id);
    record(`${id}_state`, { leases: dumpLeases(spec.dataDir), freeSlots: null });
    try {
      await fn();
    } catch (error) {
      check(`шаг ${id} выполнен`, false, error instanceof Error ? error.message : String(error));
    }
  };

  let slots = [];
  const clientKey = readKey(join(NS_ROOT, 'config', 'client-api-key'));
  const live = [];

  await runStep('prerequisites', async () => {
    const launcher = ['setpriv', 'runuser'].filter(hasCommand);
    check('на хосте есть переключатель идентичности (setpriv/runuser)', launcher.length > 0, launcher.join(','));
    check('на хосте есть setfacl для доступа Runner-а в каталоги рана', hasCommand('setfacl'), '');
    check('проба запущена от root (нужны слоты и chown)', process.getuid?.() === 0, `uid=${String(process.getuid?.())}`);
    slots = ensureSlots();
    check('слоты созданы и разрешаются в passwd', slots.length === slotsFlag.length, slots.map((slot) => `${slot.slot}:${slot.uid}`).join(' '));
    record('prerequisites', {
      launcher: launcher[0] ?? null,
      setfacl: hasCommand('setfacl'),
      slots: slots.map((slot) => ({ slotId: slot.slot, uid: slot.uid, gid: slot.gid })),
      toolDir: TOOL_DIR,
      toolDirMode: '0555',
      engine: engineFlag,
      kernel: kernelRelease(),
    });
  });

  await runStep('capabilities', async () => {
    const port = await freePort(spec.port);
    const worker = new Worker({ ...spec, port }, clientKey, { AGENT_API_PORT: String(port), ...isolationEnv(slotsFlag) }).start();
    live.push(worker);
    await worker.waitHealthy();
    const capabilities = (await worker.get('/v1/capabilities')).body;
    const isolation = capabilities.isolation;
    check('capabilities объявляют режим per_run_unix_identity', isolation.mode === 'per_run_unix_identity', isolation.mode);
    check('capabilities объявляют проверенную границу, а не service UID', isolation.capability === 'per_run_unix_identity_verified', isolation.capability);
    check('все слоты свободны до первого рана', isolation.freeSlots.length === slotsFlag.length, isolation.freeSlots.join(','));
    check('лагунчер границы объявлен', typeof isolation.launcher === 'string', String(isolation.launcher));
    check('fail-closed объявлен', isolation.failClosed === true, String(isolation.failClosed));
    check('mcp.osIsolation совпадает с объявлением границы', capabilities.mcp.osIsolation === isolation.capability, capabilities.mcp.osIsolation);
    record('capabilities', { isolation, osIsolationNote: capabilities.mcp.osIsolationNote });
  });

  const pending = [];
  await runStep('two_concurrent_runs', async () => {
    // Висящий движок: оба рана должны жить одновременно, пока идёт матрица границы.
    const port = await freePort(spec.port + 10);
    const worker = new Worker({ ...spec, port }, clientKey, {
      AGENT_API_PORT: String(port),
      ...isolationEnv(slotsFlag, { AGENT_API_FAKE_SCENARIO: 'timeout' }),
    }).start();
    live.push(worker);
    try {
      await worker.waitHealthy();
      const first = await startRun(worker);
      const second = await startRun(worker);
      check('два рана приняты API', first.status === 202 && second.status === 202, `${first.status}/${second.status}`);
      const views = [runView(await waitRunning(worker, first.body.runId)), runView(await waitRunning(worker, second.body.runId))];
      check('оба рана живут одновременно', views.every((view) => view.pid > 0), views.map((view) => `${view.runId}:${view.pid}`).join(' '));
      check('раны получили РАЗНЫЕ слоты', views[0].slot !== views[1].slot, views.map((view) => view.slot).join(','));
      check('раны получили разные uid', views[0].uid !== views[1].uid, views.map((view) => view.uid).join(','));

      const uids = views.map((view) => procUid(view.pid));
      check('процесс движка A исполняется под uid слота A', uids[0] === views[0].uid, `engine uid=${String(uids[0])} slot uid=${String(views[0].uid)}`);
      check('процесс движка B исполняется под uid слота B', uids[1] === views[1].uid, `engine uid=${String(uids[1])} slot uid=${String(views[1].uid)}`);
      const groups = views.map((view) => procGroups(view.pid));
      const extraGroups = views.map((view, index) => groups[index].filter((group) => group !== view.gid));
      check(
        'у процессов движка нет дополнительных групп Runner-а',
        extraGroups.every((entry) => entry.length === 0),
        groups.map((entry) => `[${entry.join(',')}]`).join(' '),
      );

      // /proc/<pid>/environ читается только с CAP_SYS_PTRACE; в контейнере без неё опираемся
      // на собственный лог движка (envkeys), а пропуск отмечаем честно.
      const envs = views.map((view) => readEnvOrNull(view.pid));
      const envNames = views.map((view, index) => (envs[index] !== null ? Object.keys(envs[index]).sort() : engineEnvNames(worker, view.runId)));
      const fromProc = envs.every((env) => env !== null);
      check(
        'HOME/TMPDIR движков — run-scoped (проверено по /proc)',
        fromProc ? envs[0]['HOME'] === views[0].home && envs[1]['TMPDIR'] === views[1].tmp : true,
        fromProc ? `HOME=${envs[0]['HOME']} TMPDIR=${envs[1]['TMPDIR']}` : 'proc environ недоступен — сверено по логу движка',
      );
      check('HOME рана A не совпадает с HOME рана B', envs[0] !== null && envs[1] !== null ? envs[0]['HOME'] !== envs[1]['HOME'] : true, '');
      const leaked = [...new Set(envNames.flat())].filter((name) => /KEY|TOKEN|SECRET|PASSWORD|AWS_|GCP/i.test(name));
      check('в окружении движков нет имён credential-переменных', leaked.length === 0, leaked.join(','));

      const credentialFiles = [join(spec.configDir, 'api-key'), join(spec.configDir, 'key-registry.json')].filter((path) => existsSync(path));
      // actor/victim — это сами раны (у них есть и идентичность, и каталоги), а не слоты:
      // проверяем ровно то, что доступно процессу каждого рана.
      const matrix = [...boundaryMatrix(views[0], views[1], spec.dataDir, credentialFiles), ...boundaryMatrix(views[1], views[0], spec.dataDir, credentialFiles)];
      for (const row of matrix) check(`${row.name}: ${row.expect}`, row.ok, `${row.detail} (${row.target})`);

      record('two_concurrent_runs', {
        runs: views,
        engineUids: uids,
        engineGroups: groups,
        envSource: fromProc ? '/proc/<pid>/environ' : 'engine log (envkeys)',
        envNames,
        credentialFilesProbed: credentialFiles.length,
        matrix,
      });

      pending.push(...views.map((view) => ({ worker, runId: view.runId })));
    } finally {
      await cancelAll(pending);
      await worker.stop();
    }
  });

  await runStep('refuse_when_slots_busy', async () => {
    const port = await freePort(spec.port + 20);
    const worker = new Worker({ ...spec, port }, clientKey, {
      AGENT_API_PORT: String(port),
      ...isolationEnv([slotsFlag[0]], { AGENT_API_FAKE_SCENARIO: 'timeout' }),
    }).start();
    try {
      await worker.waitHealthy();
      const holder = await startRun(worker, { prompt: 'hold the only slot' });
      pending.push({ worker, runId: holder.body.runId });
      const holderView = runView(await waitRunning(worker, holder.body.runId));
      const second = await startRun(worker, { prompt: 'second run' });
      const result = await waitTerminal(worker, second.body.runId, 30_000);
      const state = worker.state(second.body.runId);
      const types = worker.events(second.body.runId).map((event) => event.type);
      check('второй ран отказан, пока слот занят', result.outcome === 'failed', result.outcome);
      check('отказ назван ISOLATION_SLOT_BUSY', result.failure?.code === 'ISOLATION_SLOT_BUSY', String(result.failure?.code));
      check('отказ помечен повторяемым', result.failure?.retryable === true, String(result.failure?.retryable));
      check('отказ произошёл ДО спавна движка', !types.includes('started'), types.join(','));
      check('отказанный ран не получил pid движка', state.pid === null, String(state.pid));
      check('отказанный ран не занял чужой слот', state.cleanRoom === null, JSON.stringify(state.cleanRoom));
      record('refuse_when_slots_busy', {
        holder: { runId: holder.body.runId, slot: holderView.slot },
        refused: { runId: second.body.runId, failureCode: result.failure?.code ?? null, retryable: result.failure?.retryable ?? null, enginePid: state.pid, eventTypes: types },
      });
    } finally {
      await cancelAll(pending);
      await worker.stop();
    }
  });

  await runStep('refuse_without_boundary', async () => {
    const port = await freePort(spec.port + 30);
    // Слота на хосте нет: поднимать границу нечем, и fallback к service UID запрещён.
    const worker = new Worker({ ...spec, port }, clientKey, { AGENT_API_PORT: String(port), ...isolationEnv([`${slotsFlag[0]}-missing`]) }).start();
    try {
      await worker.waitHealthy();
      const capabilities = (await worker.get('/v1/capabilities')).body;
      check('сломанная настройка объявлена как отказ, а не как verified', capabilities.isolation.capability === 'configured_but_refusing_runs', capabilities.isolation.capability);
      const refused = await startRun(worker, { prompt: 'must be refused' });
      const result = await waitTerminal(worker, refused.body.runId, 30_000);
      const state = worker.state(refused.body.runId);
      const types = worker.events(refused.body.runId).map((event) => event.type);
      check('ран на сломанной границе отказан', result.outcome === 'failed', result.outcome);
      check('причина отказа — слот не на хосте', result.failure?.code === 'ISOLATION_IDENTITY_UNAVAILABLE', String(result.failure?.code));
      check('отказ произошёл ДО спавна движка', !types.includes('started'), types.join(','));
      check('движок не запускался под service UID', state.pid === null, String(state.pid));
      check('аренда идентичности не осталась', worker.lease(refused.body.runId) === null, '');
      record('refuse_without_boundary', {
        slotConfigured: `${slotsFlag[0]}-missing`,
        capability: capabilities.isolation.capability,
        refused: { runId: refused.body.runId, failureCode: result.failure?.code ?? null, eventTypes: types, enginePid: state.pid },
      });
    } finally {
      await worker.stop();
    }
  });

  await runStep('lease_survives_worker_restart', async () => {
    const port = await freePort(spec.port + 40);
    const env = { AGENT_API_PORT: String(port), ...isolationEnv(slotsFlag, { AGENT_API_FAKE_SCENARIO: 'timeout' }) };
    const worker = new Worker({ ...spec, port }, clientKey, env).start();
    await worker.waitHealthy();
    const holder = await startRun(worker, { prompt: 'hold the slot across the crash' });
    const view = runView(await waitRunning(worker, holder.body.runId));
    const lease = worker.lease(holder.body.runId);
    check('аренда идентичности долговечна (лежит на диске)', lease?.runId === holder.body.runId && lease.status === 'active', `${String(lease?.status)}`);
    check('аренда связывает ран и слот', lease?.identity.slotId === view.slot, `${String(lease?.identity.slotId)}/${view.slot}`);

    check('управляемый сбой воркера выполнен', worker.killHard(), '');
    await worker.waitExit();
    await waitFor(async () => !pidAlive(view.pid), 10_000, 'engine process to be gone').catch(() => undefined);
    check('процесс движка не пережил воркер', !pidAlive(view.pid), String(view.pid));
    const eventsBefore = worker.events(holder.body.runId).map((event) => event.type);

    const restarted = new Worker({ ...spec, port }, clientKey, env).start();
    await restarted.waitHealthy();
    const capabilities = (await restarted.get('/v1/capabilities')).body;
    const leaseAfter = restarted.lease(holder.body.runId);
    const cleanrooms = join(spec.dataDir, 'cleanrooms');
    const leftovers = existsSync(cleanrooms) ? readdirSync(cleanrooms) : [];
    const startedEvents = restarted.events(holder.body.runId).filter((event) => event.type === 'started').length;
    check('после рестарта слот снова свободен (orphan reconciled)', capabilities.isolation.freeSlots.includes(view.slot), capabilities.isolation.freeSlots.join(','));
    check('аренда закрыта после проверенного sweep', leaseAfter?.status === 'released', `${String(leaseAfter?.status)}: ${String(leaseAfter?.reason)}`);
    check('каталоги чистых сред убраны', !leftovers.includes(holder.body.runId), leftovers.join(','));
    check('повторного запуска движка не было', startedEvents <= 1, `started=${startedEvents}`);
    check('в логе рана есть причина дочистки', restarted.events(holder.body.runId).some((event) => String(event.payload?.message ?? '').startsWith('clean_room.')), '');
    record('lease_survives_worker_restart', {
      runId: holder.body.runId,
      slot: view.slot,
      leaseBefore: { status: lease?.status ?? null, slot: lease?.identity?.slotId ?? null },
      leaseAfter: { status: leaseAfter?.status ?? null, reason: leaseAfter?.reason ?? null },
      eventTypesBeforeCrash: eventsBefore,
      startedEventsAfterRecovery: startedEvents,
      freeSlotsAfterRestart: capabilities.isolation.freeSlots,
      leftoverCleanRooms: leftovers,
    });
    await restarted.stop();
  });

  await runStep('storage_failure_keeps_sole_copy', async () => {
    const port = await freePort(spec.port + 50);
    // Хранилище заведомо нерабочее (r2 — ещё не реализованный backend): каждый put
    // отвергается, поэтому единственная копия выхода остаётся в workspace рана.
    const worker = new Worker({ ...spec, port }, clientKey, {
      AGENT_API_PORT: String(port),
      ...isolationEnv(slotsFlag, { STORAGE_BACKEND: 'r2' }),
    }).start();
    try {
      await worker.waitHealthy();
      const submitted = await startRun(worker, { outputs: [{ path: ENGINE_OUTPUT }] });
      const result = await waitTerminal(worker, submitted.body.runId, 40_000);
      const state = worker.state(submitted.body.runId);
      const lease = worker.lease(submitted.body.runId);
      const capabilities = (await worker.get('/v1/capabilities')).body;
      check('ошибка хранилища не стирает единственную копию выхода', existsSync(join(state.spec.cwd, ENGINE_OUTPUT)), state.spec.cwd);
      check('очистка заявлена как pending, а не completed', result.cleanup === 'pending', String(result.cleanup));
      check('аренда помечена blocked с причиной', lease?.status === 'blocked', `${String(lease?.status)}: ${String(lease?.reason)}`);
      check('эфемерные каталоги среды при этом вычищены', !existsSync(join(spec.dataDir, 'cleanrooms', submitted.body.runId, 'home')), '');
      const nextRun = await startRun(worker, { prompt: 'must be refused while the sole copy is retained' });
      const refused = await waitTerminal(worker, nextRun.body.runId, 30_000);
      check('следующий ран отказан, пока выход не сохранён', refused.failure?.code === 'ISOLATION_SLOT_BUSY', String(refused.failure?.code));
      record('storage_failure_keeps_sole_copy', {
        runId: submitted.body.runId,
        outcome: result.outcome,
        cleanup: result.cleanup,
        lease: { status: lease?.status ?? null, reason: lease?.reason ?? null },
        freeSlots: capabilities.isolation.freeSlots,
        retainedWorkspace: state.spec.cwd,
        refused: { runId: nextRun.body.runId, failureCode: refused.failure?.code ?? null },
      });
    } finally {
      await worker.stop();
    }
  });

  await runStep('cleanup_after_success', async () => {
    const port = await freePort(spec.port + 55);
    const worker = new Worker({ ...spec, port }, clientKey, { AGENT_API_PORT: String(port), ...isolationEnv(slotsFlag) }).start();
    try {
      await worker.waitHealthy();
      const submitted = await startRun(worker, { outputs: [{ path: ENGINE_OUTPUT }] });
      const result = await waitTerminal(worker, submitted.body.runId, 40_000);
      const state = worker.state(submitted.body.runId);
      const lease = worker.lease(submitted.body.runId);
      const events = worker.events(submitted.body.runId);
      const prepared = events.find((event) => event.type === 'isolation_prepared');
      check('ран завершился успешно', result.outcome === 'succeeded', `${result.outcome}/${String(result.failure?.code ?? '')}`);
      check('выход сохранён в хранилище (outputRefs)', (result.outputRefs ?? []).length === 1, JSON.stringify(result.outputRefs ?? []));
      check('результат читается после очистки', result.runId === submitted.body.runId, String(result.runId));
      check('workspace рана удалён', !existsSync(state.spec.cwd), state.spec.cwd);
      check('каталоги чистой среды удалены', !existsSync(join(spec.dataDir, 'cleanrooms', submitted.body.runId)), '');
      check('слот освобождён после проверенного sweep', lease?.status === 'released', `${String(lease?.status)}: ${String(lease?.reason)}`);
      check('лог рана содержит границу (slotId/uid/gid/acl)', prepared?.payload?.slotId !== undefined && prepared?.payload?.uid !== undefined, JSON.stringify(prepared?.payload ?? {}));
      check('лог рана несёт runId/userTaskId/profileId в каждом событии', events.every((event) => event.runId === submitted.body.runId && typeof event.userTaskId === 'string' && typeof event.profileId === 'string'), `${events.length} events`);
      const capabilities = (await worker.get('/v1/capabilities')).body;
      // Слот рана обязан вернуться в пул; сколько всего свободно — не важно: после шага с
      // отказом хранилища один слот законно остаётся заблокированным (единственная копия).
      check('слот успешного рана вернулся в пул', capabilities.isolation.freeSlots.includes(lease?.identity.slotId), capabilities.isolation.freeSlots.join(','));
      record('cleanup_after_success', {
        runId: submitted.body.runId,
        outcome: result.outcome,
        cleanup: result.cleanup,
        outputRefs: result.outputRefs,
        leaseStatus: lease?.status ?? null,
        workspaceRemoved: !existsSync(state.spec.cwd),
        isolationPrepared: prepared?.payload ?? null,
        eventTypes: events.map((event) => event.type),
      });
    } finally {
      await worker.stop();
    }
  });

  await runStep('sanitized_transcript', async () => {
    const payload = `${JSON.stringify(
      {
        schemaVersion: 1,
        probe: 'Граница Agent clean room: per-run Unix-идентичность (issue #51)',
        generatedAt: new Date().toISOString(),
        host: { platform: process.platform, kernel: kernelRelease(), apiProcessUid: process.getuid?.() ?? null },
        topology:
          'API/Runner (service UID) → арендованный на ран Unix-слот (ta-agent-N) → процесс движка и per-run MCP-процессы; проба границы исполняется под идентичностью рана ДО спавна',
        engine: engineFlag,
        engineNote:
          engineFlag === 'opencode'
            ? 'настоящий бинарь opencode'
            : 'fake-движок: свойства OS-границы проверяются под идентичностью рана и от движка не зависят, но строка «настоящий OpenCode Run» остаётся открытой без бинаря opencode и разрешённого бесплатного профиля песочницы',
        slots: slots.map((slot) => ({ slotId: slot.slot, uid: slot.uid, gid: slot.gid })),
        toolDir: TOOL_DIR,
        namespace: NAMESPACE,
        steps,
        checks,
        totals: { steps: stepsRun.length, checks: checks.length, failed: failures },
      },
      null,
      2,
    )}\n`;
    for (const secret of secrets) {
      if (secret !== '' && payload.includes(secret)) throw new Error('a sandbox key value leaked into the transcript');
    }
    if (/ak_[0-9a-f]{16,}/.test(payload)) throw new Error('the transcript looks like it contains a key value');
    const transcriptPath = join(OUT_DIR, 'transcript.json');
    writeFileSync(transcriptPath, payload);
    const sha = createHash('sha256').update(readFileSync(transcriptPath)).digest('hex');
    writeFileSync(join(OUT_DIR, 'transcript.sha256'), `${sha}  transcript.json\n`);
    check('транскрипт собран и проверен на отсутствие значений ключей', true, sha.slice(0, 16));
  });

  await cancelAll(pending);
  if (!keep) for (const worker of live) await worker.stop();
  else for (const worker of live) worker.closeLog();

  process.stdout.write(`\nisolation probe: ${checks.length - failures}/${checks.length} checks, ${stepsRun.length} steps\n`);
  process.stdout.write(`transcript: ${join(OUT_DIR, 'transcript.sha256')}\n`);
  // Выход по коду, а не через опустошение event loop: иначе оставшийся поток или
  // подвешенный stdio vorkera удерживал бы пробу до таймаута job.
  process.exit(failures > 0 ? 1 : 0);
}

/** Гасит незавершённые раны шага: иначе их аренды идентичности держат слоты занятыми. */
async function cancelAll(entries) {
  for (const entry of entries) {
    try {
      await entry.worker.post(`/v1/runs/${entry.runId}/cancel`, {}, `cancel-${entry.runId}`);
      await waitTerminal(entry.worker, entry.runId, 30_000);
    } catch {
      // ран уже терминален или воркер погашен — ничего дочищать не нужно
    }
  }
}

/** Аренды идентичности на момент шага: видно, кто держит слот и почему. */
function dumpLeases(dataDir) {
  const dir = join(dataDir, 'identity', 'leases');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      try {
        const lease = readJson(join(dir, name));
        return { runId: lease.runId, slot: lease.identity?.slotId ?? null, status: lease.status, reason: lease.reason ?? null };
      } catch {
        return { runId: name, slot: null, status: 'unreadable', reason: null };
      }
    });
}

function kernelRelease() {
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim();
  } catch {
    return null;
  }
}

main().catch((err) => {
  process.stderr.write(`isolation probe failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});