import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapabilityRegistry, type CapabilityHandler } from '../src/mcp/capabilities.js';
import { createFakeRemoteDomainCapabilities } from '../src/mcp/demo-capabilities.js';
import { MCP_FIXTURES, mcpFixturePath } from '../src/mcp/session.js';
import type { McpStdioServerSpec } from '../src/contracts/run-spec.js';

export const FAKE_REMOTE_SCRIPT = fileURLToPath(new URL('../scripts/fake-remote-domain-service.mjs', import.meta.url));
export const DOMAIN_SERVER_FIXTURE = mcpFixturePath(MCP_FIXTURES.domainServer);

export interface FakeRemote {
  baseUrl: string;
  token: string;
  logPath: string;
  logLines: () => Array<Record<string, unknown>>;
  receipts: () => Array<Record<string, unknown>>;
  stop: () => Promise<void>;
}

/**
 * Фикстура «remote domain service» этапа I04: общий внешний сервис, не per-run процесс.
 * Значение bearer-токена живёт только в переменных окружения этого процесса.
 */
export async function startFakeRemote(_rootDir?: string): Promise<FakeRemote> {
  const token = `fixture-${randomBytes(16).toString('hex')}`;
  // Свой каталог на каждый запуск: журнал внешнего сервиса не должен смешиваться между тестами.
  const logPath = join(mkdtempSync(join(tmpdir(), 'mcp-fake-remote-')), 'fake-remote.jsonl');
  const child: ChildProcess = spawn(process.execPath, [FAKE_REMOTE_SCRIPT], {
    env: { ...process.env, FAKE_REMOTE_TOKEN: token, FAKE_REMOTE_PORT: '0', FAKE_REMOTE_LOG: logPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('fake remote service did not report a port in 5 s')), 5000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      const line = buffer.slice(0, index);
      try {
        const parsed = JSON.parse(line) as { event?: string; port?: number };
        if (parsed.event === 'fake_remote_listening' && typeof parsed.port === 'number') {
          clearTimeout(timer);
          resolve(parsed.port);
        }
      } catch {
        // не наша строка — ждём следующую
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake remote service exited early with code ${String(code)}`));
    });
  });

  const readLines = (): Array<Record<string, unknown>> => {
    try {
      return readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  };

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    logPath,
    logLines: readLines,
    receipts: () => readLines().filter((line) => line['outcome'] === 'completed' && typeof line['receiptId'] === 'string'),
    async stop() {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
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

export function demoRegistry(baseUrl: string): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const handler of createFakeRemoteDomainCapabilities({ baseUrl }) as CapabilityHandler[]) registry.register(handler);
  return registry;
}

/** Значение binding'а для песочницы: только для объявленных ref'ов, наружу не отдаётся. */
export function fixtureBindingResolver(values: Record<string, string>) {
  return (ref: string): string | null => values[ref] ?? null;
}

export function mcpServer(over: Partial<McpStdioServerSpec> & { serverId: string }): McpStdioServerSpec {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [DOMAIN_SERVER_FIXTURE],
    envAllowlist: ['PATH', 'MCP_FIXTURE_MODE'],
    allowedTools: ['demo.search_status', 'demo.record_note'],
    ...over,
  };
}

/** План вызовов движка: `calls` обязан завершиться completed, `denied` — отказом. */
export function mcpPlan(plan: { calls?: Array<{ tool: string; arguments?: Record<string, unknown> }>; denied?: Array<{ tool: string; arguments?: Record<string, unknown> }> }): string {
  return JSON.stringify({ calls: plan.calls ?? [], denied: plan.denied ?? [] });
}

export function logMessages(rootDir: string, runId: string): string[] {
  return readFileSync(join(rootDir, 'runs', runId, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { payload?: { message?: string } }).payload?.message ?? '')
    .filter((message) => message.startsWith('mcp.'));
}
