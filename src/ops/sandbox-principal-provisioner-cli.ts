#!/usr/bin/env node
import { readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { provisionSandboxMockPrincipal } from './sandbox-principal-registry.js';

const REGISTRY_PATH = '/etc/agent-runner/key-registry-mcp-test.json';
const TARGET = 'agent-runner-api-mcp-test';

export function parseSandboxPrincipalProvisionRequest(raw: string): { keyHash: string } {
  if (Buffer.byteLength(raw, 'utf8') > 4096) throw new Error('sandbox_principal_request_too_large');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('sandbox_principal_request_invalid_json'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('sandbox_principal_request_invalid_shape');
  }
  const value = parsed as Record<string, unknown>;
  const expectedKeys = ['keyHash', 'schemaVersion', 'target'].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
    || value['schemaVersion'] !== 1 || value['target'] !== TARGET
    || typeof value['keyHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['keyHash'])) {
    throw new Error('sandbox_principal_request_invalid_shape');
  }
  return { keyHash: value['keyHash'] };
}

export function provisionSandboxPrincipalRequest(raw: string, registryPath = REGISTRY_PATH) {
  const { keyHash } = parseSandboxPrincipalProvisionRequest(raw);
  return provisionSandboxMockPrincipal(registryPath, keyHash);
}

function main(): void {
  if (process.getuid?.() !== 0) throw new Error('sandbox_principal_requires_root');
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(1024);
  let total = 0;
  while (true) {
    const bytes = readSync(0, chunk, 0, chunk.length, null);
    if (bytes === 0) break;
    total += bytes;
    if (total > 4096) throw new Error('sandbox_principal_request_too_large');
    chunks.push(Buffer.from(chunk.subarray(0, bytes)));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const result = provisionSandboxPrincipalRequest(raw);
  process.stdout.write(`${JSON.stringify({ status: result.changed ? 'registered' : 'already_registered', ...result })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    const code = error instanceof Error ? error.message : 'sandbox_principal_provision_failed';
    process.stderr.write(`[sandbox-principal] ${code}\n`);
    process.exitCode = 1;
  }
}
