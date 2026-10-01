import { sleep } from './checks.mjs';

export function authHeaders(key) {
  return { authorization: `Bearer ${key}` };
}

export async function request(base, path, options = {}) {
  const method = options.method ?? 'GET';
  const headers = { ...(options.headers ?? {}) };
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  if (options.idempotencyKey !== undefined && options.idempotencyKey !== null) {
    headers['idempotency-key'] = options.idempotencyKey;
  }
  if (options.accept) headers.accept = options.accept;
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const response = await fetch(base + path, { method, headers, body, signal: options.signal });
  const text = await response.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

export async function submitRun(base, key, idempotencyKey, body) {
  return request(base, '/v1/runs', { method: 'POST', key, idempotencyKey, body });
}

export async function getStatus(base, key, runId) {
  return request(base, `/v1/runs/${encodeURIComponent(runId)}/status`, { key });
}

export async function getResult(base, key, runId) {
  return request(base, `/v1/runs/${encodeURIComponent(runId)}/result`, { key });
}

export async function getEvents(base, key, runId, cursor = 0, limit = 500) {
  return request(base, `/v1/runs/${encodeURIComponent(runId)}/events?cursor=${cursor}&limit=${limit}`, { key });
}

export async function postCancel(base, key, runId, body = {}) {
  return request(base, `/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', key, body });
}

/** Полная выборка событий по cursor-пагинации. */
export async function collectAllEvents(base, key, runId, options = {}) {
  const from = options.from ?? 0;
  const events = [];
  let cursor = from;
  for (;;) {
    const page = await getEvents(base, key, runId, cursor, 1000);
    if (page.status !== 200) {
      throw new Error(`events page failed: HTTP ${page.status} ${page.text.slice(0, 200)}`);
    }
    events.push(...page.json.events);
    cursor = page.json.cursor;
    if (!page.json.hasMore) break;
    if (events.length > 20000) throw new Error('events runaway');
  }
  return events;
}

export async function waitForStatus(base, key, runId, predicate, timeoutMs = 15000, label = 'status condition') {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await getStatus(base, key, runId);
    last = response;
    if (response.status === 200 && predicate(response.json)) return response.json;
    await sleep(40);
  }
  const detail = last ? `HTTP ${last.status} ${JSON.stringify(last.json)}` : 'no response';
  throw new Error(`timeout waiting for ${label}; last status: ${detail}`);
}

export async function waitTerminal(base, key, runId, timeoutMs = 20000) {
  return waitForStatus(
    base,
    key,
    runId,
    (status) => status.state === 'succeeded' || status.state === 'failed' || status.state === 'cancelled',
    timeoutMs,
    `terminal state of ${runId}`,
  );
}

function parseSseBlock(block) {
  const frame = { id: undefined, event: undefined, data: undefined };
  for (const line of block.split('\n')) {
    if (line.startsWith('id:')) frame.id = line.slice(3).trim();
    else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
    else if (line.startsWith('data:')) frame.data = line.slice(5).trim();
  }
  return frame;
}

export class EventStream {
  constructor(response, controller) {
    this.response = response;
    this.controller = controller;
    this.reader = response.body.getReader();
    this.frames = [];
    this.buffer = '';
    this.decoder = new TextDecoder();
    this.done = false;
    this.error = null;
    this.loop = this.pump();
  }

  async pump() {
    try {
      for (;;) {
        const chunk = await this.reader.read();
        if (chunk.done) break;
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
        this.drain();
      }
      this.drain(true);
    } catch (err) {
      if (!this.controller.signal.aborted) this.error = err;
    } finally {
      this.done = true;
    }
  }

  drain(final = false) {
    let index = this.buffer.indexOf('\n\n');
    while (index >= 0) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      if (block.trim().length > 0) this.frames.push(parseSseBlock(block));
      index = this.buffer.indexOf('\n\n');
    }
    if (final && this.buffer.trim().length > 0) this.frames.push(parseSseBlock(this.buffer));
  }

  eventFrames() {
    return this.frames.filter((frame) => frame.event && frame.event !== 'snapshot');
  }

  lastEventId() {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (frame.id) return Number(frame.id);
    }
    return 0;
  }

  async waitFor(predicate, timeoutMs = 10000, label = 'sse condition') {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.frames)) {
      if (this.done && !predicate(this.frames)) {
        throw new Error(`sse stream ended before ${label}; frames: ${JSON.stringify(this.frames.map((f) => f.event ?? '?'))}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for ${label}; frames: ${JSON.stringify(this.frames.map((f) => f.event ?? '?'))}`);
      }
      await sleep(20);
    }
    return this.frames;
  }

  close() {
    try {
      this.controller.abort();
    } catch {
      // already closed
    }
  }
}

export async function openEventStream(base, key, runId, options = {}) {
  const controller = options.controller ?? new AbortController();
  const headers = { ...authHeaders(key), accept: 'text/event-stream' };
  if (options.cursor !== undefined) headers['last-event-id'] = String(options.cursor);
  const response = await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}/events`, {
    headers,
    signal: controller.signal,
  });
  if (response.status !== 200) {
    const text = await response.text();
    throw new Error(`sse open failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return new EventStream(response, controller);
}

export async function downloadArtifact(base, key, runId, ref) {
  const query = `?ref=${encodeURIComponent(ref)}`;
  const response = await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}/download${query}`, {
    headers: authHeaders(key),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    buffer,
    sha256: response.headers.get('x-e2e-sha256'),
    fileMode: response.headers.get('x-e2e-file-mode'),
    contentType: response.headers.get('content-type'),
    errorBody: response.headers.get('content-type')?.includes('application/json') ? buffer.toString('utf8') : null,
  };
}

export class ControlClient {
  constructor(base, token) {
    this.base = base;
    this.token = token;
  }

  async call(path, options = {}) {
    return request(this.base, path, {
      ...options,
      headers: { 'x-e2e-control-token': this.token, ...(options.headers ?? {}) },
    });
  }

  async health() {
    const response = await this.call('/_e2e/health');
    if (response.status !== 200) throw new Error(`control health failed: HTTP ${response.status} ${response.text.slice(0, 200)}`);
    return response.json;
  }

  async injectFault(point, spec = { kind: 'throw', once: true }) {
    const response = await this.call('/_e2e/fault', { method: 'POST', body: { point, ...spec } });
    if (response.status !== 200) throw new Error(`fault inject failed: HTTP ${response.status} ${response.text.slice(0, 200)}`);
    return response.json;
  }

  async clearFaults() {
    const response = await this.call('/_e2e/fault/clear', { method: 'POST', body: {} });
    if (response.status !== 200) throw new Error(`fault clear failed: HTTP ${response.status}`);
    return response.json;
  }

  async credAttempts() {
    const response = await this.call('/_e2e/cred/attempts');
    if (response.status !== 200) throw new Error(`cred attempts failed: HTTP ${response.status}`);
    return response.json;
  }
}
