import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, waitFor } from './helpers.js';
import { RecordingLauncher, StubCleanRoomProvider, eventTypes, listDir, logMessages, type StubProviderOptions } from './isolation-helpers.js';
import { demoRegistry, fixtureBindingResolver, logMessages as mcpLogMessages, mcpPlan, mcpServer, startFakeRemote } from './mcp-helpers.js';
import { validateRunSpec } from '../src/contracts/run-spec.js';
import { AgentApi } from '../src/api/service.js';
import { FakeEngine } from '../src/adapters/engine/fake-engine.js';
import { OpenCodeAdapter } from '../src/adapters/engine/opencode-adapter.js';
import { createBlobStore } from '../src/storage/create-blob-store.js';
import { Runner } from '../src/runner/runner.js';
import type { CleanRoomProvider } from '../src/isolation/contract.js';
import type { Harness, HarnessOptions } from './helpers.js';

function events(rootDir: string, runId: string): Array<Record<string, unknown>> {
  const path = join(rootDir, 'runs', runId, 'events.jsonl');
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Харнесс с провайдером границы, у которого rootDir совпадает с rootDir харнесса:
 * иначе каталоги чистых сред и аренды оказываются в другом дереве, чем состояние ранов.
 */
function harnessWith(
  launcher: RecordingLauncher,
  options: { provider?: Partial<StubProviderOptions>; harness?: Omit<HarnessOptions, 'isolation'> } = {},
): { h: Harness; provider: StubCleanRoomProvider } {
  let provider!: StubCleanRoomProvider;
  const h = createHarness({
    ...options.harness,
    isolation: (rootDir: string) => {
      provider = new StubCleanRoomProvider({ ...options.provider, rootDir }, launcher);
      return provider;
    },
  });
  return { h, provider };
}

function apiFor(options: { rootDir: string; isolation?: CleanRoomProvider }): AgentApi {
  return new AgentApi({
    rootDir: options.rootDir,
    adapters: { fake: new FakeEngine('success'), opencode: new OpenCodeAdapter() },
    host: { region: 'sandbox-eu', environment: 'sandbox' },
    ...(options.isolation ? { isolation: options.isolation } : {}),
  });
}

describe('clean room isolation (issue #51)', () => {
  it('граница поднимается до движка: слот, run-scoped HOME, движок под идентичностью рана', async () => {
    const launcher = new RecordingLauncher();
    const { h, provider } = harnessWith(launcher);
    const { receipt, spec } = h.start();
    // Каталог рана — 0700 внутри чистой среды, без общего пользовательского конфига
    await waitFor(() => eventTypes(h.rootDir, receipt.runId).includes('isolation_prepared'));
    const roomRoot = join(h.rootDir, 'cleanrooms', receipt.runId);
    expect(statSync(roomRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(roomRoot, 'home')).mode & 0o777).toBe(0o700);

    const result = await h.runner.waitFor(receipt.runId);

    expect(result.outcome).toBe('succeeded');
    expect(result.failure).toBeUndefined();
    expect(result.cleanup).toBe('completed');

    expect(eventTypes(h.rootDir, receipt.runId)).toEqual([
      'claimed',
      'materialized',
      'isolation_prepared',
      'log',
      'started',
      'log',
      'log',
      'exit',
      'finalizing',
      'succeeded',
    ]);

    const prepared = events(h.rootDir, receipt.runId).find((event) => event['type'] === 'isolation_prepared');
    expect(prepared).toBeDefined();
    const payload = prepared?.['payload'] as Record<string, unknown>;
    expect(payload['slotId']).toBe('slot-a');
    expect(payload['uid']).toBe(40001);
    expect(payload['acl']).toBe('posix_0700');
    expect((payload['probe'] as Record<string, unknown>)['checks']).toBeGreaterThan(0);

    // Движок стартовал через лаунчер рана, а не напрямую
    const engineCalls = launcher.forCommand('ran.txt');
    expect(engineCalls).toHaveLength(1);
    expect(engineCalls[0]?.identity.slotId).toBe('slot-a');

    // run-scoped HOME/config/cache/tmp: движок видит только свою среду
    const envLine = logMessages(h.rootDir, receipt.runId).find((line) => line.startsWith('envkeys:'));
    expect(envLine).toBeDefined();
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) expect(envLine).toContain(name);
    expect(envLine).not.toContain('AIR_TEST_FORBIDDEN');

    // Аренда снята после проверенного sweep: слот свободен, каталогов рана нет
    expect(provider.freeSlots()).toEqual(['slot-a', 'slot-b']);
    expect(listDir(join(h.rootDir, 'cleanrooms'))).toEqual([]);
    expect(existsSync(spec.cwd)).toBe(false);
  });

  it('сломанная граница отказывает ДО спавна движка, без расширения прав', async () => {
    const launcher = new RecordingLauncher();
    const { h } = harnessWith(launcher, { provider: { probe: { ok: false, failures: ['sibling[run-b].cwd_denied:allowed'] } } });
    const { receipt, spec } = h.start();
    const result = await h.runner.waitFor(receipt.runId);

    expect(result.outcome).toBe('failed');
    expect(result.exitReason).toBe('preflight_refused');
    expect(result.failure?.code).toBe('ISOLATION_PROBE_FAILED');
    expect(result.failure?.failureClass).toBe('runtime');
    expect(result.failure?.retryable).toBe(false);
    expect(h.fake.startCalls).toBe(0);
    expect(launcher.calls).toHaveLength(0);
    expect(eventTypes(h.rootDir, receipt.runId)).toEqual(['claimed', 'materialized', 'failed']);
    expect(existsSync(join(spec.cwd, 'ran.txt'))).toBe(false);
  });

  it('проба, которая не дала вердикта, тоже отказывает — граница не считается доказанной', async () => {
    const launcher = new RecordingLauncher();
    const { h, provider } = harnessWith(launcher, { provider: { probeUnavailable: true } });
    const { receipt } = h.start();
    const result = await h.runner.waitFor(receipt.runId);

    expect(result.failure?.code).toBe('ISOLATION_PROBE_UNAVAILABLE');
    expect(result.failure?.retryable).toBe(false);
    expect(h.fake.startCalls).toBe(0);
    expect(launcher.calls).toHaveLength(0);
    // Отказ не оставляет аренду: слот свободен для следующего рана
    expect(provider.freeSlots()).toEqual(['slot-a', 'slot-b']);
    expect(provider.leases()).toEqual([]);
  });

  it('нет свободного слота: второй ран отказывается, а не идёт под service UID', async () => {
    const launcher = new RecordingLauncher();
    const { h, provider } = harnessWith(launcher, { provider: { slots: ['slot-a'] }, harness: { scenario: 'timeout' } });
    const first = h.start();
    await waitFor(() => h.runner.getRun(first.receipt.runId)?.state === 'running');

    const second = h.start();
    const result = await h.runner.waitFor(second.receipt.runId);
    expect(result.failure?.code).toBe('ISOLATION_SLOT_BUSY');
    expect(result.failure?.retryable).toBe(true);
    expect(h.fake.startCalls).toBe(1);

    await h.runner.cancel(first.receipt.runId, 1);
    await waitFor(() => provider.freeSlots().length === 1, 8000, 'slot released after cancel');
    expect(provider.freeSlots()).toEqual(['slot-a']);
  });

  it('управляемый сбой на точке isolation валит старт до спавна', async () => {
    const launcher = new RecordingLauncher();
    const { h } = harnessWith(launcher);
    h.faults.inject('isolation', { kind: 'throw' });
    const { receipt } = h.start();
    const result = await h.runner.waitFor(receipt.runId);
    // Управляемый сбой на точке isolation даёт структурированный отказ той же фазы
    expect(result.failure?.code).toBe('ISOLATION_UNAVAILABLE');
    expect(result.failure?.failureClass).toBe('runtime');
    expect(h.fake.startCalls).toBe(0);
    expect(launcher.calls).toHaveLength(0);
  });

  it('ран, запросивший границу, отказывается на хосте без провайдера', async () => {
    const h = createHarness();
    const spec = h.makeSpec({ isolation: { mode: 'per_run_unix_identity' } });
    const receipt = h.runner.start(spec);
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.failure?.code).toBe('ISOLATION_UNAVAILABLE');
    expect(h.fake.startCalls).toBe(0);
  });

  it('аренда переживает рестарт: слот не переиспользуется до проверенного sweep', async () => {
    const launcher = new RecordingLauncher();
    const rootDir = harnessRootFor('restart');
    // Sweep не смог удалить каталог рана: аренда blocked, слот не отдаётся следующему рану
    const first = harnessWith(launcher, { provider: { slots: ['slot-a'], sweepFails: true }, harness: { rootDir } });
    const blocked = first.h.start();
    await first.h.runner.waitFor(blocked.receipt.runId);
    expect(first.provider.lease(blocked.receipt.runId)?.status).toBe('blocked');
    expect(first.provider.freeSlots()).toEqual([]);

    const next = first.h.start();
    const refused = await first.h.runner.waitFor(next.receipt.runId);
    expect(refused.failure?.code).toBe('ISOLATION_SLOT_BUSY');

    // Воркер умирает, не освободив слот: аренда остаётся на диске. Новый воркер поверх того
    // же rootDir дочищает её — повторяется только sweep, движок НЕ запускается заново.
    const fakeStartsBefore = first.h.fake.startCalls;
    const restarted = harnessWith(launcher, { provider: { slots: ['slot-a'] }, harness: { rootDir } });
    expect(restarted.provider.freeSlots()).toEqual([]);
    const report = await restarted.h.runner.recover();
    expect(report.cleanRoomsReconciled).toBe(1);
    expect(restarted.h.fake.startCalls).toBe(0);
    expect(restarted.provider.freeSlots()).toEqual(['slot-a']);
    expect(listDir(join(rootDir, 'cleanrooms'))).toEqual([]);
    expect(first.h.fake.startCalls).toBe(fakeStartsBefore);
  });

  it('единственная копия выхода: workspace остаётся, слот не освобождается', async () => {
    const launcher = new RecordingLauncher();
    const rootDir = harnessRootFor('sole-copy');
    const blob = createBlobStore({ backend: 'local-fs', localRoot: join(rootDir, 'blobs') });
    const { h, provider } = harnessWith(launcher, { harness: { rootDir, blob, artifactExport: true, pruneLocalCopies: false } });
    const { receipt, spec } = h.start({ outputs: [{ path: 'ran.txt' }] });
    const result = await h.runner.waitFor(receipt.runId);

    expect(result.outcome).toBe('succeeded');
    expect(result.cleanup).toBe('pending');
    expect(provider.lease(receipt.runId)?.status).toBe('blocked');
    expect(provider.lease(receipt.runId)?.reason).toContain('only copy');
    expect(existsSync(join(spec.cwd, 'ran.txt'))).toBe(true);
    // Эфемерные каталоги среды при этом вычищены
    expect(existsSync(join(h.rootDir, 'cleanrooms', receipt.runId, 'home'))).toBe(false);
    expect(provider.freeSlots()).toEqual(['slot-b']);

    // Рестарт воркера не снимает блокировку: единственная копия остаётся на диске
    const reopened = h.reopenWithoutDispose();
    await reopened.recover();
    expect(provider.lease(receipt.runId)?.status).toBe('blocked');
    expect(existsSync(join(spec.cwd, 'ran.txt'))).toBe(true);
  });

  it('per-run MCP-процессы получают ту же идентичность, сокет — внутри чистой среды', async () => {
    const launcher = new RecordingLauncher();
    // Короткий rootDir внутри репозитория: путь unix-сокета моста должен поместиться в
    // каталог рана (лимит ~104 байта), иначе мост уходит в общий tmpdir хоста.
    const { h, provider } = harnessWith(launcher, { harness: { rootDir: harnessRootFor('mcp'), scenario: 'mcp-tools' } });
    const remote = await startFakeRemote();
    try {
      const registry = demoRegistry(remote.baseUrl);
      const runner = new Runner({
        rootDir: h.rootDir,
        adapters: { fake: h.fake },
        host: { region: 'sandbox-eu', environment: 'sandbox' },
        isolation: provider,
        capabilities: registry,
        bindingResolver: fixtureBindingResolver({ 'cred:demo-domain-write': remote.token }),
        cancelGraceMs: 500,
      });
      const spec = h.makeSpec({
        mcp: {
          servers: [mcpServer({ serverId: 'demo-domain-write', bindingRef: 'cred:demo-domain-write', allowedTools: ['demo.record_note'] })],
        },
        credentialBindings: [{ ref: 'cred:demo-domain-write', scope: 'demo:write' }],
        input: { inlinePrompt: mcpPlan({ calls: [{ tool: 'demo.record_note', arguments: { text: 'note' } }] }) },
      });
      const receipt = runner.start(spec);
      const result = await runner.waitFor(receipt.runId);
      expect(result.outcome).toBe('succeeded');

      const messages = mcpLogMessages(h.rootDir, receipt.runId);
      const ready = messages.find((line) => line.startsWith('mcp.server_ready'));
      expect(ready).toBeDefined();
      expect(ready).toContain('isolation=per_run_unix_identity uid=40001');

      const bridge = messages.find((line) => line.startsWith('mcp.bridge_ready'));
      expect(bridge).toBeDefined();
      expect(bridge).toContain(join(h.rootDir, 'cleanrooms', receipt.runId, 'mcp'));

      // MCP-сервер стартовал через лаунчер рана
      const serverCalls = launcher.forCommand('stdio-domain-server.mjs');
      expect(serverCalls.length).toBeGreaterThan(0);
      expect(serverCalls[0]?.identity.slotId).toBe('slot-a');

      // Сокет моста и каталоги среды вычищены вместе с чистой средой
      expect(listDir(join(h.rootDir, 'mcp'))).toEqual([]);
      expect(listDir(join(h.rootDir, 'cleanrooms'))).toEqual([]);
      expect(existsSync(spec.cwd)).toBe(false);
      runner.dispose();
    } finally {
      await remote.stop();
    }
  });

  it('capabilities объявляют границу честно: без провайдера, с проверенной и с отказавшей', () => {
    const launcher = new RecordingLauncher();
    const apiRoot = harnessRootFor('api');
    const verified = new StubCleanRoomProvider({ rootDir: join(apiRoot, 'verified') }, launcher);
    const refusing = new StubCleanRoomProvider({ rootDir: join(apiRoot, 'refusing'), selfTestOk: false }, launcher);

    const apiWithout = apiFor({ rootDir: join(apiRoot, 'none') });
    expect(apiWithout.capabilities().mcp.osIsolation).toBe('not_proven_service_uid_only');
    expect(apiWithout.capabilities().isolation).toEqual({
      mode: 'none',
      slots: [],
      freeSlots: [],
      capability: 'not_proven_service_uid_only',
      launcher: null,
      failClosed: true,
    });

    const apiVerified = apiFor({ rootDir: join(apiRoot, 'verified'), isolation: verified });
    expect(apiVerified.capabilities().mcp.osIsolation).toBe('per_run_unix_identity_verified');
    expect(apiVerified.capabilities().isolation.capability).toBe('per_run_unix_identity_verified');
    expect(apiVerified.capabilities().isolation.freeSlots).toEqual(['slot-a', 'slot-b']);
    expect(apiVerified.capabilities().isolation.launcher).toBe('setpriv');

    const apiRefusing = apiFor({ rootDir: join(apiRoot, 'refusing'), isolation: refusing });
    expect(apiRefusing.capabilities().mcp.osIsolation).toBe('configured_but_refusing_runs');
    expect(apiRefusing.capabilities().isolation.capability).toBe('configured_but_refusing_runs');
  });

  it('spec.isolation принимает только известные режимы', () => {
    const base = {
      contractVersion: 1,
      jobId: 'job-1',
      runId: 'run-1',
      operationId: 'op-1',
      userTaskId: 'task-1',
      profileId: 'profile-a',
      conversationId: 'conv-1',
      ownerGeneration: 1,
      engine: { name: 'fake', adapterVersion: '1' },
      cwd: '/tmp/ws/run-1',
      envAllowlist: [],
      limits: { timeoutMs: 5000 },
    } as const;
    expect(validateRunSpec({ ...base, isolation: { mode: 'per_run_unix_identity' } }).ok).toBe(true);
    expect(validateRunSpec({ ...base, isolation: { mode: 'none' } }).ok).toBe(true);
    expect(validateRunSpec({ ...base, isolation: { mode: 'container' } }).ok).toBe(false);
  });
});

/**
 * Свежий каталог внутри репозитория для фикстур, которым нужен короткий путь
 * (unix-сокет моста) или долговечное состояние для эмуляции рестарта воркера.
 */
function harnessRootFor(name: string): string {
  const base = join(import.meta.dirname, '..', '_scratch', 'isolation');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${name}-`));
}