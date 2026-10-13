import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const sourceCommit = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('build source commit must be a full 40-character Git SHA');
const opencodeFields = [process.env.OPENCODE_VERSION, process.env.OPENCODE_SOURCE_SHA, process.env.OPENCODE_BINARY_SHA256];
if (opencodeFields.some(Boolean) && opencodeFields.some((value) => !value)) throw new Error('OpenCode release metadata must be complete');
if (process.env.OPENCODE_SOURCE_SHA && !/^[0-9a-f]{40}$/.test(process.env.OPENCODE_SOURCE_SHA)) throw new Error('OpenCode source commit must be a full 40-character Git SHA');
if (process.env.OPENCODE_BINARY_SHA256 && !/^[0-9a-f]{64}$/.test(process.env.OPENCODE_BINARY_SHA256)) throw new Error('OpenCode binary SHA-256 must be 64 lowercase hex characters');
const output = join(root, 'dist/vm-worker/build-info.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({
  schemaVersion: 1,
  version: packageJson.version,
  sourceCommit,
  builtAt: new Date().toISOString(),
  ...(process.env.OPENCODE_VERSION ? {
    opencode: {
      version: process.env.OPENCODE_VERSION,
      sourceCommit: process.env.OPENCODE_SOURCE_SHA,
      binarySha256: process.env.OPENCODE_BINARY_SHA256,
    },
  } : {}),
  ...(process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? { buildUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` }
    : {}),
}, null, 2)}\n`, { mode: 0o644 });
