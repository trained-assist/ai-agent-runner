#!/usr/bin/env node
// Клиент MCP со стороны движка: подключается к broker'у из конфига рана
// (RUNNER_MCP_CONFIG), делает handshake, спрашивает tools/list и выполняет план вызовов
// из промпта. Это детерминированныйFakeEngine-сценарий mcp-tools: он доказывает, что
// инструмент вызван по-настоящему (а не только перечислен), и что вызов вне scoped
// bindings отказывается.
//
// План приходит аргументом (JSON):
//   { "calls": [ { "tool": "demo.record_note", "arguments": { "text": "..." } } ],
//     "denied": [ { "tool": "demo.admin_purge", "arguments": {} } ] }
// Результат каждого шага пишется в <cwd>/mcp-evidence.jsonl и в stdout (одна строка
// `mcp-evidence: {...}` на шаг) — это и есть сырьё транскрипта приёмки.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROTOCOL_VERSION = '2025-06-18';
const EVIDENCE_FILE = 'mcp-evidence.jsonl';
const EXIT_OK = 0;
const EXIT_EVIDENCE_FAILED = 3;

const plan = parsePlan(process.argv[2]);
const config = readConfig(process.env.RUNNER_MCP_CONFIG ?? '');
const evidencePath = join(process.cwd(), EVIDENCE_FILE);
const startedAt = Date.now();
const evidence = [];

function parsePlan(raw) {
  if (!raw) return { calls: [], denied: [] };
  const parsed = JSON.parse(raw);
  return {
    calls: Array.isArray(parsed.calls) ? parsed.calls : [],
    denied: Array.isArray(parsed.denied) ? parsed.denied : [],
  };
}

function readConfig(path) {
  if (!path) throw new Error('RUNNER_MCP_CONFIG is not set: the run declares no MCP session');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed.broker || typeof parsed.broker.command !== 'string') throw new Error(`malformed MCP config at ${path}`);
  return parsed;
}

function record(step, fields) {
  const entry = { at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, step, ...fields };
  evidence.push(entry);
  appendFileSync(evidencePath, `${JSON.stringify(entry)}\n`, 'utf8');
  process.stdout.write(`mcp-evidence: ${JSON.stringify(entry)}\n`);
  return entry;
}

async function main() {
  writeFileSync(evidencePath, '', 'utf8');
  if (!config.bridge || typeof config.bridge.url !== 'string') throw new Error('malformed MCP config: bridge url is required');
  const child = spawn(config.broker.command, config.broker.args ?? [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: process.env.PATH ?? '',
      MCP_BRIDGE_URL: config.bridge.url,
      MCP_BRIDGE_TOKEN: config.bridge.runToken,
      MCP_RUN_ID: config.runId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  record('broker_spawned', { runId: config.runId, serverIds: config.serverIds ?? [], pid: child.pid ?? -1 });

  const client = createClient(child);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (line.trim().length > 0) record('broker_stderr', { line: line.slice(0, 300) });
    }
  });

  const init = await client.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'sandbox-engine-client', version: '1.0.0' },
  });
  record('initialize', { protocolVersion: init.result?.protocolVersion, serverName: init.result?.serverInfo?.name });
  client.notify('notifications/initialized');

  const listed = await client.request('tools/list', {});
  const tools = (listed.result?.tools ?? []).map((tool) => ({
    name: tool.name,
    serverId: tool.xHost?.serverId ?? null,
    bindingRef: tool.xHost?.bindingRef ?? null,
    bindingScope: tool.xHost?.bindingScope ?? null,
    effect: tool.xHost?.effect ?? null,
  }));
  record('tools_list', { count: tools.length, tools });

  let failures = 0;
  for (const call of plan.calls) {
    const response = await client.request('tools/call', { name: call.tool, arguments: call.arguments ?? {} });
    const outcome = response.result?.structuredContent?.outcome;
    const receipt = outcome?.effectReceipt;
    const ok = response.error === undefined && outcome?.kind === 'completed';
    if (!ok) failures += 1;
    record('tool_call', {
      tool: call.tool,
      expect: 'completed',
      ok,
      error: response.error ? { code: response.error.code, message: response.error.message, data: response.error.data } : null,
      outcomeKind: outcome?.kind ?? null,
      effectReceiptId: receipt?.receiptId ?? null,
      bindingRef: receipt?.bindingRef ?? null,
      result: outcome?.result ?? null,
    });
  }

  for (const call of plan.denied) {
    const response = await client.request('tools/call', { name: call.tool, arguments: call.arguments ?? {} });
    const refused = response.error !== undefined || response.result?.isError === true;
    if (!refused) failures += 1;
    record('tool_call_denied_probe', {
      tool: call.tool,
      expect: 'refused',
      ok: refused,
      error: response.error ? { code: response.error.code, message: response.error.message, data: response.error.data } : null,
      isError: response.result?.isError === true,
      text: response.result?.content?.[0]?.text ?? null,
    });
  }

  child.stdin.end();
  child.kill('SIGTERM');
  record('finished', { failures, ok: failures === 0 });
  process.exit(failures === 0 ? EXIT_OK : EXIT_EVIDENCE_FAILED);
}

function createClient(child) {
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          message = null;
        }
        const entry = message ? pending.get(message.id) : undefined;
        if (entry) {
          pending.delete(message.id);
          clearTimeout(entry.timer);
          entry.resolve(message);
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  return {
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    request(method, params, timeoutMs = 20000) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`"${method}" timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

main().catch((err) => {
  record('client_crashed', { detail: err instanceof Error ? err.message : String(err), ok: false });
  process.exit(EXIT_EVIDENCE_FAILED);
});
