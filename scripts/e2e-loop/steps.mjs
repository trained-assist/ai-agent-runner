import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Step,
  describePathMode,
  findSecretsInText,
  findSecretsInTree,
  isTerminalState,
  sha256Hex,
  sleep,
  validateEventChain,
} from './checks.mjs';
import {
  collectAllEvents,
  downloadArtifact,
  getEvents,
  getResult,
  getStatus,
  openEventStream,
  postCancel,
  submitRun,
  waitForStatus,
  waitTerminal,
} from './client.mjs';

const PROBE_SCRIPT = fileURLToPath(new URL('./engine-scripts/probe.mjs', import.meta.url));

// macOS/Node инжектит эту переменную в child process env сам — она не приходит из host-окружения
const PLATFORM_INJECTED_ENV = new Set(['__CF_USER_TEXT_ENCODING']);

function runtimeEnvKeys(keys) {
  return (keys ?? []).filter((name) => !PLATFORM_INJECTED_ENV.has(name));
}

function engineBody(engine, over = {}) {
  const body = {
    engine: { name: engine, adapterVersion: '1' },
    limits: { timeoutMs: over.timeoutMs ?? 15000 },
    envAllowlist: over.envAllowlist ?? [],
    input: over.input ?? { inlinePrompt: 'e2e' },
  };
  if (over.credentialBindings) body.credentialBindings = over.credentialBindings;
  return body;
}

function parseProbeLine(message) {
  const match = /E2E_PROBE name=(\S+) target=(.*?) verdict=(\S+)(?: detail=(.*))?$/.exec(message);
  if (!match) return null;
  return { name: match[1], target: match[2], verdict: match[3], detail: match[4] ?? '' };
}

function findLog(events, pattern) {
  return events.filter((event) => event.type === 'log' && pattern.test(event.payload.message));
}

function logMessages(events) {
  return events.filter((event) => event.type === 'log').map((event) => event.payload.message);
}

function envKeysFromLogs(events) {
  for (const message of logMessages(events)) {
    const match = /^E2E_ENV keys=(.*)$/.exec(message);
    if (match) return match[1].length > 0 ? match[1].split(',') : [];
  }
  return null;
}

// ---------------------------------------------------------------- step 1

export async function stepSubmitIdempotency(ctx, step) {
  const before = await ctx.control.health();
  const body = engineBody('fake', { input: { inlinePrompt: 'e2e step 1: idempotent submit' } });

  const first = await submitRun(ctx.base, ctx.key, 'e2e-step-1', body);
  step.check('первый submit принят: HTTP 202', first.status === 202, `got ${first.status} ${first.text.slice(0, 200)}`);
  const receipt = first.json ?? {};
  step.check(
    'receipt содержит requestId/userTaskId/runId',
    Boolean(receipt.requestId && receipt.userTaskId && receipt.runId),
    JSON.stringify(first.json),
  );
  step.check('deduplicated=false на первом submit', receipt.deduplicated === false, `got ${String(receipt.deduplicated)}`);

  const duplicate = await submitRun(ctx.base, ctx.key, 'e2e-step-1', body);
  step.check('дубль submit: HTTP 200', duplicate.status === 200, `got ${duplicate.status}`);
  step.check('дубль вернул тот же runId', duplicate.json?.runId === receipt.runId, `${duplicate.json?.runId} vs ${receipt.runId}`);
  step.check(
    'дубль вернул тот же requestId и userTaskId',
    duplicate.json?.requestId === receipt.requestId && duplicate.json?.userTaskId === receipt.userTaskId,
    JSON.stringify(duplicate.json),
  );
  step.check('deduplicated=true на дубле', duplicate.json?.deduplicated === true, `got ${String(duplicate.json?.deduplicated)}`);

  const conflictBody = engineBody('fake', { input: { inlinePrompt: 'e2e step 1: different payload' } });
  const conflict = await submitRun(ctx.base, ctx.key, 'e2e-step-1', conflictBody);
  step.check(
    'тот же ключ + другой payload → 409 IDEMPOTENCY_CONFLICT',
    conflict.status === 409 && conflict.json?.error?.code === 'IDEMPOTENCY_CONFLICT',
    `got ${conflict.status} ${conflict.text.slice(0, 200)}`,
  );

  const status = await waitTerminal(ctx.base, ctx.key, receipt.runId);
  step.check('run дошёл до succeeded', status.state === 'succeeded', `state=${status.state}`);
  const result = await getResult(ctx.base, ctx.key, receipt.runId);
  step.check('result доступен: outcome=succeeded', result.status === 200 && result.json?.outcome === 'succeeded', `HTTP ${result.status}`);

  const after = await ctx.control.health();
  const sameRun = after.runsDetail.filter((entry) => entry.runId === receipt.runId);
  step.check('в store ровно одна запись этого run', sameRun.length === 1, `records=${sameRun.length}`);
  step.check('admissions выросли ровно на 1', after.admissions - before.admissions === 1, `${before.admissions}→${after.admissions}`);
  const startsDelta = (after.startsByEngine.fake ?? 0) - (before.startsByEngine.fake ?? 0);
  step.check('engine fake стартовал ровно 1 раз (дубль не перезапустил)', startsDelta === 1, `starts delta=${startsDelta}`);
}

// ---------------------------------------------------------------- step 2

export async function stepEventsStreamReplay(ctx, step) {
  const before = await ctx.control.health();
  const body = engineBody('fake-slow', {
    input: { inlinePrompt: JSON.stringify({ sleepMs: 1400 }) },
    timeoutMs: 20000,
  });
  const submit = await submitRun(ctx.base, ctx.key, 'e2e-step-2', body);
  step.check('submit принят: HTTP 202', submit.status === 202, `got ${submit.status}`);
  const runId = submit.json.runId;

  const first = await openEventStream(ctx.base, ctx.key, runId, { cursor: 0 });
  await first.waitFor(
    (frames) => frames.some((frame) => frame.event === 'started') && frames.some((frame) => frame.event === 'log'),
    10000,
    'started + log over SSE',
  );
  const firstFrames = first.frames;
  const snapshot = firstFrames.find((frame) => frame.event === 'snapshot');
  step.check('SSE отдаёт snapshot перед событиями', Boolean(snapshot), `snapshot=${snapshot ? 'present' : 'absent'}`);
  step.check('SSE в реальном времени доставил started', firstFrames.some((frame) => frame.event === 'started'));
  const resumeFrom = first.lastEventId();
  step.check('cursor для reconnect > 0', resumeFrom > 0, `cursor=${resumeFrom}`);
  first.close();
  await sleep(60);

  const second = await openEventStream(ctx.base, ctx.key, runId, { cursor: resumeFrom });
  await second
    .waitFor((frames) => frames.some((frame) => ['succeeded', 'failed', 'cancelled'].includes(frame.event)), 12000, 'terminal frame after reconnect')
    .catch(() => undefined);

  const conn1 = first.eventFrames().map((frame) => JSON.parse(frame.data));
  const conn2 = second.eventFrames().map((frame) => JSON.parse(frame.data));
  const secondSnapshot = second.frames.find((frame) => frame.event === 'snapshot');
  second.close();

  if (conn2.length > 0) {
    const duplicates = conn1.map((event) => event.sequence).filter((sequence) => conn2.some((event) => event.sequence === sequence));
    step.check('reconnect по cursor не повторяет уже полученные события', duplicates.length === 0, `dupes: ${duplicates.join(',')}`);
    step.check('reconnect продолжает с cursor+1', conn2[0].sequence === resumeFrom + 1, `first=${conn2[0].sequence} cursor=${resumeFrom}`);
  } else {
    const state = secondSnapshot ? JSON.parse(secondSnapshot.data).state : null;
    step.check(
      'reconnect: run уже терминален на момент переподключения (события дочитаны по cursor)',
      isTerminalState(state ?? ''),
      `snapshot state=${state}`,
    );
  }

  const all = await collectAllEvents(ctx.base, ctx.key, runId, { from: 0 });
  const chain = validateEventChain(all, { requireTerminal: true });
  step.check('полнота и порядок claimed→…→succeeded', chain.ok, chain.problems.join('; '));
  step.check('терминальное событие succeeded', all[all.length - 1]?.type === 'succeeded', `last=${all[all.length - 1]?.type}`);
  step.check('claimed ровно один (rerun отсутствует)', all.filter((event) => event.type === 'claimed').length === 1);
  step.check('started присутствует', all.some((event) => event.type === 'started'));

  const bySequence = new Map(all.map((event) => [event.sequence, event]));
  const mismatch = [...conn1, ...conn2].filter((event) => bySequence.get(event.sequence)?.type !== event.type);
  step.check('SSE-события совпадают с JSON replay по sequence', mismatch.length === 0, `mismatch: ${mismatch.map((event) => event.sequence).join(',')}`);

  const middle = Math.max(1, Math.floor(all.length / 2));
  const tail = await getEvents(ctx.base, ctx.key, runId, middle);
  step.check(
    'cursor-реплей от середины отдаёт только события > cursor',
    tail.status === 200 && tail.json.events.every((event) => event.sequence > middle),
    `HTTP ${tail.status}, first=${tail.json?.events?.[0]?.sequence}`,
  );

  const after = await ctx.control.health();
  step.check('engine fake-slow стартовал 1 раз (reconnect ≠ rerun)', (after.startsByEngine['fake-slow'] ?? 0) - (before.startsByEngine['fake-slow'] ?? 0) === 1);
  step.check('admissions выросли ровно на 1', after.admissions - before.admissions === 1, `${before.admissions}→${after.admissions}`);
}

// ---------------------------------------------------------------- step 3

const FAULT_CASES = [
  {
    name: 'nonzero-exit',
    engine: 'fake-nonzero',
    expect: { outcome: 'failed', exitReason: 'nonzero_exit', code: 'ENGINE_NONZERO_EXIT' },
  },
  {
    name: 'startup-failure',
    engine: 'fake-startup',
    expect: { outcome: 'failed', exitReason: 'startup_failure', code: 'ENGINE_STARTUP_FAILED' },
  },
  {
    name: 'timeout',
    engine: 'fake-timeout',
    timeoutMs: 400,
    expect: { outcome: 'failed', exitReason: 'timeout', code: 'TIMEOUT' },
  },
  {
    name: 'crash',
    engine: 'fake-crash',
    expect: { outcome: 'failed', exitReason: 'crash', code: 'ENGINE_CRASH' },
  },
  {
    name: 'fault-spawn',
    engine: 'fake',
    fault: 'spawn',
    expect: { outcome: 'failed', exitReason: 'startup_failure', code: 'ENGINE_STARTUP_FAILED' },
  },
  {
    name: 'fault-preflight',
    engine: 'fake',
    fault: 'preflight',
    expect: { outcome: 'failed', exitReason: 'preflight_refused', code: 'PREFLIGHT_FAILED' },
  },
];

export async function stepFaultInjection(ctx, step) {
  for (const testCase of FAULT_CASES) {
    if (testCase.fault) await ctx.control.injectFault(testCase.fault, { kind: 'throw', once: true });
    const body = engineBody(testCase.engine, {
      timeoutMs: testCase.timeoutMs ?? 15000,
      input: { inlinePrompt: `e2e step 3: ${testCase.name}` },
    });
    const submit = await submitRun(ctx.base, ctx.key, `e2e-step-3-${testCase.name}`, body);
    step.check(`${testCase.name}: submit принят`, submit.status === 202, `HTTP ${submit.status} ${submit.text.slice(0, 160)}`);
    if (submit.status !== 202) continue;
    const runId = submit.json.runId;

    const status = await waitTerminal(ctx.base, ctx.key, runId, 20000);
    step.check(`${testCase.name}: состояние failed`, status.state === 'failed', `state=${status.state}`);

    const result = await getResult(ctx.base, ctx.key, runId);
    const runResult = result.json ?? {};
    step.check(`${testCase.name}: result.outcome=failed`, result.status === 200 && runResult.outcome === 'failed', `HTTP ${result.status} outcome=${runResult.outcome}`);
    step.check(
      `${testCase.name}: структурированный exitReason`,
      runResult.exitReason === testCase.expect.exitReason,
      `expected ${testCase.expect.exitReason}, got ${runResult.exitReason}`,
    );
    step.check(
      `${testCase.name}: failure.code=${testCase.expect.code}`,
      runResult.failure?.code === testCase.expect.code,
      `got ${runResult.failure?.code}`,
    );
    step.check(
      `${testCase.name}: failureClass/retryable заполнены`,
      typeof runResult.failure?.failureClass === 'string' && typeof runResult.failure?.retryable === 'boolean',
      JSON.stringify(runResult.failure ?? null),
    );
    step.check(`${testCase.name}: logPath указывает на scoped log`, typeof runResult.logPath === 'string' && runResult.logPath.includes(runId), String(runResult.logPath));

    const events = await collectAllEvents(ctx.base, ctx.key, runId, { from: 0 });
    const chain = validateEventChain(events, { requireTerminal: true });
    step.check(`${testCase.name}: цепочка событий полная`, chain.ok, chain.problems.join('; '));
    const terminal = events[events.length - 1];
    step.check(
      `${testCase.name}: терминальное событие failed видно клиенту в events`,
      terminal?.type === 'failed' && terminal.payload.code === testCase.expect.code,
      `last=${terminal?.type} code=${terminal?.payload?.code}`,
    );
  }

  await ctx.control.clearFaults();
  const recoveryBody = engineBody('fake', { input: { inlinePrompt: 'e2e step 3: registry drained' } });
  const recovery = await submitRun(ctx.base, ctx.key, 'e2e-step-3-recovery', recoveryBody);
  step.check('после очистки реестра обычный run снова принимается', recovery.status === 202, `HTTP ${recovery.status}`);
  if (recovery.status === 202) {
    const status = await waitTerminal(ctx.base, ctx.key, recovery.json.runId, 20000);
    step.check('реестр faults исчерпан: обычный run succeeded', status.state === 'succeeded', `state=${status.state}`);
  }
}

// ---------------------------------------------------------------- step 4

export async function stepRecoveryRestart(ctx, step) {
  const body = engineBody('fake-timeout', {
    timeoutMs: 120000,
    input: { inlinePrompt: 'e2e step 4: hang across a hard restart' },
  });
  const submit = await submitRun(ctx.base, ctx.key, 'e2e-step-4', body);
  step.check('submit принят: HTTP 202', submit.status === 202, `HTTP ${submit.status} ${submit.text.slice(0, 160)}`);
  if (submit.status !== 202) return;
  const runId = submit.json.runId;

  const running = await waitForStatus(ctx.base, ctx.key, runId, (status) => status.state === 'running', 10000, 'run to start');
  step.check('run перешёл в running до kill -9', running.state === 'running', `state=${running.state}`);
  const mid = await ctx.control.health();

  const exitInfo = await ctx.killServer('SIGKILL');
  step.check('процесс runner убит SIGKILL', exitInfo.killed, exitInfo.detail ?? '');

  await ctx.startServer();
  step.check('процесс runner перезапущен', true, 'server restarted');

  const statusResponse = await getStatus(ctx.base, ctx.key, runId);
  step.check('status читается после рестарта', statusResponse.status === 200, `HTTP ${statusResponse.status}`);
  const status = statusResponse.json ?? {};
  step.check('потеря связи ≠ failed: state остался running', status.state === 'running', `state=${status.state}`);
  step.check('connectionLost зафиксирован в status', status.connectionLost === true, `connectionLost=${String(status.connectionLost)}`);

  const stateFile = join(ctx.rootDir, 'runs', runId, 'state.json');
  const eventsFile = join(ctx.rootDir, 'runs', runId, 'events.jsonl');
  step.check('durable store: state.json пережил kill -9', existsSync(stateFile), stateFile);
  step.check('durable store: events.jsonl пережил kill -9', existsSync(eventsFile), eventsFile);
  if (existsSync(stateFile)) {
    try {
      const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
      step.check('state.json содержит тот же runId и состояние running', persisted.runId === runId && persisted.state === 'running', `runId=${persisted.runId} state=${persisted.state}`);
    } catch (err) {
      step.fail('state.json читается как JSON', String(err));
    }
  }

  const replay = await collectAllEvents(ctx.base, ctx.key, runId, { from: 0 });
  const chain = validateEventChain(replay, { requireTerminal: false });
  step.check('events replay после рестарта полный и упорядочен', chain.ok, chain.problems.join('; '));
  step.check('replay начинается с claimed (события читаются с диска)', replay[0]?.type === 'claimed', `first=${replay[0]?.type}`);
  step.check('replay содержит connection_lost', replay.some((event) => event.type === 'connection_lost'));

  const duplicate = await submitRun(ctx.base, ctx.key, 'e2e-step-4', body);
  step.check('повторный submit после рестарта: HTTP 200', duplicate.status === 200, `HTTP ${duplicate.status}`);
  step.check('повторный submit вернул тот же runId', duplicate.json?.runId === runId, `${duplicate.json?.runId} vs ${runId}`);
  step.check('повторный submit помечен deduplicated', duplicate.json?.deduplicated === true, `got ${String(duplicate.json?.deduplicated)}`);

  const after = await ctx.control.health();
  step.check('admissions не выросли от повторного submit', after.admissions === mid.admissions, `${mid.admissions}→${after.admissions}`);
  const postRestartStarts = after.startsByEngine['fake-timeout'] ?? 0;
  step.check(
    'engine не стартовал заново после рестарта (нет второго run)',
    postRestartStarts === 0,
    `starts after restart=${postRestartStarts}`,
  );

  const cancel = await postCancel(ctx.base, ctx.key, runId, {});
  step.check('cancel осиротевшего run принят', cancel.status === 200 || cancel.status === 202, `HTTP ${cancel.status} ${cancel.text.slice(0, 160)}`);
  const terminal = await waitTerminal(ctx.base, ctx.key, runId, 15000);
  step.check('run финализирован после cancel', isTerminalState(terminal.state), `state=${terminal.state}`);

  const finalEvents = await collectAllEvents(ctx.base, ctx.key, runId, { from: 0 });
  const finalChain = validateEventChain(finalEvents, { requireTerminal: true });
  step.check('финальная цепочка терминальна и полна', finalChain.ok, finalChain.problems.join('; '));
  const finalHealth = await ctx.control.health();
  step.check('движок остановлен после шага', finalHealth.activeRuns === 0, `activeRuns=${finalHealth.activeRuns}`);
}

// ---------------------------------------------------------------- step 5

export async function stepSecurityProbes(ctx, step) {
  const targets = {
    foreignProfile: ctx.fixtures.foreignProfile,
    secretsEnv: ctx.fixtures.secretsEnv,
    metadataUrl: ctx.fixtures.metadataUrl,
  };
  const body = engineBody('probe', {
    timeoutMs: 30000,
    envAllowlist: [],
    input: { inlinePrompt: JSON.stringify(targets) },
  });
  const submit = await submitRun(ctx.base, ctx.key, 'e2e-step-5', body);
  step.check('submit принят: HTTP 202', submit.status === 202, `HTTP ${submit.status} ${submit.text.slice(0, 160)}`);
  if (submit.status !== 202) return;
  const runId = submit.json.runId;

  const status = await waitTerminal(ctx.base, ctx.key, runId, 30000);
  step.check('пробы выполнились (run succeeded)', status.state === 'succeeded', `state=${status.state}`);

  const events = await collectAllEvents(ctx.base, ctx.key, runId, { from: 0 });
  const probeLines = findLog(events, /E2E_PROBE /).map((event) => event.payload.message);
  const probes = probeLines.map(parseProbeLine).filter(Boolean);
  const byName = new Map(probes.map((probe) => [probe.name, probe]));

  for (const name of ['foreign_profile', 'sudo', 'metadata', 'secrets_env']) {
    const present = byName.has(name);
    step.check(`проба "${name}" зафиксирована в scoped events`, present, `missing; got [${[...byName.keys()].join(',')}]`);
  }

  const foreignExists = ctx.fixtures.foreignProfileExists;
  const foreign = byName.get('foreign_profile');
  if (foreign) {
    if (foreign.verdict === 'LEAKED') {
      step.fail('чужой профиль не читается из рана', `verdict=LEAKED detail=${foreign.detail}`);
    } else if (foreignExists) {
      step.check('чужой профиль: отказ доступа (DENIED)', foreign.verdict === 'DENIED', `verdict=${foreign.verdict} detail=${foreign.detail}`);
    } else {
      step.check('чужой профиль: DENIED или ABSENT (нет данных)', foreign.verdict === 'DENIED' || foreign.verdict === 'ABSENT', `verdict=${foreign.verdict}`);
    }
  }

  const sudo = byName.get('sudo');
  const sudoPolicy = ctx.opts.sudoPolicy ?? 'deny';
  if (sudo) {
    if (sudo.verdict === 'DENIED') {
      step.check('sudo: отказ (нет привилегирования)', true, `detail=${sudo.detail}`);
    } else if (sudoPolicy === 'report') {
      step.check(
        'sudo: passwordless sudo окружения зафиксирован, policy=report не валит шаг',
        true,
        `verdict=${sudo.verdict} detail=${sudo.detail}`,
      );
    } else {
      step.check('sudo: отказ (нет привилегирования)', false, `verdict=${sudo.verdict} detail=${sudo.detail}`);
    }
  }

  const metadata = byName.get('metadata');
  if (metadata) step.check('metadata endpoint 169.254.169.254: отказ', metadata.verdict === 'DENIED', `verdict=${metadata.verdict} detail=${metadata.detail}`);

  const secrets = byName.get('secrets_env');
  if (secrets) step.check('secrets.env: отказ доступа (DENIED)', secrets.verdict === 'DENIED', `verdict=${secrets.verdict} detail=${secrets.detail}`);

  const violations = probes.filter(
    (probe) => probe.verdict === 'LEAKED' && !(probe.name === 'sudo' && sudoPolicy === 'report'),
  );
  step.check('ни одна проба не показала LEAKED', violations.length === 0, violations.map((probe) => probe.name).join(','));

  const rawKeys = envKeysFromLogs(events);
  const envKeys = runtimeEnvKeys(rawKeys);
  step.check(
    'engine env пуст: host-секреты не переданы в ран',
    rawKeys !== null && envKeys.length === 0,
    `line=${rawKeys === null ? 'missing' : 'present'} keys=${JSON.stringify(envKeys)}`,
  );

  const diskLog = existsSync(join(ctx.rootDir, 'runs', runId, 'events.jsonl'))
    ? readFileSync(join(ctx.rootDir, 'runs', runId, 'events.jsonl'), 'utf8')
    : '';
  step.check('попытки видны в scoped log на диске', (diskLog.match(/E2E_PROBE /g) ?? []).length >= 4, `found ${(diskLog.match(/E2E_PROBE /g) ?? []).length}`);

  if (ctx.opts.withOpencode) {
    const prompt = `Run this exact shell command with the bash tool and print its full output: ${process.execPath} ${PROBE_SCRIPT} ${JSON.stringify(JSON.stringify(targets))}`;
    const opencodeBody = engineBody('opencode', { timeoutMs: 180000, envAllowlist: [], input: { inlinePrompt: prompt } });
    const opencodeSubmit = await submitRun(ctx.base, ctx.key, 'e2e-step-5-opencode', opencodeBody);
    step.check('opencode: submit принят', opencodeSubmit.status === 202, `HTTP ${opencodeSubmit.status}`);
    if (opencodeSubmit.status === 202) {
      const opencodeRunId = opencodeSubmit.json.runId;
      const opencodeStatus = await waitTerminal(ctx.base, ctx.key, opencodeRunId, 180000);
      step.check('opencode: run дошёл до терминального состояния', isTerminalState(opencodeStatus.state), `state=${opencodeStatus.state}`);
      const opencodeEvents = await collectAllEvents(ctx.base, ctx.key, opencodeRunId, { from: 0 });
      const blob = logMessages(opencodeEvents).join('\n');
      step.check('opencode: канарейки чужого профиля/secrets не утекли в логи', findSecretsInText(blob, ctx.secrets).length === 0);
      step.check('opencode: нет verdict=LEAKED', !blob.includes('verdict=LEAKED'));
      step.check('opencode: пробы действительно выполнялись', blob.includes('E2E_PROBE '), 'нет строк E2E_PROBE в выводе opencode');
    }
  }
}

// ---------------------------------------------------------------- step 6

export async function stepArtifactDownload(ctx, step) {
  const ref = 'report.txt';
  const lines = ['# e2e acceptance artifact', 'created by the engine inside the run', 'byte-for-byte check'];
  const body = engineBody('artifact', {
    timeoutMs: 20000,
    input: { inlinePrompt: JSON.stringify({ ref, lines }) },
  });
  const submit = await submitRun(ctx.base, ctx.key, 'e2e-step-6', body);
  step.check('submit принят: HTTP 202', submit.status === 202, `HTTP ${submit.status}`);
  if (submit.status !== 202) return;
  const runId = submit.json.runId;

  const status = await waitTerminal(ctx.base, ctx.key, runId, 20000);
  step.check('run succeeded', status.state === 'succeeded', `state=${status.state}`);
  const result = await getResult(ctx.base, ctx.key, runId);
  step.check('result доступен через API', result.status === 200, `HTTP ${result.status}`);

  const events = await collectAllEvents(ctx.base, ctx.key, runId, { from: 0 });
  const artifactLine = findLog(events, /E2E_ARTIFACT /).map((event) => event.payload.message)[0] ?? '';
  const match = /E2E_ARTIFACT ref=(\S+) sha256=([0-9a-f]+) bytes=(\d+) mode=(\d+)/.exec(artifactLine);
  step.check('движок сообщил артефакт (ref/sha256/bytes) в scoped events', Boolean(match), `line="${artifactLine}"`);
  if (!match) return;
  const declaredSha = match[2];
  const declaredBytes = Number(match[3]);

  const download = await downloadArtifact(ctx.base, ctx.key, runId, ref);
  step.check('клиент получил артефакт через API download: HTTP 200', download.status === 200, `HTTP ${download.status} ${download.errorBody ?? ''}`);
  if (download.status !== 200) return;
  const actualSha = sha256Hex(download.buffer);
  step.check('sha256 байтов совпадает с объявленным', actualSha === declaredSha, `actual=${actualSha} declared=${declaredSha}`);
  step.check('download header sha256 совпадает', download.sha256 === actualSha, `header=${download.sha256}`);
  step.check('размер байт-в-байт совпадает', download.buffer.length === declaredBytes, `${download.buffer.length} vs ${declaredBytes}`);
  step.check('body совпадает с содержимым файла на диске', sha256Hex(readFileSync(join(ctx.rootDir, 'workspaces', runId, ref))) === actualSha);

  const artifactMode = describePathMode(join(ctx.rootDir, 'workspaces', runId, ref));
  step.check('артефакт не доступен миру (mode 600)', artifactMode.exists && ((artifactMode.mode ?? 0o777) & 0o077) === 0, `mode=${artifactMode.modeText ?? artifactMode.error}`);
  const workspaceMode = describePathMode(join(ctx.rootDir, 'workspaces', runId));
  step.check('workspace не доступен миру (mode 700)', workspaceMode.exists && ((workspaceMode.mode ?? 0o777) & 0o077) === 0, `mode=${workspaceMode.modeText ?? workspaceMode.error}`);
  step.check('download отдаёт тот же mode, что на диске', download.fileMode === artifactMode.modeText, `header=${download.fileMode} disk=${artifactMode.modeText}`);

  const traversal = await downloadArtifact(ctx.base, ctx.key, runId, '../api/admissions.json');
  step.check('path traversal через ref отклонён (400)', traversal.status === 400, `HTTP ${traversal.status}`);
  const missing = await downloadArtifact(ctx.base, ctx.key, runId, 'missing.txt');
  step.check('отсутствующий артефакт → 404', missing.status === 404, `HTTP ${missing.status}`);
  const noAuth = await fetch(`${ctx.base}/v1/runs/${encodeURIComponent(runId)}/download?ref=${ref}`);
  step.check('download без ключа → 401', noAuth.status === 401, `HTTP ${noAuth.status}`);
}

// ---------------------------------------------------------------- step 7

export async function stepCredentialScopes(ctx, step) {
  const readCred = ctx.creds.find((entry) => entry.scope === 'read');
  const writeCred = ctx.creds.find((entry) => entry.scope === 'write');
  if (!readCred || !writeCred) {
    step.fail('синтетические креды подготовлены', 'creds fixture is incomplete');
    return;
  }
  const transcript = [];

  const readBody = engineBody('cred', {
    timeoutMs: 20000,
    envAllowlist: ['E2E_CRED_READ', 'E2E_GATEWAY_URL'],
    credentialBindings: [{ ref: `env:${readCred.env}`, scope: 'read', status: 'active' }],
    input: { inlinePrompt: 'e2e step 7: read-scope credential' },
  });
  const readSubmit = await submitRun(ctx.base, ctx.key, 'e2e-step-7-read', readBody);
  transcript.push(readSubmit.text);
  step.check('run со scope=read принят', readSubmit.status === 202, `HTTP ${readSubmit.status}`);

  const writeBody = engineBody('cred', {
    timeoutMs: 20000,
    envAllowlist: ['E2E_CRED_WRITE', 'E2E_GATEWAY_URL'],
    credentialBindings: [{ ref: `env:${writeCred.env}`, scope: 'write', status: 'active' }],
    input: { inlinePrompt: 'e2e step 7: write-scope credential' },
  });
  const writeSubmit = await submitRun(ctx.base, ctx.key, 'e2e-step-7-write', writeBody);
  transcript.push(writeSubmit.text);
  step.check('run со scope=write принят', writeSubmit.status === 202, `HTTP ${writeSubmit.status}`);
  if (readSubmit.status !== 202 || writeSubmit.status !== 202) return;

  const readRunId = readSubmit.json.runId;
  const writeRunId = writeSubmit.json.runId;
  const readStatus = await waitTerminal(ctx.base, ctx.key, readRunId, 20000);
  const writeStatus = await waitTerminal(ctx.base, ctx.key, writeRunId, 20000);
  step.check('run со scope=read succeeded (gateway-отказ не валит ран)', readStatus.state === 'succeeded', `state=${readStatus.state}`);
  step.check('run со scope=write succeeded', writeStatus.state === 'succeeded', `state=${writeStatus.state}`);

  const readEvents = await collectAllEvents(ctx.base, ctx.key, readRunId, { from: 0 });
  const writeEvents = await collectAllEvents(ctx.base, ctx.key, writeRunId, { from: 0 });
  transcript.push(JSON.stringify(readEvents), JSON.stringify(writeEvents));

  const readCredLine = findLog(readEvents, /E2E_CRED /).map((event) => event.payload.message)[0] ?? '';
  const writeCredLine = findLog(writeEvents, /E2E_CRED /).map((event) => event.payload.message)[0] ?? '';
  step.check('scope=read: чтение через gateway разрешено (read=200)', /\bread=200\b/.test(readCredLine), readCredLine);
  step.check('scope=read: запись через gateway запрещена (write=403)', /\bwrite=403\b/.test(readCredLine), readCredLine);
  step.check('scope=write: запись через gateway разрешена (write=200)', /\bwrite=200\b/.test(writeCredLine), writeCredLine);
  step.check('scope=write: чтение разрешено (read=200)', /\bread=200\b/.test(writeCredLine), writeCredLine);

  const readKeys = runtimeEnvKeys(envKeysFromLogs(readEvents)).sort();
  const expectedReadKeys = ['E2E_CRED_READ', 'E2E_GATEWAY_URL'];
  step.check(
    'в ран только allowlist-переменные (нет креда другого скоупа)',
    JSON.stringify(readKeys) === JSON.stringify(expectedReadKeys),
    `keys=${JSON.stringify(readKeys)}`,
  );

  const attempts = await ctx.control.credAttempts();
  const list = attempts.attempts ?? [];
  step.check(
    'gateway зафиксировал отказ записи для read-скопа',
    list.some((attempt) => attempt.env === readCred.env && attempt.action === 'write' && attempt.outcome === 'denied'),
    JSON.stringify(list),
  );
  step.check(
    'gateway зафиксировал успешную запись для write-скопа',
    list.some((attempt) => attempt.env === writeCred.env && attempt.action === 'write' && attempt.outcome === 'allowed'),
    JSON.stringify(list),
  );
  step.check(
    'gateway зафиксировал чтение read-скопа',
    list.some((attempt) => attempt.env === readCred.env && attempt.action === 'read' && attempt.outcome === 'allowed'),
    JSON.stringify(list),
  );

  const resultRead = await getResult(ctx.base, ctx.key, readRunId);
  const resultWrite = await getResult(ctx.base, ctx.key, writeRunId);
  transcript.push(resultRead.text, resultWrite.text);
  const statusRead = await getStatus(ctx.base, ctx.key, readRunId);
  const statusWrite = await getStatus(ctx.base, ctx.key, writeRunId);
  transcript.push(statusRead.text, statusWrite.text);
  const serverLog = ctx.getServerLog();
  transcript.push(serverLog);

  const secrets = [readCred.value, writeCred.value];
  for (const [name, text] of [
    ['client-visible ответы (receipt/status/result/events)', transcript.filter((entry) => entry !== serverLog).join('\n')],
    ['server log (stdout/stderr)', serverLog],
  ]) {
    const hits = findSecretsInText(text, secrets);
    step.check(`креды отсутствуют в ${name}`, hits.length === 0, `hits at indexes ${hits.map((hit) => hit.secretIndex).join(',')}`);
  }

  for (const [name, file] of [
    ['admissions store', join(ctx.rootDir, 'api', 'admissions.json')],
    ['operations index', join(ctx.rootDir, 'operations.json')],
  ]) {
    const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const hits = findSecretsInText(content, secrets);
    step.check(`креды отсутствуют в ${name}`, hits.length === 0, `hits at indexes ${hits.map((hit) => hit.secretIndex).join(',')}`);
  }

  for (const [name, runId] of [['scope=read', readRunId], ['scope=write', writeRunId]]) {
    const runFiles = [join(ctx.rootDir, 'runs', runId, 'state.json'), join(ctx.rootDir, 'runs', runId, 'events.jsonl'), join(ctx.rootDir, 'runs', runId, 'result.json')];
    for (const file of runFiles) {
      const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const hits = findSecretsInText(content, secrets);
      step.check(`креды отсутствуют в ${name}: ${file.split('/').slice(-2).join('/')}`, hits.length === 0, `hits at indexes ${hits.map((hit) => hit.secretIndex).join(',')}`);
    }
    const workspaceHits = findSecretsInTree(join(ctx.rootDir, 'workspaces', runId), secrets);
    step.check(`креды не остались в workspace после run (${name})`, workspaceHits.length === 0, workspaceHits.map((hit) => hit.file).join(','));
  }
}
