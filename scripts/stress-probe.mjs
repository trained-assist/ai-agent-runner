#!/usr/bin/env node
// stress-probe.mjs — замеры для решений о лимитах CI (issue-нет, инициатива владельца 01.10.2026):
//   A) timeline: старт job → npm ci → API up → submit → running → succeeded → result доступен;
//   B) память: аллокация до OOM-kill (сигнатура убийства + dmesg + swap до/после);
//   C) CPU: 4 процесса × 15с burn (троттлинг/load);
//   D) result-after-terminal: сколько проходит от succeeded до готового result.
// Прогоняется в .github/workflows/stress-probe.yml. Никаких секретов в отчёте.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEvents, getResult, getStatus, postCancel, submitRun, waitForStatus, waitTerminal } from './e2e-loop/client.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const reportPath = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : 'stress-report.json';

let report = { startedAt: new Date().toISOString(), timeline: null, memory: null, cpu: null, notes: [] };
if (process.argv.includes('--merge') && existsSync(reportPath)) {
  try {
    const prev = JSON.parse(readFileSync(reportPath, 'utf8'));
    report = { ...report, ...prev, notes: Array.isArray(prev.notes) ? prev.notes : [] };
  } catch { /* начинаем заново */ }
}
const t = (label) => ({ label, at: Date.now(), iso: new Date().toISOString() });
const jobStartMs = Number(process.env.JOB_START_MS || 0);
const npmDoneMs = Number(process.env.NPM_DONE_MS || 0);

function save() {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function fmtMs(ms) {
  return ms >= 0 ? `${ms} ms` : 'n/a (этап не записан)';
}

// ---------------------------------------------------------------- A: timeline
function buildDist() {
  const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    console.error('typescript не найден — нужен npm ci (devDependencies)');
    process.exit(2);
  }
  const dist = join(REPO_ROOT, '.e2e-dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const build = spawnSync(process.execPath, [tsc, '-p', join(SCRIPT_DIR, 'e2e-loop', 'tsconfig.build.json')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (build.status !== 0) {
    console.error(build.stdout ?? '', build.stderr ?? '');
    process.exit(2);
  }
  return dist;
}

async function startServer(dist, rootDir) {
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
            principalId: 'stress-client',
            profileId: 'profile-stress',
            scopes: ['runs:read', 'runs:write'],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const child = spawn(process.execPath, [join(SCRIPT_DIR, 'e2e-loop', 'server.mjs')], {
    env: {
      ...process.env,
      E2E_DIST: dist,
      E2E_ROOT_DIR: rootDir,
      E2E_PORT: '0',
      E2E_CONTROL_TOKEN: controlToken,
      E2E_KEYS_PATH: keysPath,
      E2E_WITH_OPENCODE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let port = null;
  let buffer = '';
  let stderrText = '';
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const parsed = JSON.parse(line);
        if (parsed.event === 'e2e_server_listening') port = parsed.port;
      } catch {
        // не-JSON строка — ок
      }
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrText += String(chunk);
  });
  const deadline = Date.now() + 30000;
  while (port === null && Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (port === null) {
    child.kill('SIGKILL');
    throw new Error(`сервер не поднялся за 30s; stderr=${stderrText.slice(-500)}`);
  }
  return { child, port, key: clientKey, controlToken };
}

async function phaseTimeline() {
  const marks = { jobStart: jobStartMs, npmDone: npmDoneMs };
  marks.distBuilt = Date.now();
  const rootDir = mkdtempSync(join(tmpdir(), 'stress-probe-'));
  const dist = buildDist();
  marks.distBuilt = Date.now();
  const server = await startServer(dist, rootDir);
  marks.serverListening = Date.now();
  const base = `http://127.0.0.1:${server.port}`;

  // healthz (без auth)
  const health = await fetch(`${base}/healthz`);
  if (!health.ok) throw new Error(`healthz HTTP ${health.status}`);
  marks.healthOk = Date.now();

  const body = {
    engine: { name: 'fake', adapterVersion: '1' },
    limits: { timeoutMs: 60000 },
    envAllowlist: [],
    input: { inlinePrompt: 'stress-probe: latency timeline' },
  };
  const submit = await submitRun(base, server.key, `stress-${Date.now()}`, body);
  if (submit.status !== 202) throw new Error(`submit HTTP ${submit.status}: ${submit.text.slice(0, 200)}`);
  marks.submitAccepted = Date.now();
  const runId = submit.json.runId;

  // стрим-шкала: ловим КАЖДОЕ событие в момент первого появления (клиентская метка)
  const seen = new Map();
  const pollDeadline = Date.now() + 30000;
  let snapState = null;
  while (Date.now() < pollDeadline) {
    const r = await getEvents(base, server.key, runId, 0, 500);
    if (r.status === 200) {
      for (const e of r.json?.events ?? []) {
        if (!seen.has(e.sequence)) {
          seen.set(e.sequence, {
            type: e.type,
            seq: e.sequence,
            recvOffMs: Date.now() - marks.submitAccepted,
            ...(e.at ? { at: e.at } : {}),
          });
        }
      }
      snapState = r.json?.snapshot?.state ?? snapState;
      if (['succeeded', 'failed', 'cancelled'].includes(snapState)) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  marks.running = marks.submitAccepted + ([...seen.values()].find((e) => e.type === 'started')?.recvOffMs ?? 0);
  marks.terminal = Date.now();
  if (!['succeeded', 'failed', 'cancelled'].includes(snapState)) throw new Error(`run не стал терминальным за 30s (state=${snapState})`);

  const resultAt0 = Date.now();
  const result = await getResult(base, server.key, runId);
  marks.resultReady = Date.now();
  if (result.status !== 200) throw new Error(`result HTTP ${result.status}`);

  // события: первый claimed и первый started по времени
  const events = await getEvents(base, server.key, runId, 0, 500);
  const list = events.json?.events ?? [];
  const firstClaimed = list.find((e) => e.type === 'claimed');
  const firstStarted = list.find((e) => e.type === 'started');
  marks.firstEventClaimed = firstClaimed ? marks.submitAccepted + (firstClaimed.at && 0) : null;

  server.child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
  rmSync(join(rootDir), { recursive: true, force: true });

  report.timeline = {
    jobStartToNpmDone: npmDoneMs ? npmDoneMs - jobStartMs : null,
    npmDoneToDistBuilt: npmDoneMs ? marks.distBuilt - npmDoneMs : null,
    distBuildToServerListening: marks.serverListening - marks.distBuilt,
    serverListeningToHealth: marks.healthOk - marks.serverListening,
    healthToSubmitAccepted: marks.submitAccepted - marks.healthOk,
    submitToRunning: marks.running - marks.submitAccepted,
    submitToTerminal: marks.terminal - marks.submitAccepted,
    terminalToResultReady: marks.resultReady - marks.terminal,
    submitToResultReady: marks.resultReady - marks.submitAccepted,
    jobStartToResultReady: jobStartMs ? marks.resultReady - jobStartMs : null,
    note: 'claimed/started-timestamps берутся из events, но clock источника = клиентский poll; submitToRunning точнее для «начала рана»',
    eventsCount: list.length,
    eventTypes: [...new Set(list.map((e) => e.type))],
    ...(firstClaimed ? { firstEvent: { type: firstClaimed.type, sequence: firstClaimed.sequence } } : {}),
    ...(firstStarted ? { startedEvent: { type: firstStarted.type, sequence: firstStarted.sequence } } : {}),
    // общая шкала сравнения машин: события стрима с таймкодом относительно submit
    eventTimeline: [...seen.values()].sort((a, b) => a.seq - b.seq),
  };
  report.notes.push(`result готов через ${marks.resultReady - marks.terminal} мс после терминала; upload-artifact в workflow идёт отдельным шагом после job`);
  return resultAt0;
}

// ---------------------------------------------------------------- B2: recovery после смерти процесса
// Ключевая метрика владельца: сколько проходит от СМЕРТИ сервера до того, как
// данные (status/events/result) снова читаются с durable store.
async function phaseRecovery() {
  const rootDir = mkdtempSync(join(tmpdir(), 'stress-recovery-'));
  const dist = buildDist();
  let server = await startServer(dist, rootDir);
  const base = () => `http://127.0.0.1:${server.port}`;

  const body = {
    engine: { name: 'fake-timeout', adapterVersion: '1' },
    limits: { timeoutMs: 180000 },
    envAllowlist: [],
    input: { inlinePrompt: 'stress-recovery: in-flight run across server death' },
  };
  const submit = await submitRun(base(), server.key, `stress-rec-${Date.now()}`, body);
  if (submit.status !== 202) throw new Error(`submit HTTP ${submit.status}: ${submit.text.slice(0, 160)}`);
  const runId = submit.json.runId;
  await waitForStatus(base(), server.key, runId, (s) => s.state === 'running', 15000, 'running before kill');

  // смерть процесса
  const tKill = Date.now();
  server.child.kill('SIGKILL');
  await new Promise((resolve) => server.child.on('exit', resolve));
  const tKilled = Date.now();

  // рестарт того же rootDir → durable store
  server = await startServer(dist, rootDir);
  const tUp = Date.now();

  let tStatus = null;
  let status = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = await getStatus(base(), server.key, runId);
    if (r.status === 200) { status = r.json; tStatus = Date.now(); break; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (tStatus === null) throw new Error('status не читается за 5s после рестарта');

  let tEvents = null;
  let eventsCount = 0;
  const deadline2 = Date.now() + 5000;
  while (Date.now() < deadline2) {
    const r = await getEvents(base(), server.key, runId, 0, 500);
    if (r.status === 200 && (r.json?.events?.length ?? 0) > 0) {
      eventsCount = r.json.events.length;
      tEvents = Date.now();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  // уборка: гасим run и сервер
  await postCancel(base(), server.key, runId, {}).catch(() => {});
  server.child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
  try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* ok */ }

  report.recovery = {
    killToProcessDeadMs: tKilled - tKill,
    killToServerUpMs: tUp - tKill,
    killToStatusReadableMs: tStatus - tKill,
    killToEventsReplayMs: tEvents ? tEvents - tKill : null,
    statusAfterRestart: status?.state ?? null,
    eventsReplayed: eventsCount,
    note: 'смерть = SIGKILL процесса сервера; данные читаются из durable store того же rootDir',
  };
  report.notes.push(
    `recovery: status читается через ${tStatus - tKill} мс после смерти, события реплеятся через ${tEvents ? tEvents - tKill : 'n/a'} мс, состояние=${status?.state}`,
  );
  save();
  console.log('RECOVERY:', JSON.stringify(report.recovery, null, 2));
}

// ---------------------------------------------------------------- B: memory → OOM
function phaseMemory() {
  const swapsBefore = readFileSync('/proc/swaps', 'utf8').trim();
  const childScript = `
    const held = [];
    const CHUNK = 64 * 1024 * 1024;
    let total = 0;
    try {
      for (let i = 0; i < 400; i++) {
        const buf = Buffer.alloc(CHUNK); buf.fill(1); held.push(buf);
        total += CHUNK;
        if (i % 4 === 0) { console.log('alloc_mb=' + (total / 1048576)); }
      }
      console.log('SURVIVED_total_mb=' + (total / 1048576));
      process.exit(0);
    } catch (e) {
      console.log('THROW ' + e.message + ' after_mb=' + (total / 1048576));
      process.exit(3);
    }
  `;
  const child = spawn(process.execPath, ['-e', childScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); // прогресс alloc_mb должен дойти до лога ДО смерти джобы
  let lastMb = 0;
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      const m = line.match(/alloc_mb=(\d+)/);
      if (m) lastMb = Number(m[1]);
      if (line.startsWith('SURVIVED')) lastMb = Number(line.split('=')[1]);
      if (line.startsWith('THROW')) report.notes.push(line);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exit = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const guard = new Promise((resolve) => setTimeout(() => {
    child.kill('SIGKILL');
    resolve({ code: null, signal: 'GUARD_TIMEOUT' });
  }, 180000));
  return Promise.race([exit, guard]).then((result) => {
    const dmesg = spawnSync('sudo', ['dmesg'], { encoding: 'utf8', timeout: 10000 });
    const oomLines = (dmesg.stdout ?? '')
      .split('\n')
      .filter((line) => /oom|killed process/i.test(line))
      .slice(-6);
    const swapsAfter = readFileSync('/proc/swaps', 'utf8').trim();
    report.memory = {
      allocatedBeforeDeathMb: lastMb,
      exitCode: result.code,
      signal: result.signal,
      oomKillerInDmesg: oomLines.length > 0,
      dmesgTail: oomLines,
      swapBefore: swapsBefore,
      swapAfter: swapsAfter,
      stderrTail: stderr.slice(-400),
    };
    report.notes.push(
      result.signal === 'SIGKILL'
        ? `память: процесс убит (exit=137/SIGKILL) после ~${lastMb} МБ — это и есть сигнатура OOM для классификатора ошибок`
        : `память: процесс завершился code=${result.code} signal=${result.signal} после ${lastMb} МБ`,
    );
    save();
    console.log(`MEMORY: ${lastMb} МБ до death, exit=${result.code}, signal=${result.signal}, dmesg_oom=${oomLines.length > 0}`);
  });
}

// ---------------------------------------------------------------- C: CPU burn
function phaseCpu() {
  return new Promise((resolve) => {
    const loadBefore = readFileSync('/proc/loadavg', 'utf8').trim();
    const kids = [];
    for (let i = 0; i < 4; i += 1) {
      kids.push(spawn('bash', ['-c', 'end=$((SECONDS+15)); while [ $SECONDS -lt $end ]; do :; done'], { stdio: 'ignore' }));
    }
    setTimeout(() => {
      const loadAfter = readFileSync('/proc/loadavg', 'utf8').trim();
      for (const kid of kids) kid.kill('SIGKILL');
      report.cpu = { parallelBurn: 4, burnSeconds: 15, loadBefore, loadAfter, logicalCpus: require_os_cpus() };
      report.notes.push(`cpu: 4×15с burn; load ${loadBefore.split(' ')[0]} → ${loadAfter.split(' ')[0]} (4 vCPU; рост ≈4 = полная загрузка, >4 возможен, троттлинг виден по wall-time)`);
      save();
      console.log(`CPU: load ${loadBefore} → ${loadAfter}`);
      resolve();
    }, 15500);
  });
}

function require_os_cpus() {
  try {
    return Number(readFileSync('/proc/cpuinfo', 'utf8').match(/processor/gi)?.length ?? 0);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- main
const phase = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : 'all';

(async () => {
  try {
    if (phase === 'all' || phase === 'timeline') {
      await phaseTimeline();
      save();
      console.log('TIMELINE:', JSON.stringify(report.timeline, null, 2));
    }
    if (phase === 'all' || phase === 'recovery') {
      await phaseRecovery();
    }
    if (phase === 'all' || phase === 'memory') {
      await phaseMemory();
    }
    if (phase === 'all' || phase === 'cpu') {
      await phaseCpu();
    }
    report.finishedAt = new Date().toISOString();
    save();
    console.log(`report: ${reportPath}`);
  } catch (err) {
    report.error = err instanceof Error ? err.stack ?? err.message : String(err);
    save();
    console.error(report.error);
    process.exit(1);
  }
})();
