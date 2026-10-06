import { describe, expect, it, onTestFinished } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadAgentApiConfig } from '../src/api/config.js';
import { createExternalWorkers } from '../src/api/workers.js';
import type { ExternalWorkerAdapter } from '../src/adapters/external-worker-adapter.js';
import { validateRunSpec, type RunSpec } from '../src/contracts/run-spec.js';

/**
 * Сквозная сборка «конфиг → адаптер → LaunchRequest» (issue #100, найдено живой пробой).
 *
 * Пустой `LaunchRequest.env` означает, что ключ LLM не покидает API: агент в GitHub Actions
 * уходит в провайдер без ключа и падает с `unauthorized` уже после старта. Все прежние тесты
 * это пропускали — они собирали адаптер руками и передавали `env` напрямую, минуя `main.ts`.
 */
describe('сборка воркеров из конфига процесса', () => {
  it('пул AGENT_API_ENV доезжает до воркера в LaunchRequest.env', async () => {
    const launches: Array<Record<string, unknown>> = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        launches.push(body);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            runId: body['runId'],
            operationId: body['operationId'],
            status: 'accepted',
            statusUrl: 'https://worker.example/v1/runs/x/status',
            resultUrl: 'https://worker.example/v1/runs/x/result',
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const config = loadAgentApiConfig({
      AGENT_API_KEY_REGISTRY: '/etc/agent-runner/key-registry.json',
      AGENT_API_WORKERS: JSON.stringify([{ engine: 'azure-dynamic-ip-agent-run', baseUrl: `http://127.0.0.1:${port}`, acceptDeadlineMs: 2000 }]),
      AGENT_API_ENV: JSON.stringify({ LLM_LADDER_TOKEN: 'ladder-key-value', PATH: '/usr/bin' }),
    });
    const [worker] = createExternalWorkers(config, () => undefined);
    expect(worker).toBeDefined();
    (worker as ExternalWorkerAdapter).setResultBaseUrl('https://api.example');

    const spec = validateRunSpec({
      contractVersion: 1,
      jobId: 'job-1',
      runId: 'run-1',
      operationId: 'op-1',
      userTaskId: 'task-1',
      profileId: 'profile-1',
      conversationId: 'conv-1',
      ownerGeneration: 1,
      engine: { name: 'azure-dynamic-ip-agent-run', adapterVersion: '1' },
      input: { inlinePrompt: 'сделай отчёт' },
      cwd: '/workspace/run-1',
      envAllowlist: ['LLM_LADDER_TOKEN', 'PATH'],
      limits: { timeoutMs: 60_000, maxOutputBytes: 1000, maxLogBytes: 1000 },
      repository: { fullName: 'owner/name' },
      isolation: { mode: 'none' },
    } as unknown as Record<string, unknown>);
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;

    await worker!.launch(spec.value as RunSpec);
    expect(launches).toHaveLength(1);
    expect(launches[0]!['env']).toEqual({ LLM_LADDER_TOKEN: 'ladder-key-value', PATH: '/usr/bin' });
  });

  it('в воркер уходит только пересечение пула с envAllowlist', async () => {
    const launches: Array<Record<string, unknown>> = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        launches.push(body);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId: body['runId'], operationId: body['operationId'], status: 'accepted', statusUrl: 's', resultUrl: 'r' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const config = loadAgentApiConfig({
      AGENT_API_KEY_REGISTRY: '/etc/agent-runner/key-registry.json',
      AGENT_API_WORKERS: JSON.stringify([{ engine: 'azure-dynamic-ip-agent-run', baseUrl: `http://127.0.0.1:${port}`, acceptDeadlineMs: 2000 }]),
      // В пуле есть и путь к журналу — он не должен уезжать в ран.
      AGENT_API_ENV: JSON.stringify({ LLM_LADDER_TOKEN: 'ladder-key-value', AGENT_API_ADMISSION_LOG: '/var/lib/agent-runner/admissions.jsonl' }),
    });
    const [worker] = createExternalWorkers(config, () => undefined);
    (worker as ExternalWorkerAdapter).setResultBaseUrl('https://api.example');
    const spec = validateRunSpec({
      contractVersion: 1,
      jobId: 'job-1',
      runId: 'run-1',
      operationId: 'op-1',
      userTaskId: 'task-1',
      profileId: 'profile-1',
      conversationId: 'conv-1',
      ownerGeneration: 1,
      engine: { name: 'azure-dynamic-ip-agent-run', adapterVersion: '1' },
      input: { inlinePrompt: 'сделай отчёт' },
      cwd: '/workspace/run-1',
      envAllowlist: ['LLM_LADDER_TOKEN'],
      limits: { timeoutMs: 60_000, maxOutputBytes: 1000, maxLogBytes: 1000 },
      repository: { fullName: 'owner/name' },
      isolation: { mode: 'none' },
    } as unknown as Record<string, unknown>);
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;

    await worker!.launch(spec.value as RunSpec);
    expect(launches[0]!['env']).toEqual({ LLM_LADDER_TOKEN: 'ladder-key-value' });
  });
});