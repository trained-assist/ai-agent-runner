import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineAdapter } from '../src/adapters/engine/engine-adapter.js';
import { handleForChild } from '../src/adapters/engine/process-tree.js';
import { Runner } from '../src/runner/runner.js';
import { createApiSavebackWorker } from '../src/workspace/api-saveback-worker.js';
import { makeRunSpec } from './helpers.js';

describe('France VM API-owned profile saveback', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of closers.splice(0)) await close(); });

  it('downloads a pinned snapshot, uploads only modifications, records deletions, and keeps the capability out of Runner state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vm-api-profile-saveback-'));
    const profile = join(root, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'state.md'), 'before\n');
    writeFileSync(join(profile, 'remove.md'), 'delete me\n');
    const archive = join(root, 'snapshot.tar.gz');
    execFileSync('tar', ['--format', 'ustar', '-czf', archive, '-C', profile, '.']);
    const archiveBytes = readFileSync(archive);
    const snapshotSha256 = createHash('sha256').update(archiveBytes).digest('hex');
    const uploads: Array<{ path: string; text: string; sha256: string }> = [];
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/snapshot') {
        res.writeHead(200, { 'content-length': archiveBytes.length });
        res.end(archiveBytes);
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/v1/worker/launches/')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const bytes = Buffer.concat(chunks);
          if (req.headers.authorization !== 'Bearer scoped-saveback-capability-1234567890') { res.writeHead(401).end(); return; }
          uploads.push({
            path: new URL(req.url!, 'http://localhost').searchParams.get('path') ?? '',
            text: bytes.toString('utf8'),
            sha256: String(req.headers['x-content-sha256'] ?? ''),
          });
          res.writeHead(201).end();
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('saveback test server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    closers.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });

    const dataDir = join(root, 'worker-data');
    const workspace = join(dataDir, 'workspaces', 'run_vm_profile');
    const engine: EngineAdapter = {
      name: 'fake',
      async start(context) {
        const source = "const fs=require('node:fs');fs.writeFileSync('state.md','after\\n');fs.unlinkSync('remove.md');fs.writeFileSync('new.md','new file\\n');console.log('saveback fixture complete');";
        const child = spawn(process.execPath, ['-e', source], { cwd: context.cwd, env: context.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        return handleForChild(child, { onLog: context.onLog, onExit: context.onExit });
      },
    };
    const runner = new Runner({ rootDir: join(root, 'runner'), adapters: { fake: engine }, profileWorkspace: createApiSavebackWorker(dataDir) });
    closers.push(async () => runner.dispose());
    const spec = makeRunSpec({
      runId: 'run_vm_profile', cwd: workspace,
      repository: { fullName: 'owner/profile', revision: 'a'.repeat(40) },
      profileWorkspace: {
        bindingId: 'binding-a', snapshotUrl: `${base}/snapshot`, snapshotSha256, snapshotSize: archiveBytes.length,
        savebackToken: 'scoped-saveback-capability-1234567890', savebackUrl: `${base}/v1/worker/launches/run_vm_profile/profile-changes`,
        artifacts: [], excludedPatterns: [],
      },
    });
    runner.start(spec);
    const result = await runner.waitFor(spec.runId, 15_000);

    expect(result.outcome).toBe('succeeded');
    expect(result.profileChanges).toEqual({
      files: [
        { path: 'new.md', sha256: createHash('sha256').update('new file\n').digest('hex'), size: 9 },
        { path: 'state.md', sha256: createHash('sha256').update('after\n').digest('hex'), size: 6 },
      ],
      deletes: ['remove.md'],
    });
    expect(uploads.map(({ path, text }) => ({ path, text }))).toEqual([
      { path: 'new.md', text: 'new file\n' },
      { path: 'state.md', text: 'after\n' },
    ]);
    for (const upload of uploads) expect(upload.sha256).toBe(createHash('sha256').update(upload.text).digest('hex'));
    const state = readFileSync(join(root, 'runner', 'runs', spec.runId, 'state.json'), 'utf8');
    expect(state).not.toContain('scoped-saveback-capability');
    expect(state).toContain('profileChanges');
  });
});
