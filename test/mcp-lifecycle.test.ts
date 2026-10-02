import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProcessAlive } from '../src/adapters/engine/process-tree.js';
import { validateRunSpec, type McpServerSpec, type RunSpec } from '../src/contracts/run-spec.js';
import { CapabilityError, CapabilityRegistry } from '../src/mcp/capabilities.js';
import { McpRunScope, McpScopeError } from '../src/mcp/scope.js';
import { createHarness, makeRunSpec, waitFor } from './helpers.js';
import { demoRegistry, fixtureBindingResolver, logMessages, mcpPlan, mcpServer, startFakeRemote, type FakeRemote } from './mcp-helpers.js';

const WRITE_BINDING = 'cred:demo-domain-write';
const READ_BINDING = 'cred:demo-domain-read';
/** Binding только на чтение, которому ран зачем-то декларирует write-capability. */
const READONLY_BINDING = 'cred:demo-domain-readonly';

function bindings(): RunSpec['credentialBindings'] {
  return [
    { ref: WRITE_BINDING, scope: 'demo:write' },
    { ref: READ_BINDING, scope: 'demo:read' },
    { ref: READONLY_BINDING, scope: 'demo:read' },
  ];
}

/**
 * Песочный расклад I04: три per-run MCP-сервера, у каждого свой credential binding.
 * Имена инструментов уникальны в пределах рана (плоское пространство имён MCP), а
 * `demo-domain-readonly` декларирует write-capability под read-only binding'ом — именно
 * этот вызов обязан быть отказан.
 */
function sandboxServers(): McpServerSpec[] {
  return [
    mcpServer({ serverId: 'demo-domain-write', bindingRef: WRITE_BINDING, allowedTools: ['demo.record_note'] }),
    mcpServer({ serverId: 'demo-domain-read', bindingRef: READ_BINDING, allowedTools: ['demo.search_status'] }),
    mcpServer({ serverId: 'demo-domain-readonly', bindingRef: READONLY_BINDING, allowedTools: ['demo.admin_purge'] }),
  ];
}

function sandboxMcp(): RunSpec['mcp'] {
  return { servers: sandboxServers() };
}

async function withRemote<T>(fn: (remote: FakeRemote) => Promise<T>): Promise<T> {
  const remote = await startFakeRemote();
  try {
    return await fn(remote);
  } finally {
    await remote.stop();
  }
}

describe('mcp lifecycle: контракт RunSpec (P13)', () => {
  it('группа mcp принимается, а объявленный вне contract набор полей отвергается', () => {
    const valid = makeRunSpec({ mcp: sandboxMcp(), credentialBindings: bindings() });
    expect(valid.mcp?.servers).toHaveLength(3);
    expect(valid.mcp?.servers[0]?.bindingRef).toBe(WRITE_BINDING);

    const base = { ...makeRunSpec({ credentialBindings: bindings() }), mcp: sandboxMcp() };
    const first = sandboxServers()[0] as McpServerSpec;
    const withSecret = validateRunSpec({
      ...base,
      mcp: { servers: [{ ...first, bindingValue: 'plain-token' }] },
    });
    expect(withSecret.ok).toBe(false);
    expect(withSecret.ok ? [] : withSecret.errors.join('; ')).toContain('bindingValue');

    const remoteTransport = validateRunSpec({ ...base, mcp: { servers: [{ ...first, transport: 'http' }] } });
    expect(remoteTransport.ok).toBe(false);
    expect(remoteTransport.ok ? [] : remoteTransport.errors.join('; ')).toContain('expected "stdio"');

    const noTools = validateRunSpec({ ...base, mcp: { servers: [{ ...first, allowedTools: [] }] } });
    expect(noTools.ok).toBe(false);

    const duplicate = validateRunSpec({ ...base, mcp: { servers: [first, first] } });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.ok ? [] : duplicate.errors.join('; ')).toContain('duplicate serverId');
  });

  it('bindingRef должен быть объявлен в credentialBindings рана', () => {
    const result = validateRunSpec({
      ...makeRunSpec(),
      credentialBindings: [{ ref: READ_BINDING, scope: 'demo:read' }],
      mcp: { servers: [mcpServer({ serverId: 'demo-domain-write', bindingRef: WRITE_BINDING, allowedTools: ['demo.record_note'] })] },
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join('; ')).toContain(`"${WRITE_BINDING}" is not declared in spec.credentialBindings`);
  });

  it('McpRunScope отказывает по binding-ам (не объявлен / missing / expired) и по инструментам вне scope', () => {
    const spec = makeRunSpec({ mcp: sandboxMcp(), credentialBindings: bindings() });
    const scope = McpRunScope.fromSpec(spec, () => 'value');
    expect(scope.authorizeTool('demo-domain-write', 'demo.record_note').allowed).toBe(true);
    const denied = scope.authorizeTool('demo-domain-write', 'demo.admin_purge');
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.reason).toBe('tool_not_in_scope');
    const unknown = scope.authorizeTool('demo-domain-other', 'demo.record_note');
    expect(unknown.allowed === false && unknown.reason).toBe('unknown_server');

    const expired = makeRunSpec({
      mcp: { servers: [mcpServer({ serverId: 'demo-domain-write', bindingRef: WRITE_BINDING, allowedTools: ['demo.record_note'] })] },
      credentialBindings: [{ ref: WRITE_BINDING, scope: 'demo:write', status: 'expired' }],
    });
    expect(() => McpRunScope.fromSpec(expired)).toThrowError(McpScopeError);
    try {
      McpRunScope.fromSpec(expired);
    } catch (err) {
      expect((err as McpScopeError).code).toBe('MCP_BINDING_EXPIRED');
    }
  });

  it('CapabilityRegistry: неизвестная capability, scope и обязательные аргументы проверяются до эффекта', async () => {
    const calls: string[] = [];
    const registry = new CapabilityRegistry().register({
      capabilityId: 'demo.write',
      capabilityVersion: 1,
      requiredScopes: ['demo:write'],
      requiredArguments: ['text'],
      effect: 'write',
      description: 'test',
      async invoke() {
        calls.push('invoked');
        return { kind: 'completed', result: {}, effectReceipt: { receiptId: 'r1', capabilityId: 'demo.write', capabilityVersion: 1, operationId: 'op', bindingRef: 'cred', at: 'now' } };
      },
    });

    await expect(registry.invoke({ capabilityId: 'demo.nope', arguments: {}, caller: caller() })).rejects.toBeInstanceOf(CapabilityError);
    await expect(
      registry.invoke({ capabilityId: 'demo.write', arguments: { text: 'x' }, caller: caller(), binding: { ref: 'cred', scope: 'demo:read' } }),
    ).rejects.toMatchObject({ code: 'BINDING_SCOPE_MISSING' });
    const missing = await registry.invoke({ capabilityId: 'demo.write', arguments: {}, caller: caller(), binding: { ref: 'cred', scope: 'demo:write' } });
    expect(missing).toEqual({ kind: 'missing_input', fields: ['text'] });
    expect(calls).toEqual([]);
  });
});

describe('mcp lifecycle: реальный вызов инструмента и scoped bindings (P13, AC-115)', () => {
  it(
    'инструмент вызван по-настоящему: handshake, вызов, receipt внешнего сервиса, отказы вне scope',
    async () => {
      await withRemote(async (remote) => {
        const harness = createHarness({
          scenario: 'mcp-tools',
          capabilities: demoRegistry(remote.baseUrl),
          bindingResolver: fixtureBindingResolver({ [WRITE_BINDING]: remote.token, [READ_BINDING]: remote.token, [READONLY_BINDING]: remote.token }),
        });
        const plan = mcpPlan({
          calls: [
            { tool: 'demo.record_note', arguments: { text: 'P13 acceptance note' } },
            { tool: 'demo.search_status', arguments: { searchId: 'search-1' } },
          ],
          denied: [
            // инструмент, который сервер предлагает, но ран не декларирует
            { tool: 'demo.internal_debug', arguments: {} },
            // write-capability под read-only binding'ом: отказ по scope binding'а
            { tool: 'demo.admin_purge', arguments: { target: 'profile-a' } },
          ],
        });
        const { receipt, spec } = harness.start({
          credentialBindings: bindings(),
          mcp: sandboxMcp(),
          input: { inlinePrompt: plan },
        });

        const result = await harness.runner.waitFor(receipt.runId, 25_000);
        expect(result.outcome).toBe('succeeded');
        expect(result.exitCode).toBe(0);

        // 1. Инструмент реально вызван: доказательство — след фикстуры двигателя и квитанция.
        const evidence = readFileSync(join(spec.cwd, 'mcp-evidence.jsonl'), 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const callSteps = evidence.filter((entry) => entry['step'] === 'tool_call');
        expect(callSteps).toHaveLength(2);
        expect(callSteps.every((entry) => entry['ok'] === true)).toBe(true);
        expect(callSteps.every((entry) => typeof entry['effectReceiptId'] === 'string')).toBe(true);

        const listStep = evidence.find((entry) => entry['step'] === 'tools_list');
        const listed = ((listStep?.['tools'] as Array<Record<string, unknown>>) ?? []).map((tool) => tool['name']).sort();
        expect(listed).toEqual(['demo.admin_purge', 'demo.record_note', 'demo.search_status']);
        // инструмент вне объявления рана наружу не выдаётся вообще
        expect(listed).not.toContain('demo.internal_debug');

        // 2. Внешний сервис видел реальные операции и выдал квитанции эффекта.
        const receipts = remote.receipts();
        expect(receipts).toHaveLength(2);
        const writeReceipt = receipts.find((entry) => entry['capabilityId'] === 'demo.record_note');
        expect(writeReceipt).toMatchObject({ bindingRef: WRITE_BINDING, profileId: 'profile-a' });
        expect(String(writeReceipt?.['externalRef'])).toMatch(/^note-/);

        // 3. Чужой binding недоступен: отказ по scope binding'а — до исходящего вызова,
        //    и внешний сервис такой вызов тоже отклонил бы (проба напрямую).
        const denials = evidence.filter((entry) => entry['step'] === 'tool_call_denied_probe');
        expect(denials).toHaveLength(2);
        expect(denials.every((entry) => entry['ok'] === true)).toBe(true);
        const scopeDenial = denials.find((entry) => {
          const error = entry['error'] as Record<string, unknown> | null;
          return String(error?.['message'] ?? entry['text'] ?? '').includes('BINDING_SCOPE_MISSING');
        });
        expect(scopeDenial).toBeDefined();
        const outOfScope = denials.find((entry) => String((entry['error'] as Record<string, unknown> | null)?.['message'] ?? '').includes('not in the scoped bindings'));
        expect(outOfScope).toBeDefined();
        // наружу не ушло ни одной операции по admin_purge
        expect(remote.logLines().filter((entry) => entry['capabilityId'] === 'demo.admin_purge')).toHaveLength(0);
        const direct = await fetch(`${remote.baseUrl}/v1/domain?capability=demo.admin_purge`, {
          method: 'POST',
          headers: { authorization: `Bearer ${remote.token}`, 'x-binding-ref': READONLY_BINDING, 'x-binding-scope': 'demo:read' },
          body: JSON.stringify({ target: 'profile-a' }),
        });
        expect(direct.status).toBe(403);
        expect(((await direct.json()) as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');

        // 4. Логи рана: readiness/handshake/invocation/receipt/cleanup + отказы с причиной.
        const messages = logMessages(harness.rootDir, receipt.runId);
        expect(messages.some((line) => line.startsWith('mcp.server_ready') && line.includes('serverId=demo-domain-write') && line.includes('bindingScope=demo:write'))).toBe(true);
        expect(messages.some((line) => line.startsWith('mcp.server_ready') && line.includes('isolation=same_service_uid_not_os_isolated'))).toBe(true);
        expect(messages.some((line) => line.startsWith('mcp.tool_invoked') && line.includes('tool=demo.record_note'))).toBe(true);
        expect(messages.some((line) => line.startsWith('mcp.tool_result') && line.includes('outcome=completed'))).toBe(true);
        expect(messages.some((line) => line.includes('mcp.tool_denied') && line.includes('reason=tool_not_in_scope'))).toBe(true);
        expect(messages.some((line) => line.includes('mcp.capability_denied') && line.includes('code=BINDING_SCOPE_MISSING'))).toBe(true);
        expect(messages.filter((line) => line.startsWith('mcp.server_cleanup') && line.includes('outcome=exited')).length).toBeGreaterThanOrEqual(2);
        expect(messages.some((line) => line.startsWith('mcp.session_cleanup'))).toBe(true);
      });
    },
    45_000,
  );

  it(
    'значения binding-ов не попадают ни в spec, ни в state, ни в логи, ни в конфиг движка',
    async () => {
      await withRemote(async (remote) => {
        const harness = createHarness({
          scenario: 'mcp-tools',
          capabilities: demoRegistry(remote.baseUrl),
          bindingResolver: fixtureBindingResolver({ [WRITE_BINDING]: remote.token, [READ_BINDING]: remote.token, [READONLY_BINDING]: remote.token }),
        });
        const { receipt, spec } = harness.start({
          credentialBindings: bindings(),
          mcp: sandboxMcp(),
          input: { inlinePrompt: mcpPlan({ calls: [{ tool: 'demo.record_note', arguments: { text: 'secret check' } }] }) },
        });
        const result = await harness.runner.waitFor(receipt.runId, 25_000);
        expect(result.outcome).toBe('succeeded');

        const surfaces = [
          readFileSync(join(harness.rootDir, 'runs', receipt.runId, 'events.jsonl'), 'utf8'),
          readFileSync(join(harness.rootDir, 'runs', receipt.runId, 'state.json'), 'utf8'),
          readFileSync(join(harness.rootDir, 'runs', receipt.runId, 'result.json'), 'utf8'),
          readFileSync(join(spec.cwd, '.runner', 'mcp.json'), 'utf8'),
          readFileSync(join(spec.cwd, 'mcp-evidence.jsonl'), 'utf8'),
        ];
        for (const surface of surfaces) expect(surface).not.toContain(remote.token);
        // Конфиг движка: команды + координаты локального моста. Значений binding-ов там нет,
        // и он не является изоляционной границей — broker спавнится движком из того же
        // пользователя (см. docs/MCP-LIFECYCLE.md).
        const engineConfig = JSON.parse(readFileSync(join(spec.cwd, '.runner', 'mcp.json'), 'utf8')) as Record<string, unknown>;
        expect(Object.keys(engineConfig).sort()).toEqual(['bridge', 'broker', 'runId', 'serverIds']);
        expect(JSON.stringify(engineConfig)).not.toContain('cred:demo-domain-write');
        const bridge = engineConfig['bridge'] as { url: string; runToken: string };
        expect(bridge.url).toMatch(/^unix:\/\//);
        expect(bridge.runToken).not.toBe(remote.token);
      });
    },
    45_000,
  );
});

describe('mcp lifecycle: управляемые сбои видны в логах (P13)', () => {
  it(
    'упавший старт MCP-сервера валит старт рана и попадает в лог с причиной',
    async () => {
      await withRemote(async (remote) => {
        const harness = createHarness({
          scenario: 'mcp-tools',
          capabilities: demoRegistry(remote.baseUrl),
          bindingResolver: fixtureBindingResolver({ [WRITE_BINDING]: remote.token }),
        });
        process.env['MCP_FIXTURE_MODE'] = 'startup-fail';
        try {
          const { receipt } = harness.start({
            credentialBindings: [{ ref: WRITE_BINDING, scope: 'demo:write' }],
            mcp: { servers: [mcpServer({ serverId: 'demo-domain-write', bindingRef: WRITE_BINDING, allowedTools: ['demo.record_note'] })] },
            input: { inlinePrompt: mcpPlan({ calls: [] }) },
          });
          const result = await harness.runner.waitFor(receipt.runId, 20_000);
          expect(result.outcome).toBe('failed');
          expect(result.exitReason).toBe('startup_failure');
          expect(result.failure).toMatchObject({ code: 'MCP_STARTUP_FAILED', failureClass: 'runtime' });
          // движок не запускался вообще
          expect(harness.fake.startCalls).toBe(0);

          const messages = logMessages(harness.rootDir, receipt.runId);
          const failure = messages.find((line) => line.startsWith('mcp.server_start_failed'));
          expect(failure).toBeDefined();
          expect(failure).toContain('serverId=demo-domain-write');
          expect(failure).toContain('reason=handshake_failed');
          expect(messages.some((line) => line.startsWith('mcp.server_cleanup'))).toBe(true);
          expect(harness.runner.getRun(receipt.runId)?.mcp).toBeNull();
        } finally {
          delete process.env['MCP_FIXTURE_MODE'];
        }
      });
    },
    40_000,
  );

  it(
    'сервер без handshake гасится по readiness timeout, причина — в логе',
    async () => {
      await withRemote(async (remote) => {
        const harness = createHarness({
          scenario: 'mcp-tools',
          capabilities: demoRegistry(remote.baseUrl),
          bindingResolver: fixtureBindingResolver({ [WRITE_BINDING]: remote.token }),
        });
        process.env['MCP_FIXTURE_MODE'] = 'handshake-hang';
        try {
          const { receipt } = harness.start({
            credentialBindings: [{ ref: WRITE_BINDING, scope: 'demo:write' }],
            mcp: {
              servers: [
                mcpServer({ serverId: 'demo-domain-write', bindingRef: WRITE_BINDING, allowedTools: ['demo.record_note'], readinessTimeoutMs: 700 }),
              ],
            },
            input: { inlinePrompt: mcpPlan({ calls: [] }) },
          });
          const result = await harness.runner.waitFor(receipt.runId, 20_000);
          expect(result.outcome).toBe('failed');
          expect(result.failure?.code).toBe('MCP_STARTUP_FAILED');
          const messages = logMessages(harness.rootDir, receipt.runId);
          expect(messages.some((line) => line.startsWith('mcp.server_start_failed') && line.includes('reason=handshake_timeout'))).toBe(true);
          const cleanup = messages.find((line) => line.startsWith('mcp.server_cleanup'));
          expect(cleanup).toContain('alive=false');
        } finally {
          delete process.env['MCP_FIXTURE_MODE'];
        }
      });
    },
    40_000,
  );

  it(
    'зависший инструмент даёт tool timeout, гасит сервер и не оставляет процесса',
    async () => {
      await withRemote(async (remote) => {
        const harness = createHarness({
          scenario: 'mcp-tools',
          capabilities: demoRegistry(remote.baseUrl),
          bindingResolver: fixtureBindingResolver({ [WRITE_BINDING]: remote.token }),
        });
        process.env['MCP_FIXTURE_MODE'] = 'tool-hang';
        try {
          const { receipt } = harness.start({
            credentialBindings: [{ ref: WRITE_BINDING, scope: 'demo:write' }],
            mcp: {
              servers: [
                mcpServer({
                  serverId: 'demo-domain-write',
                  bindingRef: WRITE_BINDING,
                  allowedTools: ['demo.record_note'],
                  toolTimeoutMs: 700,
                  readinessTimeoutMs: 5000,
                }),
              ],
            },
            input: { inlinePrompt: mcpPlan({ calls: [{ tool: 'demo.record_note', arguments: { text: 'hang' } }] }) },
          });
          const pid = await waitForPid(harness, receipt.runId);
          const result = await harness.runner.waitFor(receipt.runId, 25_000);
          expect(result.outcome).toBe('failed');

          const messages = logMessages(harness.rootDir, receipt.runId);
          const timeoutLine = messages.find((line) => line.startsWith('mcp.tool_timeout'));
          expect(timeoutLine).toContain('tool=demo.record_note');
          expect(timeoutLine).toContain('action=server_session_terminated');
          await waitFor(() => !isProcessAlive(pid), 5000, 'mcp server process to die');
          expect(isProcessAlive(pid)).toBe(false);
        } finally {
          delete process.env['MCP_FIXTURE_MODE'];
        }
      });
    },
    45_000,
  );

  it(
    'отмена рана гасит MCP-процессы',
    async () => {
      await withRemote(async (remote) => {
        const harness = createHarness({
          scenario: 'timeout',
          capabilities: demoRegistry(remote.baseUrl),
          bindingResolver: fixtureBindingResolver({ [WRITE_BINDING]: remote.token }),
        });
        const spec = harness.makeSpec({
          credentialBindings: [{ ref: WRITE_BINDING, scope: 'demo:write' }],
          mcp: { servers: [mcpServer({ serverId: 'demo-domain-write', bindingRef: WRITE_BINDING, allowedTools: ['demo.record_note'] })] },
          limits: { timeoutMs: 60_000 },
        });
        const receipt = harness.runner.start(spec);
        await waitFor(() => harness.runner.getRun(receipt.runId)?.state === 'running', 8000, 'run to be running');
        const pid = await waitForPid(harness, receipt.runId);
        const cancel = await harness.runner.cancel(receipt.runId, spec.ownerGeneration);
        expect(cancel.status).toBe('stopped');
        const result = await harness.runner.waitFor(receipt.runId, 10_000);
        expect(result.outcome).toBe('cancelled');
        await waitFor(() => !isProcessAlive(pid), 5000, 'mcp server process to die');
        const messages = logMessages(harness.rootDir, receipt.runId);
        expect(messages.some((line) => line.startsWith('mcp.server_cleanup') && line.includes('reason=cancel'))).toBe(true);
      });
    },
    40_000,
  );

  it(
    'рестарт воркера дочищает осиротевшие per-run MCP-процессы',
    async () => {
      await withRemote(async (remote) => {
        const harness = createHarness({
          scenario: 'timeout',
          capabilities: demoRegistry(remote.baseUrl),
          bindingResolver: fixtureBindingResolver({ [WRITE_BINDING]: remote.token }),
        });
        const spec = harness.makeSpec({
          credentialBindings: [{ ref: WRITE_BINDING, scope: 'demo:write' }],
          mcp: { servers: [mcpServer({ serverId: 'demo-domain-write', bindingRef: WRITE_BINDING, allowedTools: ['demo.record_note'] })] },
          limits: { timeoutMs: 60_000 },
        });
        const receipt = harness.runner.start(spec);
        await waitFor(() => harness.runner.getRun(receipt.runId)?.state === 'running', 8000, 'run to be running');
        const pid = await waitForPid(harness, receipt.runId);
        expect(isProcessAlive(pid)).toBe(true);

        // воркер упал: новый процесс читает тот же state.json и дочищает MCP-процессы
        harness.reopenWithoutDispose();
        const report = await harness.runner.recover();
        expect(report.orphanedMcp).toBeGreaterThanOrEqual(1);
        await waitFor(() => !isProcessAlive(pid), 5000, 'orphaned mcp server to die');
        expect(isProcessAlive(pid)).toBe(false);
        const messages = logMessages(harness.rootDir, receipt.runId);
        expect(messages.some((line) => line.startsWith('mcp.orphan_reaped'))).toBe(true);
        await harness.runner.cancel(receipt.runId, spec.ownerGeneration);
      });
    },
    45_000,
  );

  it(
    'инструмент без значения binding-а не поднимается: сервер refused до спавна',
    async () => {
      const harness = createHarness({
        scenario: 'mcp-tools',
        capabilities: new CapabilityRegistry(),
        bindingResolver: () => null,
      });
      const { receipt } = harness.start({
        credentialBindings: [{ ref: WRITE_BINDING, scope: 'demo:write' }],
        mcp: { servers: [mcpServer({ serverId: 'demo-domain-write', bindingRef: WRITE_BINDING, allowedTools: ['demo.record_note'] })] },
        input: { inlinePrompt: mcpPlan({ calls: [] }) },
      });
      const result = await harness.runner.waitFor(receipt.runId, 15_000);
      expect(result.outcome).toBe('failed');
      expect(result.failure?.code).toBe('MCP_STARTUP_FAILED');
      const messages = logMessages(harness.rootDir, receipt.runId);
      expect(messages.some((line) => line.startsWith('mcp.binding_unavailable') && line.includes(`bindingRef=${WRITE_BINDING}`))).toBe(true);
      expect(messages.some((line) => line.startsWith('mcp.server_spawned'))).toBe(false);
    },
    30_000,
  );
});

function caller(): { principalId: string; profileId: string; userTaskId: string; runId: string | null; operationId: string } {
  return { principalId: 'p-test', profileId: 'profile-a', userTaskId: 'task-test', runId: null, operationId: 'op-test' };
}

async function waitForPid(harness: ReturnType<typeof createHarness>, runId: string): Promise<number> {
  let pid = -1;
  await waitFor(
    () => {
      pid = harness.runner.getRun(runId)?.mcp?.serverPids[0]?.pid ?? -1;
      return pid > 0;
    },
    8000,
    'mcp server pid in run state',
  );
  return pid;
}
