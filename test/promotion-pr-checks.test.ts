import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyPrChecks } from '../scripts/promotion-pr-checks.mjs';

const check = (name: string, conclusion: string | null, status = 'COMPLETED') => ({ name, status, conclusion });

describe('checks of the promotion pull request', () => {
  it('merges only when every check succeeded', () => {
    // У PR несколько проверок, и список приходит одной строкой: сравнение
    // этой строки с одним значением раньше не давало никогда «зелёного» PR,
    // поэтому merge не наступал никогда.
    const verdict = classifyPrChecks([check('check', 'SUCCESS'), check('probe', 'SUCCESS')]);
    expect(verdict.state).toBe('green');
    expect(verdict.failed).toEqual([]);
    expect(verdict.pending).toEqual([]);
  });

  it('keeps waiting while a check is still running', () => {
    const verdict = classifyPrChecks([check('check', 'SUCCESS'), check('probe', null, 'IN_PROGRESS')]);
    expect(verdict.state).toBe('pending');
    expect(verdict.pending).toEqual(['IN_PROGRESS']);
  });

  it('stops on a failed, cancelled or action-required check', () => {
    expect(classifyPrChecks([check('check', 'SUCCESS'), check('probe', 'FAILURE')]).state).toBe('failed');
    expect(classifyPrChecks([check('check', 'CANCELLED')]).state).toBe('failed');
    expect(classifyPrChecks([check('check', 'ACTION_REQUIRED')]).state).toBe('failed');
    expect(classifyPrChecks([check('check', 'TIMED_OUT')]).state).toBe('failed');
  });

  it('reports that no check has started yet instead of guessing green', () => {
    expect(classifyPrChecks([]).state).toBe('none');
    expect(classifyPrChecks(undefined).state).toBe('none');
    expect(classifyPrChecks(null).state).toBe('none');
  });

  it('stops waiting when the pull request is already merged', () => {
    const verdict = classifyPrChecks([check('check', 'SUCCESS')], 'MERGED');
    expect(verdict.state).toBe('merged');
  });

  it('reads the verdict the hook uses from the pull request payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-pr-checks-'));
    const payloadPath = join(dir, 'pr.json');
    writeFileSync(payloadPath, JSON.stringify({ state: 'OPEN', statusCheckRollup: [check('check', 'SUCCESS')] }));
    const script = fileURLToPath(new URL('../scripts/promotion-pr-checks.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, payloadPath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('green');
  });

  it('reads the verdict from standard input', () => {
    const script = fileURLToPath(new URL('../scripts/promotion-pr-checks.mjs', import.meta.url));
    const payload = JSON.stringify({ state: 'OPEN', statusCheckRollup: [check('check', 'SUCCESS'), check('probe', 'FAILURE')] });
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', input: payload });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('failed');
  });
});
