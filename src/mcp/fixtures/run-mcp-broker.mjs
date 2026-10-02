#!/usr/bin/env node
// Per-run MCP proxy для движка: локальный stdio-процесс, к которому подключается
// engine client (TASK-ROUTER-AND-MCP §5, «Agent-local MCP»). Секретов не получает:
// в env только run token локального моста. Список инструментов и приёмка вызовов —
// на хосте, поэтому движок видит ровно scoped bindings рана и не может выйти за них.
import { BridgeClient } from './bridge-client.mjs';

const SERVER_NAME = 'ai-agent-runner-mcp-broker';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-06-18';
const SCOPE_DENIED_CODE = -32001;

const runId = process.env.MCP_RUN_ID ?? 'unknown';

function log(level, event, fields = {}) {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, runId, component: 'mcp-broker', ...fields })}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function inputSchema() {
  return { type: 'object', properties: {}, additionalProperties: true };
}

const bridge = new BridgeClient({
  url: process.env.MCP_BRIDGE_URL ?? '',
  runToken: process.env.MCP_BRIDGE_TOKEN ?? '',
  serverId: 'broker',
  onLog: (entry) => log(entry.level, `broker_${entry.event}`, { detail: entry.line }),
});

let cache = new Map();

async function toolsList() {
  const response = await bridge.request('tools/list', {});
  const tools = Array.isArray(response.tools) ? response.tools : [];
  cache = new Map(tools.map((tool) => [tool.name, tool]));
  return tools;
}

async function main() {
  await bridge.open();
  log('info', 'broker_ready', { pid: process.pid });

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
    log('info', 'broker_stdin_closed');
    bridge.close();
    process.exit(0);
  });
}

async function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const { id, method, params } = message;
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return;
    case 'notifications/initialized':
    case 'ping':
      if (method === 'ping') send({ id, result: {} });
      return;
    case 'tools/list': {
      const tools = await toolsList();
      send({
        id,
        result: {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: inputSchema(),
            annotations: { readOnlyHint: tool.effect === 'read' },
            xHost: {
              serverId: tool.serverId,
              bindingRef: tool.bindingRef,
              bindingScope: tool.bindingScope,
              requiredScopes: tool.requiredScopes,
              effect: tool.effect,
              capabilityVersion: tool.capabilityVersion,
            },
          })),
        },
      });
      return;
    }
    case 'tools/call': {
      const name = typeof params?.name === 'string' ? params.name : '';
      const known = cache.get(name);
      const args = typeof params?.arguments === 'object' && params.arguments !== null ? params.arguments : {};
      // Решение принимает хост, а не broker: инструмент вне scoped bindings отклоняется
      // там и попадает в лог рана с точной причиной (здесь serverId неизвестен — пустой).
      const response = await bridge.request('tools/call', { serverId: known?.serverId ?? '', tool: name, arguments: args });
      if (response.ok === true) {
        const structured = response.result ?? {};
        send({ id, result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured } });
        return;
      }
      const reason = response.reason ?? 'unknown';
      const detail = response.detail ?? null;
      send({
        id,
        error: {
          code: SCOPE_DENIED_CODE,
          // Причина и деталь идут в текст ошибки: движок/модель читают message, а не data.
          message:
            reason === 'tool_not_in_scope'
              ? `tool "${name}" is not in the scoped bindings of this run`
              : `tool "${name}" was refused (${reason})${detail ? `: ${detail}` : ''}`,
          data: { reason, tool: name, serverId: known?.serverId ?? null, detail },
        },
      });
      return;
    }
    default:
      send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

main().catch((err) => {
  log('error', 'broker_crashed', { detail: err instanceof Error ? err.message : String(err) });
  process.exit(4);
});
