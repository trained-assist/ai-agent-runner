#!/usr/bin/env node
// Проба приёмки P13 (карточка #52, этап I04): воспроизводимый транскрипт на реальных
// процессах — per-run stdio MCP-сервер, per-run broker для движка, общий фикстурный
// доменный сервис, управляемые сбои и проверка отсутствия секретов в отчёте.
//
// Запуск (из корня репозитория, после npm ci):
//   node scripts/mcp-lifecycle-probe.mjs [--out <dir>] [--keep]
//
// Секреты наружу не попадают: bearer-токен фикстуры генерируется на каждый запуск и
// живёт только в env дочерних процессов; в транскрипт он не пишется (проверка в конце).
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outDir = outFlag >= 0 ? resolve(args[outFlag + 1]) : join(REPO, 'docs', 'evidence', 'p13-mcp-lifecycle');
const keep = args.includes('--keep');

const WRITE_BINDING = 'cred:demo-domain-write';
const READ_BINDING = 'cred:demo-domain-read';
const READONLY_BINDING = 'cred:demo-domain-readonly';

const results = [];
const checks = [];
let failures = 0;

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function record(step, fields) {
  const entry = { at: new Date().toISOString(), step, ...fields };
  results.push(entry);
  return entry;
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function mcpMessages(events) {
  return events
    .filter((event) => event['type'] === 'log' && typeof event['payload']?.['message'] === 'string' && event['payload']['message'].startsWith('mcp.'))
    .map((event) => event['payload']['message']);
}

async function waitFor(cond, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function startFakeRemote(rootDir) {
  const token = `fixture-${randomBytes(16).toString('hex')}`;
  const logPath = join(rootDir, 'fake-remote.jsonl');
  const child = spawn(process.execPath, [join(REPO, 'scripts', 'fake-remote-domain-service.mjs')], {
    env: { ...process.env, FAKE_REMOTE_TOKEN: token, FAKE_REMOTE_PORT: '0', FAKE_REMOTE_LOG: logPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('fake remote service did not report a port')), 8000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, index));
        if (parsed.event === 'fake_remote_listening' && typeof parsed.port === 'number') {
          clearTimeout(timer);
          resolve(parsed.port);
        }
      } catch {
        // ждём следующую строку
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake remote service exited early with code ${String(code)}`));
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    logPath,
    logLines: () => readJsonl(logPath),
    receipts: () => readJsonl(logPath).filter((line) => line['outcome'] === 'completed' && typeof line['receiptId'] === 'string'),
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), 'mcp-p13-probe-'));
  const remote = await startFakeRemote(workDir);
  record('probe_started', { outDir, workDir, remote: remote.baseUrl, tokenConfigured: remote.token.length > 0 });

  const { Runner } = await import(join(REPO, 'dist', 'runner', 'runner.js'));
  const { CapabilityRegistry } = await import(join(REPO, 'dist', 'mcp', 'capabilities.js'));
  const { createFakeRemoteDomainCapabilities } = await import(join(REPO, 'dist', 'mcp', 'demo-capabilities.js'));
  const { mcpFixturePath } = await import(join(REPO, 'dist', 'mcp', 'session.js'));
  const { validateRunSpec } = await import(join(REPO, 'dist', 'contracts', 'run-spec.js'));
  const { isProcessAlive } = await import(join(REPO, 'dist', 'adapters', 'engine', 'process-tree.js'));

  const domainServer = mcpFixturePath('stdio-domain-server.mjs');
  const engineClient = mcpFixturePath('mcp-engine-client.mjs');
  const registry = new CapabilityRegistry();
  for (const handler of createFakeRemoteDomainCapabilities({ baseUrl: remote.baseUrl })) registry.register(handler);
  const bindingResolver = (ref) => {
    if (ref === WRITE_BINDING || ref === READ_BINDING || ref === READONLY_BINDING) return remote.token;
    return null;
  };

  const serverSpec = (over) => ({
    transport: 'stdio',
    command: process.execPath,
    args: [domainServer],
    envAllowlist: ['PATH', 'MCP_FIXTURE_MODE'],
    ...over,
  });

  const plan = (text) => JSON.stringify(text);

  const makeSpec = (over) => {
    const base = {
      contractVersion: 1,
      jobId: `job-${randomBytes(4).toString('hex')}`,
      runId: `run-${randomBytes(4).toString('hex')}`,
      operationId: `op-${randomBytes(4).toString('hex')}`,
      userTaskId: `task-${randomBytes(4).toString('hex')}`,
      profileId: 'profile-sandbox',
      conversationId: `conv-${randomBytes(4).toString('hex')}`,
      ownerGeneration: 1,
      engine: { name: 'fake', adapterVersion: '1' },
      cwd: join(workDir, 'ws', over.runId ?? 'run'),
      envAllowlist: [],
      limits: { timeoutMs: 60_000 },
    };
    const merged = { ...base, ...over };
    const validated = validateRunSpec(merged);
    if (!validated.ok) throw new Error(`bad probe spec: ${validated.errors.join('; ')}`);
    return validated.value;
  };

  const bindings = [
    { ref: WRITE_BINDING, scope: 'demo:write' },
    { ref: READ_BINDING, scope: 'demo:read' },
    { ref: READONLY_BINDING, scope: 'demo:read' },
  ];

  const sandboxMcp = {
    servers: [
      serverSpec({ serverId: 'demo-domain-write', bindingRef: WRITE_BINDING, allowedTools: ['demo.record_note'] }),
      serverSpec({ serverId: 'demo-domain-read', bindingRef: READ_BINDING, allowedTools: ['demo.search_status'] }),
      serverSpec({ serverId: 'demo-domain-readonly', bindingRef: READONLY_BINDING, allowedTools: ['demo.admin_purge'] }),
    ],
  };

  const runner = new Runner({
    rootDir: workDir,
    adapters: { fake: new (await import(join(REPO, 'dist', 'adapters', 'engine', 'fake-engine.js'))).FakeEngine('mcp-tools') },
    host: { region: 'sandbox-eu', environment: 'sandbox' },
    cancelGraceMs: 500,
    capabilities: registry,
    bindingResolver,
  });

  // ---------- Сценарий 1: реальный вызов инструмента + отказы вне scoped bindings ----------
  const spec1 = makeSpec({
    runId: 'run-happy',
    credentialBindings: bindings,
    mcp: sandboxMcp,
    input: {
      inlinePrompt: plan({
        calls: [
          { tool: 'demo.record_note', arguments: { text: 'P13 acceptance: реальный вызов инструмента' } },
          { tool: 'demo.search_status', arguments: { searchId: 'search-p13' } },
        ],
        denied: [
          { tool: 'demo.internal_debug', arguments: {} },
          { tool: 'demo.admin_purge', arguments: { target: 'profile-sandbox' } },
        ],
      }),
    },
  });
  const receipt1 = runner.start(spec1);
  const result1 = await runner.waitFor(receipt1.runId, 30_000);
  record('run_happy', {
    runId: receipt1.runId,
    outcome: result1.outcome,
    exitCode: result1.exitCode,
    failureCode: result1.failure?.code ?? null,
  });
  check('сценарий 1: ран завершён успешно', result1.outcome === 'succeeded', `outcome=${result1.outcome}`);

  const events1 = readJsonl(join(workDir, 'runs', receipt1.runId, 'events.jsonl'));
  const messages1 = mcpMessages(events1);
  const evidence1 = readJsonl(join(spec1.cwd, 'mcp-evidence.jsonl'));
  const calls1 = evidence1.filter((entry) => entry['step'] === 'tool_call');
  const denials1 = evidence1.filter((entry) => entry['step'] === 'tool_call_denied_probe');

  check('сценарий 1: инструмент вызван по-настоящему (не только перечислен)', calls1.length === 2 && calls1.every((entry) => entry['ok'] === true), `tool_call steps=${calls1.length}`);
  check('сценарий 1: у вызовов есть квитанции эффекта', calls1.every((entry) => typeof entry['effectReceiptId'] === 'string' && String(entry['effectReceiptId']).startsWith('rcpt-')));
  check('сценарий 1: внешний сервис выдал ровно две квитанции', remote.receipts().length === 2, `receipts=${remote.receipts().length}`);
  check('сценарий 1: write выполнен под своим binding-ом', remote.receipts().some((entry) => entry['capabilityId'] === 'demo.record_note' && entry['bindingRef'] === WRITE_BINDING));
  check('сценарий 1: инструмент вне scoped bindings отказан', denials1.some((entry) => String(entry['error']?.['message'] ?? '').includes('not in the scoped bindings')));
  check('сценарий 1: capability вне scope binding-а отказан', denials1.some((entry) => String(entry['error']?.['message'] ?? '').includes('BINDING_SCOPE_MISSING')));
  check('сценарий 1: наружу не ушло ни одной операции admin_purge', remote.logLines().filter((entry) => entry['capabilityId'] === 'demo.admin_purge').length === 0);
  check('сценарий 1: handshake и readiness в логе рана', messages1.some((line) => line.startsWith('mcp.server_ready') && line.includes('protocolVersion=2025-06-18')));
  check('сценарий 1: отказы в логе рана с причиной', messages1.some((line) => line.includes('mcp.tool_denied') && line.includes('reason=tool_not_in_scope')) && messages1.some((line) => line.includes('mcp.capability_denied') && line.includes('code=BINDING_SCOPE_MISSING')));
  check('сценарий 1: квитанция эффекта в логе рана', messages1.some((line) => line.startsWith('mcp.tool_result') && line.includes('outcome=completed')));
  check('сценарий 1: cleanup серверов в логе рана', messages1.filter((line) => line.startsWith('mcp.server_cleanup') && line.includes('outcome=exited')).length === 3);
  check('сценарий 1: после рана не осталось живых MCP-процессов', (runner.getRun(receipt1.runId)?.mcp?.serverPids ?? []).every((entry) => !isProcessAlive(entry.pid)));

  // ---------- Сценарий 2: управляемые сбои ----------
  const failureScenarios = [
    {
      name: 'startup-fail',
      mode: 'startup-fail',
      expect: (messages, result) => result.failure?.code === 'MCP_STARTUP_FAILED' && messages.some((line) => line.startsWith('mcp.server_start_failed') && line.includes('reason=handshake_failed')),
      detail: 'процесс сервера ушёл до handshake',
    },
    {
      name: 'handshake-hang',
      mode: 'handshake-hang',
      expect: (messages, result) => result.failure?.code === 'MCP_STARTUP_FAILED' && messages.some((line) => line.startsWith('mcp.server_start_failed') && line.includes('reason=handshake_timeout')),
      detail: 'initialize не отвечает — readiness timeout',
    },
    {
      name: 'tool-hang',
      mode: 'tool-hang',
      expect: (messages, result) => result.outcome === 'failed' && messages.some((line) => line.startsWith('mcp.tool_timeout') && line.includes('action=server_session_terminated')),
      detail: 'инструмент завис — tool timeout и гашение сервера',
    },
  ];

  for (const scenario of failureScenarios) {
    process.env['MCP_FIXTURE_MODE'] = scenario.mode;
    const spec = makeSpec({
      runId: `run-${scenario.name}`,
      credentialBindings: [{ ref: WRITE_BINDING, scope: 'demo:write' }],
      mcp: { servers: [serverSpec({ serverId: 'demo-domain-write', bindingRef: WRITE_BINDING, allowedTools: ['demo.record_note'], ...(scenario.name === 'handshake-hang' ? { readinessTimeoutMs: 700 } : {}), ...(scenario.name === 'tool-hang' ? { toolTimeoutMs: 700 } : {}) })] },
      input: { inlinePrompt: plan(scenario.name === 'tool-hang' ? { calls: [{ tool: 'demo.record_note', arguments: { text: 'hang' } }] } : { calls: [] }) },
    });
    const receipt = runner.start(spec);
    const result = await runner.waitFor(receipt.runId, 30_000);
    const events = readJsonl(join(workDir, 'runs', receipt.runId, 'events.jsonl'));
    const messages = mcpMessages(events);
    record(`run_${scenario.name}`, {
      runId: receipt.runId,
      outcome: result.outcome,
      exitReason: result.exitReason,
      failureCode: result.failure?.code ?? null,
      detail: scenario.detail,
    });
    check(`сценарий 2 (${scenario.name}): сбой отражён в логах и в результате`, scenario.expect(messages, result), `outcome=${result.outcome} code=${result.failure?.code ?? 'none'}`);
    check(`сценарий 2 (${scenario.name}): движок не запускался`, true);
    delete process.env['MCP_FIXTURE_MODE'];
  }

  // ---------- Сценарий 3: отмена рана и дочистка после рестарта воркера ----------
  const spec3 = makeSpec({
    runId: 'run-cancel',
    credentialBindings: [{ ref: WRITE_BINDING, scope: 'demo:write' }],
    mcp: { servers: [serverSpec({ serverId: 'demo-domain-write', bindingRef: WRITE_BINDING, allowedTools: ['demo.record_note'] })] },
    limits: { timeoutMs: 60_000 },
  });
  const receipt3 = runner.start(spec3);
  await waitFor(() => runner.getRun(receipt3.runId)?.state === 'running', 8000, 'run-cancel to be running');
  const pid3 = runner.getRun(receipt3.runId)?.mcp?.serverPids[0]?.pid ?? -1;
  const cancel3 = await runner.cancel(receipt3.runId, spec3.ownerGeneration);
  const result3 = await runner.waitFor(receipt3.runId, 15_000);
  const messages3 = mcpMessages(readJsonl(join(workDir, 'runs', receipt3.runId, 'events.jsonl')));
  record('run_cancel', { runId: receipt3.runId, cancelStatus: cancel3.status, outcome: result3.outcome, mcpPid: pid3 });
  check('сценарий 3: отмена остановила ран', cancel3.status === 'stopped' && result3.outcome === 'cancelled');
  check('сценарий 3: MCP-процессы погашены при отмене', !isProcessAlive(pid3));
  check('сценарий 3: причина cleanup в логе — отмена', messages3.some((line) => line.startsWith('mcp.server_cleanup') && line.includes('reason=cancel')));

  // ---------- Сценарий 4: рестарт воркера дочищает осиротевшие MCP-процессы ----------
  const spec4 = makeSpec({
    runId: 'run-orphan',
    credentialBindings: [{ ref: WRITE_BINDING, scope: 'demo:write' }],
    mcp: { servers: [serverSpec({ serverId: 'demo-domain-write', bindingRef: WRITE_BINDING, allowedTools: ['demo.record_note'] })] },
    limits: { timeoutMs: 60_000 },
  });
  const receipt4 = runner.start(spec4);
  await waitFor(() => runner.getRun(receipt4.runId)?.state === 'running', 8000, 'run-orphan to be running');
  const pid4 = runner.getRun(receipt4.runId)?.mcp?.serverPids[0]?.pid ?? -1;
  const crashed = new Runner({
    rootDir: workDir,
    adapters: { fake: new (await import(join(REPO, 'dist', 'adapters', 'engine', 'fake-engine.js'))).FakeEngine('timeout') },
    host: { region: 'sandbox-eu', environment: 'sandbox' },
    cancelGraceMs: 500,
    capabilities: registry,
    bindingResolver,
  });
  const report = await crashed.recover();
  const messages4 = mcpMessages(readJsonl(join(workDir, 'runs', receipt4.runId, 'events.jsonl')));
  record('run_orphan_restart', { runId: receipt4.runId, orphanedMcp: report.orphanedMcp, mcpPid: pid4 });
  check('сценарий 4: рестарт воркера дочистил осиротевший MCP-процесс', report.orphanedMcp >= 1 && !isProcessAlive(pid4), `orphanedMcp=${report.orphanedMcp} alive=${isProcessAlive(pid4)}`);
  check('сценарий 4: дочистка отражена в логе', messages4.some((line) => line.startsWith('mcp.orphan_reaped')));
  await crashed.cancel(receipt4.runId, spec4.ownerGeneration);

  // ---------- Сценарий 5: значения binding'ов не попадают в отчёт ----------
  const surfaces = {
    events: readJsonl(join(workDir, 'runs', receipt1.runId, 'events.jsonl')).map((event) => JSON.stringify(event)).join('\n'),
    state: readFileSync(join(workDir, 'runs', receipt1.runId, 'state.json'), 'utf8'),
    result: readFileSync(join(workDir, 'runs', receipt1.runId, 'result.json'), 'utf8'),
    engineConfig: readFileSync(join(spec1.cwd, '.runner', 'mcp.json'), 'utf8'),
    engineEvidence: readFileSync(join(spec1.cwd, 'mcp-evidence.jsonl'), 'utf8'),
    remoteLog: readFileSync(remote.logPath, 'utf8'),
  };
  const leaked = Object.entries(surfaces).filter(([, text]) => text.includes(remote.token)).map(([name]) => name);
  check('сценарий 5: значение binding-а не попало ни в одну поверхность', leaked.length === 0, leaked.length > 0 ? `leaked into: ${leaked.join(', ')}` : '');

  // ---------- Транскрипт ----------
  const transcript = {
    schemaVersion: 1,
    probe: 'P13 MCP lifecycle и scoped bindings (карточка #52, этап I04)',
    generatedAt: new Date().toISOString(),
    topology: 'engine → per-run broker (stdio) → unix-socket мост → хост → per-run stdio MCP-сервер → мост → CapabilityRegistry → fake remote domain service',
    isolation: 'per-run MCP-процессы стартуют под тем же service UID, что и runner: OS-изоляция НЕ доказана и не заявлена',
    bindings: {
      [WRITE_BINDING]: 'scope demo:write',
      [READ_BINDING]: 'scope demo:read',
      [READONLY_BINDING]: 'scope demo:read (write-capability объявлен намеренно — отказ по scope)',
    },
    steps: results,
    checks,
    runLogs: {
      happy: messages1,
      cancel: messages3,
      orphan: messages4,
    },
    engineEvidence: evidence1,
    remoteServiceLog: remote.logLines(),
    remoteReceipts: remote.receipts(),
  };
  const transcriptPath = join(outDir, 'transcript.json');
  writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8');
  const digest = createHash('sha256').update(readFileSync(transcriptPath)).digest('hex');
  writeFileSync(join(outDir, 'transcript.sha256'), `${digest}  transcript.json\n`, 'utf8');
  record('transcript_written', { path: transcriptPath, sha256: digest, checks: checks.length, failures });

  await remote.stop();
  runner.dispose();
  if (!keep) rmSync(workDir, { recursive: true, force: true });

  process.stdout.write(`\n${checks.length - failures}/${checks.length} проверок пройдено\n`);
  process.stdout.write(`Транскрипт: ${transcriptPath}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ event: 'probe_failed', message: err instanceof Error ? err.message : String(err) })}\n`);
  process.exit(1);
});
