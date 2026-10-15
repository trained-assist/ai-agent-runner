import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeAdapter } from '../src/adapters/engine/opencode-adapter.js';
import type { RunSpec } from '../src/contracts/run-spec.js';
import type { RunBranchWorker } from '../src/workspace/run-branch-worker.js';
import { createHarness } from './helpers.js';

describe('durable OpenCode session checkpoint', () => {
  it('round-trips through the existing profile archive and resumes the same session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opencode-session-checkpoint-'));
    const archiveRoot = join(root, 'profile-archive');
    mkdirSync(archiveRoot, { recursive: true });
    const manifests = new Map<string, { files: Array<{ path: string; sha256: string; size: number }>; deletes: string[] }>();
    const profileWorkspace: RunBranchWorker = {
      async prepare(_spec, cwd) {
        mkdirSync(cwd, { recursive: true });
        const copyTree = (source: string, target: string) => {
          mkdirSync(target, { recursive: true });
          for (const entry of readdirSync(source, { withFileTypes: true })) {
            const from = join(source, entry.name);
            const to = join(target, entry.name);
            if (entry.isDirectory()) copyTree(from, to);
            else if (entry.isFile()) copyFileSync(from, to);
          }
        };
        copyTree(archiveRoot, cwd);
      },
      async publish(spec, cwd) {
        const sessionDir = join(cwd, '.session-traces');
        const files: Array<{ path: string; sha256: string; size: number }> = [];
        if (existsSync(sessionDir)) {
          for (const name of readdirSync(sessionDir)) {
            if (!name.endsWith('.json')) continue;
            const bytes = readFileSync(join(sessionDir, name));
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            const archivePath = join(archiveRoot, '.session-traces', name);
            mkdirSync(join(archiveRoot, '.session-traces'), { recursive: true });
            writeFileSync(archivePath, bytes, { mode: 0o600 });
            files.push({ path: `.session-traces/${name}`, sha256, size: bytes.length });
          }
        }
        manifests.set(spec.runId, { files, deletes: [] });
        return 'a'.repeat(40);
      },
      changes(spec) { return manifests.get(spec.runId); },
    };
    try {
      const binary = join(root, 'opencode-stub.sh');
      const expected = join(root, 'expected-session-id');
      writeFileSync(binary, [
        '#!/bin/sh',
        'mkdir -p "$PWD/.session-traces"',
        'if [ "$1" = "import" ]; then touch "$PWD/.runner-imported"; exit 0; fi',
        'if [ "$1" = "export" ]; then printf \'{"info":{"id":"%s"},"messages":[{"role":"assistant"}]}\\n\' "$2"; exit 0; fi',
        '[ "$1" = "run" ] || exit 20',
        'session_id="ses_01J9A3J9Y7V8W2K4M6N0PQRSTZ"; previous=""',
        'for arg in "$@"; do if [ "$previous" = "--session" ]; then session_id="$arg"; fi; previous="$arg"; done',
        'if [ -f "$EXPECTED_SESSION" ]; then [ "$(cat "$EXPECTED_SESSION")" = "$session_id" ] || exit 22; else printf "%s" "$session_id" > "$EXPECTED_SESSION"; fi',
        'if [ -f "$PWD/.runner-imported" ]; then echo "resumed" > "$PWD/.runner-resume-proof"; fi',
        'printf \'{"type":"text","sessionID":"%s","part":{"type":"text","text":"step done"}}\\n\' "$session_id"',
      ].join('\n'));
      chmodSync(binary, 0o700);

      const h = createHarness({
        rootDir: join(root, 'runner'),
        profileWorkspace,
        adapters: { opencode: new OpenCodeAdapter({ binary }) },
      });
      const common = {
        engine: { name: 'opencode', adapterVersion: '1' },
        userTaskId: 'task-resume-checkpoint',
        profileId: 'profile-resume-checkpoint',
        repository: { fullName: 'owner/profile', revision: 'b'.repeat(40) },
        profileWorkspace: {
          bindingId: 'binding-profile', snapshotUrl: 'https://example.test/snapshot',
          snapshotSha256: 'c'.repeat(64), snapshotSize: 1, savebackToken: 't'.repeat(43),
          savebackUrl: 'https://example.test/profile-changes', artifacts: [], excludedPatterns: [],
        },
      } satisfies Partial<RunSpec>;
      process.env['EXPECTED_SESSION'] = expected;
      const first = h.start({ ...common, input: { inlinePrompt: 'Perform the first step.' }, envAllowlist: ['EXPECTED_SESSION'] });
      const firstResult = await h.runner.waitFor(first.receipt.runId);
      const checkpoint = firstResult.sessionCheckpoint;
      expect(checkpoint).toMatchObject({
        sourceRunId: first.receipt.runId,
        sessionId: 'ses_01J9A3J9Y7V8W2K4M6N0PQRSTZ',
        path: '.session-traces/ses_01J9A3J9Y7V8W2K4M6N0PQRSTZ.json',
      });
      const archivedPath = join(archiveRoot, '.session-traces', 'ses_01J9A3J9Y7V8W2K4M6N0PQRSTZ.json');
      const archivedBytes = readFileSync(archivedPath);
      expect(createHash('sha256').update(archivedBytes).digest('hex')).toBe(checkpoint?.sha256);
      expect(JSON.parse(archivedBytes.toString('utf8')).info.id).toBe(checkpoint?.sessionId);

      const second = h.start({
        ...common,
        input: { inlinePrompt: 'Continue after the user replied.', resumeSessionFrom: checkpoint },
        envAllowlist: ['EXPECTED_SESSION'],
      });
      const secondResult = await h.runner.waitFor(second.receipt.runId);
      expect(secondResult.sessionCheckpoint?.sessionId).toBe(checkpoint?.sessionId);
      expect(readFileSync(expected, 'utf8')).toBe(checkpoint?.sessionId);
    } finally {
      delete process.env['EXPECTED_SESSION'];
      rmSync(root, { recursive: true, force: true });
    }
  });
});
