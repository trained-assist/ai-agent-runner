import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pinFromDecision, readOpenCodePin, writeOpenCodePin } from '../scripts/update-opencode-release-pin.mjs';

const pinned = {
  OPENCODE_RELEASE_TAG: 'mem-preview-20261018-trim-web-serve-17355bd',
  OPENCODE_VERSION: '0.0.0-trim-web-serve-202610172230',
  OPENCODE_SOURCE_SHA: '1'.repeat(40),
  OPENCODE_ARCHIVE_SHA256: 'a'.repeat(64),
  OPENCODE_BINARY_SHA256: 'b'.repeat(64),
};

const nextPin = {
  OPENCODE_RELEASE_TAG: 'mem-preview-20261019-mem-v2-950f0d8',
  OPENCODE_VERSION: '0.0.0-fork-at-950f0d869b8d',
  OPENCODE_SOURCE_SHA: '9'.repeat(40),
  OPENCODE_ARCHIVE_SHA256: 'c'.repeat(64),
  OPENCODE_BINARY_SHA256: 'd'.repeat(64),
};

const pinFile = `${JSON.stringify(pinned, null, 2)}\n`;

describe('OpenCode fork pin of the VM worker release', () => {
  it('reads all five pinned values', () => {
    expect(readOpenCodePin(pinFile)).toEqual(pinned);
  });

  it('rewrites the whole pin and leaves everything else in the file untouched', () => {
    const withNote = `${JSON.stringify({ ...pinned, note: 'built by the promotion gate' }, null, 2)}\n`;
    const updated = writeOpenCodePin(withNote, nextPin);
    expect(readOpenCodePin(updated)).toEqual(nextPin);
    expect(updated).toContain('"note": "built by the promotion gate"');
  });

  it('refuses an incomplete or malformed pin instead of guessing', () => {
    expect(() => readOpenCodePin('{ "OPENCODE_VERSION": "1.2.3" }')).toThrow('missing OPENCODE_RELEASE_TAG');
    expect(() => readOpenCodePin('not json')).toThrow('not valid JSON');
    expect(() => writeOpenCodePin(pinFile, { ...nextPin, OPENCODE_SOURCE_SHA: '950f0d8' })).toThrow('full 40-character Git SHA');
    expect(() => writeOpenCodePin(pinFile, { ...nextPin, OPENCODE_BINARY_SHA256: 'short' })).toThrow('64 lowercase hex');
    expect(() => writeOpenCodePin(pinFile, { ...nextPin, OPENCODE_RELEASE_TAG: 'nightly' })).toThrow('Invalid fork release tag');
    expect(() => writeOpenCodePin(pinFile, { ...nextPin, OPENCODE_VERSION: '' })).toThrow('plain version string');
    expect(() => writeOpenCodePin(pinFile, { ...nextPin, OPENCODE_VERSION: '1.0.0; rm -rf /' })).toThrow('plain version string');
  });

  it('builds a pin only from a green gate decision', () => {
    const candidate = {
      tag: nextPin.OPENCODE_RELEASE_TAG,
      version: nextPin.OPENCODE_VERSION,
      sourceCommit: nextPin.OPENCODE_SOURCE_SHA,
      archiveSha256: nextPin.OPENCODE_ARCHIVE_SHA256,
      binarySha256: nextPin.OPENCODE_BINARY_SHA256,
    };
    expect(pinFromDecision({ outcome: 'promote', candidate })).toEqual(nextPin);
    expect(() => pinFromDecision({ outcome: 'hold', candidate })).toThrow('not a promotion');
  });

  it('rewrites the pin file in place when the command runs without an output path', () => {
    // Хук промоушена вызывает скрипт с двумя аргументами и ждёт, что файл
    // изменится. Раньше скрипт только печатал новый YAML: пин оставался
    // прежним, а хук рапортовал об успешном промоушене.
    const dir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-pin-'));
    const pinPath = join(dir, 'opencode-release-pin.json');
    writeFileSync(pinPath, pinFile);
    const decisionPath = join(dir, 'promotion-decision.json');
    writeFileSync(decisionPath, JSON.stringify({
      outcome: 'promote',
      candidate: {
        tag: nextPin.OPENCODE_RELEASE_TAG,
        version: nextPin.OPENCODE_VERSION,
        sourceCommit: nextPin.OPENCODE_SOURCE_SHA,
        archiveSha256: nextPin.OPENCODE_ARCHIVE_SHA256,
        binarySha256: nextPin.OPENCODE_BINARY_SHA256,
      },
    }));

    const script = fileURLToPath(new URL('../scripts/update-opencode-release-pin.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, decisionPath, pinPath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(readOpenCodePin(readFileSync(pinPath, 'utf8'))).toEqual(nextPin);
  });

  it('keeps the pinned build of the repository in a data file the CI token may change', () => {
    // Пин не может лежать в .github/workflows: токен GitHub Actions не меняет
    // файлы workflow, поэтому хук промоушена не мог доставить новый пин сам.
    const repoPin = readFileSync(new URL('../deploy/vm-worker/opencode-release-pin.json', import.meta.url), 'utf8');
    expect(readOpenCodePin(repoPin)).toBeTruthy();
    const workflow = readFileSync(new URL('../.github/workflows/vm-worker-release.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('node scripts/read-opencode-release-pin.mjs deploy/vm-worker/opencode-release-pin.json');
    expect(workflow).not.toMatch(/^\s*OPENCODE_(RELEASE_TAG|VERSION|SOURCE_SHA|ARCHIVE_SHA256|BINARY_SHA256):/m);
  });
});
