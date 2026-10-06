const token = process.env.LLM_LADDER_TOKEN;
const endpoint = 'https://llm-ladder.trainedassist.store/v1/chat/completions';
const startedAt = performance.now();
let deltaCount = 0;
let textCharacters = 0;
let firstDeltaAt = null;
let lastDeltaAt = null;
let readCycle = 0;
const contentReadCycles = new Set();
let pending = '';
let dataLines = [];

function processEvent() {
  if (dataLines.length === 0) return;
  const data = dataLines.join('\n');
  dataLines = [];
  if (data === '[DONE]') return;

  let event;
  try {
    event = JSON.parse(data);
  } catch {
    throw new Error('Ladder emitted a malformed SSE event (body hidden).');
  }

  const content = event.choices?.[0]?.delta?.content;
  const length = typeof content === 'string'
    ? content.length
    : Array.isArray(content)
      ? content.reduce((sum, item) => sum + (typeof item?.text === 'string' ? item.text.length : 0), 0)
      : 0;
  if (length === 0) return;

  const now = performance.now();
  deltaCount += 1;
  textCharacters += length;
  firstDeltaAt ??= now;
  lastDeltaAt = now;
  contentReadCycles.add(readCycle);
  // Make arrival observable while keeping the model response out of the logs.
  console.log(`SSE content delta #${deltaCount} at +${Math.round(now - startedAt)}ms (${length} chars; hidden)`);
}

function processLine(line) {
  if (line === '') {
    processEvent();
    return;
  }
  if (line.startsWith(':')) return;
  const separator = line.indexOf(':');
  const field = separator < 0 ? line : line.slice(0, separator);
  if (field === 'data') {
    dataLines.push(separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, ''));
  }
}

async function consumeSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (value?.byteLength) readCycle += 1;
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) processLine(line);
    if (done) break;
  }
  if (pending) processLine(pending);
  processEvent();
}

if (process.argv.includes('--self-test')) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n'));
      setTimeout(() => {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"world"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }, 10);
    },
  });
  await consumeSse(body);
  if (deltaCount !== 2 || contentReadCycles.size !== 2) {
    console.error('SSE parser self-test failed.');
    process.exit(1);
  }
  console.log('SSE parser self-test passed.');
  process.exit(0);
}

if (!token) {
  console.error('LLM_LADDER_TOKEN is unavailable; refusing to run the live Ladder canary.');
  process.exit(1);
}

try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: 'free',
      stream: true,
      max_tokens: 80,
      temperature: 0,
      messages: [{ role: 'user', content: 'Reply with a short sentence confirming streaming works.' }],
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) {
    console.error(`Ladder streaming request failed with HTTP ${response.status}; response body hidden.`);
    process.exit(1);
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    console.error('Ladder did not return text/event-stream content.');
    process.exit(1);
  }
  if (!response.body) throw new Error('Ladder response had no readable body.');

  await consumeSse(response.body);

  const spanMs = firstDeltaAt === null || lastDeltaAt === null ? 0 : Math.round(lastDeltaAt - firstDeltaAt);
  console.log(`SSE summary: content_deltas=${deltaCount}, read_cycles=${contentReadCycles.size}, chars=${textCharacters}, first_delta_ms=${firstDeltaAt === null ? 'none' : Math.round(firstDeltaAt - startedAt)}, delta_span_ms=${spanMs}`);
  if (deltaCount < 2 || contentReadCycles.size < 2) {
    console.error('Streaming canary failed: expected content in at least two separate network reads; response content hidden.');
    process.exit(1);
  }
  console.log('Streaming canary passed: multiple incremental content deltas received; response content hidden.');
} catch (error) {
  console.error(`Streaming canary failed: ${error instanceof Error ? error.message : 'unknown error'}; response content hidden.`);
  process.exit(1);
}
