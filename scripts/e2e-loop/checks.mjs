import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const TERMINAL_EVENT_TYPES = ['succeeded', 'failed', 'cancelled'];

const RANKED_ORDER = {
  claimed: 0,
  materialized: 1,
  started: 2,
  exit: 3,
  finalizing: 4,
  succeeded: 5,
  failed: 5,
  cancelled: 5,
};

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function isTerminalState(state) {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets ?? []) {
    if (secret) out = out.split(secret).join('[redacted:e2e-secret]');
  }
  return out;
}

/**
 * Проверка полноты/порядка цепочки событий рана.
 * Контракт: sequence идут подряд с 1, первое событие claimed (ровно один),
 * ranked-типы не могут идти назад по жизненному циклу, терминальное событие — последнее.
 * log/connection_lost могут быть в любом месте после materialized.
 */
export function validateEventChain(events, options = {}) {
  const requireTerminal = options.requireTerminal === true;
  const problems = [];
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, problems: ['event chain is empty'] };
  }
  events.forEach((event, index) => {
    if (event.sequence !== index + 1) {
      problems.push(`sequence gap at index ${index}: expected ${index + 1}, got ${event.sequence} (${event.type})`);
    }
  });
  if (events[0].type !== 'claimed') {
    problems.push(`first event is "${events[0].type}", expected "claimed"`);
  }
  const claimedCount = events.filter((event) => event.type === 'claimed').length;
  if (claimedCount !== 1) {
    problems.push(`expected exactly one "claimed" event, got ${claimedCount} (rerun?)`);
  }
  let lastRank = -1;
  for (const event of events) {
    const rank = RANKED_ORDER[event.type];
    if (rank === undefined) continue;
    if (rank < lastRank) {
      problems.push(`out of order: "${event.type}" (rank ${rank}) follows rank ${lastRank} at sequence ${event.sequence}`);
    } else {
      lastRank = rank;
    }
  }
  const terminalIndex = events.findIndex((event) => TERMINAL_EVENT_TYPES.includes(event.type));
  if (terminalIndex >= 0 && terminalIndex !== events.length - 1) {
    problems.push(`terminal event "${events[terminalIndex].type}" is not last (index ${terminalIndex} of ${events.length})`);
  }
  if (requireTerminal && terminalIndex < 0) {
    problems.push('chain has no terminal event (succeeded|failed|cancelled)');
  }
  return { ok: problems.length === 0, problems };
}

export function listFilesRecursive(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Ищет значения секретов в файлах каталога. Возвращает список находок без значений секретов. */
export function findSecretsInTree(root, secrets) {
  const hits = [];
  for (const file of listFilesRecursive(root)) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    secrets.forEach((secret, index) => {
      if (secret && content.includes(secret)) hits.push({ file, secretIndex: index });
    });
  }
  return hits;
}

export function findSecretsInText(text, secrets) {
  const hits = [];
  secrets.forEach((secret, index) => {
    if (secret && String(text).includes(secret)) hits.push({ secretIndex: index });
  });
  return hits;
}

export function describePathMode(path) {
  try {
    const st = statSync(path);
    return { exists: true, mode: st.mode & 0o777, modeText: (st.mode & 0o777).toString(8).padStart(3, '0') };
  } catch (err) {
    return { exists: false, error: err && err.code ? err.code : String(err) };
  }
}

export class Step {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.checks = [];
    this.startedAt = Date.now();
    this.reproduction = null;
    this.issueDraft = null;
  }

  check(name, ok, detail = '') {
    const entry = { name, ok: Boolean(ok) };
    if (detail) entry.detail = detail;
    this.checks.push(entry);
    return entry.ok;
  }

  fail(name, detail) {
    return this.check(name, false, detail);
  }

  get status() {
    return this.checks.length > 0 && this.checks.every((check) => check.ok) ? 'PASS' : 'FAIL';
  }

  finish() {
    const result = {
      id: this.id,
      title: this.title,
      status: this.status,
      durationMs: Date.now() - this.startedAt,
      checks: this.checks,
    };
    if (this.reproduction) result.reproduction = this.reproduction;
    if (this.issueDraft) result.issueDraft = this.issueDraft;
    return result;
  }
}

export function summarize(steps) {
  const passed = steps.filter((step) => step.status === 'PASS').length;
  const failed = steps.filter((step) => step.status === 'FAIL').length;
  const skipped = steps.filter((step) => step.status === 'SKIP').length;
  return { total: steps.length, passed, failed, skipped, ok: failed === 0 && passed + skipped === steps.length };
}

export function buildIssueDraft(step) {
  const failedChecks = step.checks.filter((check) => !check.ok);
  const lines = [
    `E2E acceptance loop: FAIL ${step.id} — ${step.title}`,
    '',
    'Провал из цикла приёмки (issue #2).',
    '',
    '## Упавшие проверки',
    ...failedChecks.map((check) => `- ${check.name}${check.detail ? `: ${check.detail}` : ''}`),
    '',
    '## Reproduction',
    step.reproduction ?? '(см. e2e-loop-report.json)',
    '',
    '## Ожидание',
    'Все проверки шага зелёные на free-only прогоне без платных моделей.',
  ];
  return { title: `e2e-loop: FAIL ${step.id}`, body: lines.join('\n') };
}
