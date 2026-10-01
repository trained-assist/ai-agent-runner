import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Step,
  buildIssueDraft,
  findSecretsInText,
  findSecretsInTree,
  redact,
  sha256Hex,
  summarize,
  validateEventChain,
} from '../scripts/e2e-loop/checks.mjs';

function event(sequence: number, type: string): { sequence: number; type: string } {
  return { sequence, type };
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-e2e-checks-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('validateEventChain', () => {
  it('принимает полную упорядоченную цепочку до succeeded', () => {
    const events = [
      event(1, 'claimed'),
      event(2, 'materialized'),
      event(3, 'started'),
      event(4, 'log'),
      event(5, 'exit'),
      event(6, 'finalizing'),
      event(7, 'succeeded'),
    ];
    expect(validateEventChain(events, { requireTerminal: true })).toEqual({ ok: true, problems: [] });
  });

  it('ловит пропуск sequence', () => {
    const events = [event(1, 'claimed'), event(2, 'materialized'), event(4, 'started')];
    const result = validateEventChain(events);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('sequence gap');
  });

  it('ловит повторный claimed (rerun)', () => {
    const events = [event(1, 'claimed'), event(2, 'materialized'), event(3, 'claimed')];
    const result = validateEventChain(events);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('exactly one "claimed"');
  });

  it('ловит откат жизненного цикла (started после finalizing)', () => {
    const events = [
      event(1, 'claimed'),
      event(2, 'materialized'),
      event(3, 'started'),
      event(4, 'finalizing'),
      event(5, 'started'),
    ];
    const result = validateEventChain(events);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('out of order');
  });

  it('ловит терминальное событие не в конце и его отсутствие при requireTerminal', () => {
    const notLast = [event(1, 'claimed'), event(2, 'succeeded'), event(3, 'log')];
    expect(validateEventChain(notLast).ok).toBe(false);

    const noTerminal = [event(1, 'claimed'), event(2, 'materialized'), event(3, 'started')];
    const result = validateEventChain(noTerminal, { requireTerminal: true });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('no terminal event');
  });

  it('connection_lost и log не нарушают порядок, первое событие должно быть claimed', () => {
    const ok = [
      event(1, 'claimed'),
      event(2, 'materialized'),
      event(3, 'started'),
      event(4, 'connection_lost'),
      event(5, 'log'),
      event(6, 'exit'),
      event(7, 'finalizing'),
      event(8, 'cancelled'),
    ];
    expect(validateEventChain(ok, { requireTerminal: true }).ok).toBe(true);

    const wrongFirst = [event(1, 'started'), event(2, 'succeeded')];
    const result = validateEventChain(wrongFirst);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('first event');
  });

  it('пустая цепочка — провал', () => {
    expect(validateEventChain([])).toEqual({ ok: false, problems: ['event chain is empty'] });
  });
});

describe('Step и отчётность', () => {
  it('шаг с упавшей проверкой = FAIL, с успешными = PASS', () => {
    const pass = new Step('step-x', 'title');
    pass.check('a', true);
    expect(pass.status).toBe('PASS');
    const finishedPass = pass.finish();
    expect(finishedPass.status).toBe('PASS');
    expect(finishedPass.checks).toHaveLength(1);

    const fail = new Step('step-y', 'title');
    fail.check('a', true);
    fail.fail('b', 'наблюдение');
    expect(fail.status).toBe('FAIL');
    const finishedFail = fail.finish();
    expect(finishedFail.status).toBe('FAIL');
    expect(finishedFail.checks.find((check) => check.name === 'b')?.detail).toBe('наблюдение');
  });

  it('без единой проверки шаг считается проваленным', () => {
    expect(new Step('step-z', 'title').status).toBe('FAIL');
  });

  it('buildIssueDraft включает упавшие проверки и reproduction', () => {
    const step = new Step('step-5-security-probes', 'Security-пробы');
    step.check('хорошая проверка', true);
    step.fail('плохая проверка', 'verdict=LEAKED');
    step.reproduction = 'node scripts/e2e-loop.mjs --root /data --only step-5';
    const draft = buildIssueDraft(step);
    expect(draft.title).toContain('step-5-security-probes');
    expect(draft.body).toContain('плохая проверка: verdict=LEAKED');
    expect(draft.body).toContain('--only step-5');
    expect(draft.body).not.toContain('хорошая проверка');
  });

  it('summarize считает PASS/FAIL и даёт ok только когда провалов нет', () => {
    expect(summarize([{ status: 'PASS' }, { status: 'PASS' }])).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0, ok: true });
    expect(summarize([{ status: 'PASS' }, { status: 'FAIL' }]).ok).toBe(false);
    expect(summarize([{ status: 'SKIP' }])).toEqual({ total: 1, passed: 0, failed: 0, skipped: 1, ok: true });
  });
});

describe('поиск секретов и редакция', () => {
  it('находит секрет в файле дерева и в тексте, значения не отдаёт наружу', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'log.txt'), 'ok line\nsk-e2e-read-deadbeef\n');
    writeFileSync(join(dir, 'clean.txt'), 'nothing here');
    const hits = findSecretsInTree(dir, ['sk-e2e-read-deadbeef', 'absent-secret']);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.secretIndex).toBe(0);
    expect(Object.keys(hits[0]!)).not.toContain('secret');

    expect(findSecretsInText('prefix sk-e2e-read-deadbeef suffix', ['sk-e2e-read-deadbeef'])).toEqual([{ secretIndex: 0 }]);
    expect(findSecretsInText('clean', ['sk-e2e-read-deadbeef'])).toEqual([]);
  });

  it('redact заменяет секреты, sha256Hex стабилен', () => {
    expect(redact('token=abc123 other', ['abc123'])).toBe('token=[redacted:e2e-secret] other');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
