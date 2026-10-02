#!/usr/bin/env node
// Песочный MCP-сервер рана (agent-local, stdio, поднимается runner'ом на каждый ран).
//
// Это ТРАНСПОРТ, а не доменная логика: tools/call уходит мостом в хост, где тот же
// capability handler исполняет действие (TASK-ROUTER-AND-MCP §5: «Core MCP становится
// тонким platform facade, domain methods остаются в domain repos»). Значения binding'ов
// процесс не получает и не видит.
//
// Управляемые сбои (env MCP_FIXTURE_MODE) — для приёмки P13:
//   startup-fail   — процесс уходит сразу, handshake не состоится
//   handshake-hang — initialize не отвечает (проверка readiness timeout)
//   tool-hang      — tools/call не отвечает (проверка tool timeout)
//   tool-error     — инструмент возвращает isError без effect receipt
import { BridgeClient } from './bridge-client.mjs';

const SERVER_NAME = 'sandbox-domain-mcp';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-06-18';
const SCOPE_DENIED_CODE = -32001;

// Инструменты фикстуры. `demo.admin_purge` объявлен сервером, но ран его не декларирует —
// так проверяется, что движок не видит инструментов вне scoped bindings.
const TOOLS = [
  {
    name: 'demo.search_status',
    description: 'Read the status of a demo search by id',
    inputSchema: { type: 'object', properties: { searchId: { type: 'string' } }, required: ['searchId'] },
  },
  {
    name: 'demo.record_note',
    description: 'Write a demo note and return an effect receipt',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'demo.admin_purge',
    description: 'Destructive demo capability, declared by a run only together with a demo:admin binding',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
  },
  {
    // Ни один ран в песочнице не декларирует этот инструмент: так проверяется отказ
    // инструмента вне scoped bindings (tool_not_in_scope).
    name: 'demo.internal_debug',
    description: 'Internal debug tool, never declared by a run',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

const mode = process.env.MCP_FIXTURE_MODE ?? 'ok';
const serverId = process.env.MCP_SERVER_ID ?? 'unknown';
const allowedTools = (process.env.MCP_ALLOWED_TOOLS ?? '').split(',').filter(Boolean);

function log(level, event, fields = {}) {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, serverId, mode, ...fields })}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function textContent(text, structured) {
  return { content: [{ type: 'text', text }], ...(structured === undefined ? {} : { structuredContent: structured }) };
}

async function main() {
  if (mode === 'startup-fail') {
    log('error', 'fixture_startup_failure', { detail: 'MCP_FIXTURE_MODE=startup-fail' });
    process.exit(3);
  }

  const bridge = new BridgeClient({
    url: process.env.MCP_BRIDGE_URL ?? '',
    runToken: process.env.MCP_BRIDGE_TOKEN ?? '',
    serverId,
    onLog: (entry) => log(entry.level, entry.event, { detail: entry.line }),
  });
  await bridge.open();

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) void handle(line);
      index = buffer.indexOf('\n');
    }
  });
  process.stdin.on('close', () => {
    log('info', 'fixture_stdin_closed');
    bridge.close();
    process.exit(0);
  });

  async function handle(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const { id, method, params } = message;
    if (id === undefined || id === null) return; // notification

    switch (method) {
      case 'initialize': {
        if (mode === 'handshake-hang') {
          log('warn', 'fixture_handshake_hang');
          return;
        }
        log('info', 'fixture_initialize', { clientProtocolVersion: params?.protocolVersion });
        send({
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        });
        return;
      }
      case 'ping':
        send({ id, result: {} });
        return;
      case 'tools/list':
        send({ id, result: { tools: TOOLS } });
        return;
      case 'tools/call': {
        const tool = typeof params?.name === 'string' ? params.name : '';
        const args = typeof params?.arguments === 'object' && params.arguments !== null ? params.arguments : {};
        if (mode === 'tool-hang') {
          log('warn', 'fixture_tool_hang', { tool });
          return;
        }
        if (!allowedTools.includes(tool)) {
          // Сервер тоже держит свой список: объявленный ран'ом инструмент — единственный,
          // который он вообще готов исполнить.
          send({ id, result: textContent(JSON.stringify({ outcome: { kind: 'technical_error', code: 'NOT_DECLARED_BY_RUN' } }), true), isError: true });
          return;
        }
        if (mode === 'tool-error') {
          send({ id, result: textContent('fixture tool failure (MCP_FIXTURE_MODE=tool-error)', { outcome: { kind: 'technical_error', code: 'FIXTURE_TOOL_ERROR' } }), isError: true });
          return;
        }
        const response = await bridge.request('capability/invoke', { serverId, capabilityId: tool, arguments: args });
        if (response.ok === true && response.outcome) {
          const outcome = response.outcome;
          if (outcome.kind === 'completed') {
            send({ id, result: textContent(JSON.stringify({ outcome }), { outcome }) });
          } else {
            send({ id, result: textContent(JSON.stringify({ outcome }), { outcome }), isError: true });
          }
          return;
        }
        // Отказ хоста (scope/instrument/binding) уходит типовой ошибкой JSON-RPC, а не
        // «успешным» результатом:наружу не должен выглядеть как исполненное действие.
        const code = typeof response.code === 'string' ? response.code : 'BRIDGE_ERROR';
        send({
          id,
          error: {
            code: SCOPE_DENIED_CODE,
            message: `${code}: ${response.message ?? 'host refused the capability'}`,
            data: { reason: code, tool, serverId, details: response.details ?? null },
          },
        });
        return;
      }
      default:
        send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }
}

main().catch((err) => {
  log('error', 'fixture_crashed', { detail: err instanceof Error ? err.message : String(err) });
  process.exit(4);
});
