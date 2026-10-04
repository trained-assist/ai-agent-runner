#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const TERMINAL_EVENTS = new Set(['succeeded', 'failed', 'cancelled']);
const REQUEST_TIMEOUT_MS = 30_000;
const EXIT_USAGE = 2;
const EXIT_NOT_READY = 3;

const USAGE = `runner-cli.mjs — transport for the Serverless Agent API

Usage:
  runner-cli.mjs <command> [options]

Commands:
  submit   [--file <path|->] [--json <json>] [--engine <name>] [--adapter-version <v>]
           [--prompt <text>] [--instructions <text>] [--timeout-ms <n>]
           [--user-task-id <id>] [--conversation-id <id>] [--idempotency-key <key>]
  status   <runId>
  events   <runId> [--cursor <n>] [--limit <n>]
  follow   <runId> [--cursor <n>] [--timeout-ms <n>]   SSE until the run reaches a terminal state
  result   <runId>
  cancel   <runId> [--owner-generation <n>] [--reason <text>]

Connection (flags win over environment):
  --url <base-url>        env RUNNER_API_URL        e.g. http://127.0.0.1:8787
  --key <api-key>         env RUNNER_API_KEY
  --key-file <path>       env RUNNER_API_KEY_FILE   file holding the raw key (mode 0600)

Output:
  JSON on stdout (result/status/events/submit/cancel), NDJSON events for follow,
  diagnostics on stderr.

Exit codes:
  0 success · 1 API or network error · 2 usage error · 3 result not ready yet
`;

function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const eq = name.indexOf('=');
      if (eq >= 0) {
        flags[name.slice(0, eq)] = name.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[name] = 'true';
      } else {
        flags[name] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function intFlag(flags, name, fallback) {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) fail(`${name}: expected an integer, got "${raw}"`, EXIT_USAGE);
  return value;
}

function connection(flags) {
  const url = flags['url'] ?? process.env.RUNNER_API_URL;
  if (!url) fail('--url or RUNNER_API_URL is required', EXIT_USAGE);
  let key = flags['key'] ?? process.env.RUNNER_API_KEY;
  const keyFile = flags['key-file'] ?? process.env.RUNNER_API_KEY_FILE;
  if ((key === undefined || String(key).trim() === '') && keyFile) {
    try {
      key = readFileSync(keyFile, 'utf8').trim();
    } catch (err) {
      fail(`cannot read key file ${keyFile}: ${err.message}`, EXIT_USAGE);
    }
  }
  const trimmed = String(key).trim();
  if (trimmed === '') fail('--key, RUNNER_API_KEY or RUNNER_API_KEY_FILE is empty (the API rejects anonymous requests)', EXIT_USAGE);
  return { base: String(url).replace(/\/+$/, ''), key: trimmed };
}

function authHeaders(conn) {
  return { authorization: `Bearer ${conn.key}` };
}

class ApiError extends Error {
  constructor(status, body) {
    const error = body && typeof body === 'object' ? body.error : undefined;
    super(`${status}${error && error.code ? ` ${error.code}` : ''}: ${error && error.message ? error.message : JSON.stringify(body)}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = error && error.code ? error.code : undefined;
    this.body = body;
  }
}

async function readBody(res) {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function request(conn, method, path, options = {}) {
  const url = `${conn.base}${path}`;
  const headers = { ...authHeaders(conn), ...(options.headers ?? {}) };
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      fail(`${method} ${path}: request timed out`, 1);
    }
    fail(`${method} ${path}: ${err && err.message ? err.message : String(err)}`, 1);
  }
  if (!res.ok) throw new ApiError(res.status, await readBody(res));
  return readBody(res);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${label}: not valid JSON (${err.message})`, EXIT_USAGE);
  }
}

async function buildSubmitBody(flags) {
  if (flags['file'] !== undefined) {
    const raw = flags['file'] === '-' ? await readStdin() : readFileSync(flags['file'], 'utf8');
    return parseJson(raw, '--file');
  }
  if (flags['json'] !== undefined) {
    return parseJson(flags['json'] === '-' ? await readStdin() : flags['json'], '--json');
  }
  const body = {
    engine: {
      name: flags['engine'] ?? 'dynamic-ip-azure-agent-run',
      adapterVersion: flags['adapter-version'] ?? '1',
    },
    limits: { timeoutMs: intFlag(flags, 'timeout-ms', 30_000) },
    envAllowlist: [],
  };
  const prompt = flags['prompt'];
  if (prompt !== undefined) body.input = { inlinePrompt: prompt };
  const instructions = flags['instructions'];
  if (instructions !== undefined) body.instructions = instructions;
  const userTaskId = flags['user-task-id'];
  if (userTaskId !== undefined) body.userTaskId = userTaskId;
  const conversationId = flags['conversation-id'];
  if (conversationId !== undefined) body.conversationId = conversationId;
  return body;
}

async function commandSubmit(conn, flags) {
  const body = await buildSubmitBody(flags);
  const idempotencyKey = flags['idempotency-key'] ?? `cli_${randomUUID()}`;
  const response = await request(conn, 'POST', '/v1/runs', {
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
  print(response);
}

async function commandStatus(conn, runId) {
  print(await request(conn, 'GET', `/v1/runs/${encodeURIComponent(runId)}/status`));
}

async function commandEvents(conn, flags, runId) {
  const params = new URLSearchParams();
  if (flags['cursor'] !== undefined) params.set('cursor', String(intFlag(flags, 'cursor', 0)));
  if (flags['limit'] !== undefined) params.set('limit', String(intFlag(flags, 'limit', 500)));
  const query = params.toString();
  print(await request(conn, 'GET', `/v1/runs/${encodeURIComponent(runId)}/events${query ? `?${query}` : ''}`));
}

async function commandResult(conn, runId) {
  print(await request(conn, 'GET', `/v1/runs/${encodeURIComponent(runId)}/result`));
}

async function commandCancel(conn, flags, runId) {
  const body = {};
  if (flags['owner-generation'] !== undefined) body.ownerGeneration = intFlag(flags, 'owner-generation', 0);
  if (flags['reason'] !== undefined) body.reason = flags['reason'];
  print(await request(conn, 'POST', `/v1/runs/${encodeURIComponent(runId)}/cancel`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function parseSseFrame(block) {
  let event;
  let id;
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, id, data: parseJson(dataLines.join('\n'), 'sse frame') };
}

function emitLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function commandFollow(conn, flags, runId) {
  let cursor = intFlag(flags, 'cursor', 0);
  const timeoutMs = intFlag(flags, 'timeout-ms', 300_000);
  const deadline = Date.now() + timeoutMs;
  let terminal = false;

  while (!terminal) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail(`follow timed out after ${timeoutMs}ms (last cursor ${cursor})`, 1);
    const controller = new AbortController();
    let idleTimer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
    let res;
    try {
      res = await fetch(`${conn.base}/v1/runs/${encodeURIComponent(runId)}/events`, {
        headers: { ...authHeaders(conn), accept: 'text/event-stream', 'last-event-id': String(cursor) },
        signal: controller.signal,
      });
    } catch (err) {
      fail(`follow: ${err && err.message ? err.message : String(err)}`, 1);
    }
    if (!res.ok) throw new ApiError(res.status, await readBody(res));
    if (!res.body) fail('follow: response has no body', 1);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
        buffer += decoder.decode(chunk.value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const frame = parseSseFrame(block);
          if (frame) {
            if (frame.id && Number.isInteger(Number(frame.id))) cursor = Number(frame.id);
            if (frame.event === 'snapshot' && frame.data && typeof frame.data === 'object') {
              const state = frame.data.state;
              emitLine({ type: 'snapshot', ...frame.data });
              if (TERMINAL_STATES.has(state)) terminal = true;
            } else if (frame.event && frame.data && typeof frame.data === 'object') {
              if (typeof frame.data.sequence === 'number') cursor = frame.data.sequence;
              emitLine(frame.data);
              if (TERMINAL_EVENTS.has(frame.event)) terminal = true;
            }
          }
          if (terminal) break;
          index = buffer.indexOf('\n\n');
        }
        if (terminal) break;
      }
    } catch (err) {
      if (!terminal && err && err.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(idleTimer);
      try {
        await reader.cancel();
      } catch {}
    }
    if (!terminal) await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (flags['help'] === 'true' || command === undefined || command === 'help') {
    process.stdout.write(USAGE);
    process.exit(command === undefined && flags['help'] !== 'true' ? EXIT_USAGE : 0);
  }
  const conn = connection(flags);
  const runId = positional[1];

  switch (command) {
    case 'submit':
      await commandSubmit(conn, flags);
      break;
    case 'status':
      if (!runId) fail('status: <runId> is required', EXIT_USAGE);
      await commandStatus(conn, runId);
      break;
    case 'events':
      if (!runId) fail('events: <runId> is required', EXIT_USAGE);
      await commandEvents(conn, flags, runId);
      break;
    case 'follow':
      if (!runId) fail('follow: <runId> is required', EXIT_USAGE);
      await commandFollow(conn, flags, runId);
      break;
    case 'result':
      if (!runId) fail('result: <runId> is required', EXIT_USAGE);
      await commandResult(conn, runId);
      break;
    case 'cancel':
      if (!runId) fail('cancel: <runId> is required', EXIT_USAGE);
      await commandCancel(conn, flags, runId);
      break;
    default:
      fail(`unknown command "${command}" (see runner-cli.mjs help)`, EXIT_USAGE);
  }
}

main().catch((err) => {
  if (err instanceof ApiError) {
    if (err.code === 'RESULT_NOT_READY') fail(err.message, EXIT_NOT_READY);
    fail(err.message, 1);
  }
  fail(err && err.stack ? err.stack : String(err), 1);
});
