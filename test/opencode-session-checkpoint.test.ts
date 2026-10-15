import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeAdapter } from '../src/adapters/engine/opencode-adapter.js';
import { createHarness } from './helpers.js';

describe('durable OpenCode session checkpoint', () => {
  it('exports to verified storage and restores the same session before the next run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opencode-session-checkpoint-'));
    try {
      const binary = join(root, 'opencode-stub.sh');
      const expected = join(root, 'expected-session-id');
      writeFileSync(binary, [
        '#!/bin/sh',
        'mkdir -p "$PWD/.runner"',
        'if [ "$1" = "import" ]; then touch "$PWD/.runner/imported"; exit 0; fi',
        'if [ "$1" = "export" ]; then printf \'{"info":{"id":"%s"},"messages":[{"role":"assistant"}]}\\n\' "$2"; exit 0; fi',
        '[ "$1" = "run" ] || exit 20',
        'session_id="ses_01J9A3J9Y7V8W2K4M6N0PQRSTZ"; previous=""',
        'for arg in "$@"; do if [ "$previous" = "--session" ]; then session_id="$arg"; fi; previous="$arg"; done',
        'if [ -f "$EXPECTED_SESSION" ]; then [ "$(cat "$EXPECTED_SESSION")" = "$session_id" ] || exit 22; else printf "%s" "$session_id" > "$EXPECTED_SESSION"; fi',
        'if [ -f "$PWD/.runner/imported" ]; then echo "resumed" > "$PWD/.runner/resume-proof"; fi',
        'printf \'{"type":"text","sessionID":"%s","part":{"type":"text","text":"step done"}}\\n\' "$session_id"',
      ].join('\n'));
      chmodSync(binary, 0o700);

      const h = createHarness({
        rootDir: root,
        artifactExport: true,
        adapters: { opencode: new OpenCodeAdapter({ binary }) },
      });
      const common = {
        engine: { name: 'opencode', adapterVersion: '1' },
        userTaskId: 'task-resume-checkpoint',
        profileId: 'profile-resume-checkpoint',
      } as const;
      process.env['EXPECTED_SESSION'] = expected;
      const first = h.start({
        ...common,
        input: { inlinePrompt: 'Perform the first step.' },
        cwd: join(root, 'workspace-first'),
        envAllowlist: ['EXPECTED_SESSION'],
      });
      // The adapter inherits only allowlisted runner variables; the local harness uses
      // the marker path to make the stub assert exact session continuity.
      const firstResult = await h.runner.waitFor(first.receipt.runId);
      const checkpoint = firstResult.sessionCheckpoint;
      expect(firstResult.persistence).toBe('not_required');
      expect(checkpoint?.artifactId).toBeTruthy();
      const savedBytes = await h.artifacts?.read(first.receipt.runId, checkpoint!.artifactId);
      const savedId = JSON.parse(savedBytes!.bytes.toString('utf8')) as { info: { id: string } };
      expect(savedId.info.id).toBe(readFileSync(expected, 'utf8'));

      const second = h.start({
        ...common,
        input: {
          inlinePrompt: 'Continue after the user replied.',
          resumeSessionFrom: { runId: first.receipt.runId, artifactId: checkpoint!.artifactId },
        },
        cwd: join(root, 'workspace-second'),
        envAllowlist: ['EXPECTED_SESSION'],
      });
      const secondResult = await h.runner.waitFor(second.receipt.runId);
      expect(secondResult.sessionCheckpoint?.sessionId).toBe(savedId.info.id);
      expect(readFileSync(expected, 'utf8')).toBe(savedId.info.id);
    } finally {
      delete process.env['EXPECTED_SESSION'];
      rmSync(root, { recursive: true, force: true });
    }
  });
});
