import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
// `GITHUB_SHA` — коммит события, а не обязательно отчёчекого коммита: при
// dispatch-сборке (тег уже существует, workflow запущен вручную) это голова
// ветки по умолчанию. Поэтому коммит берём явно, если передали.
const sourceCommit = process.env.VM_WORKER_SOURCE_COMMIT || process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('build source commit must be a full 40-character Git SHA');
// Подпись сборки GitHub Actions указывает источником тот ref, которым запустили
// workflow: пуш тега даёт `refs/tags/vm-worker-vX.Y.Z`, а dispatch — ветку
// по умолчанию, даже когда собран по коммиту тега. Апдейтер и дрейф-чек раньше
// требовали теговый ref в подписи, и dispatch-сборка не доезжала до прода.
// Поэтому тег записывается в сам бандл, и его сверяют там.
const sourceRef = process.env.VM_WORKER_SOURCE_REF || '';
if (sourceRef && !/^refs\/tags\/vm-worker-v\d+\.\d+\.\d+$/.test(sourceRef)) throw new Error('build source ref must be an immutable vm-worker-vX.Y.Z tag ref');
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
  ...(sourceRef ? { sourceRef } : {}),
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
