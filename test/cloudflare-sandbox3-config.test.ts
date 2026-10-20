import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync(new URL('../wrangler.sandbox3.jsonc', import.meta.url), 'utf8'));

describe('sandbox3 Cloudflare Runner config', () => {
  it('serves the dedicated sandbox3 Worker with its own Durable Object namespace', () => {
    expect(config.name).toBe('trained-assist-runner-api-sandbox3');
    expect(config.durable_objects.bindings).toEqual([
      { name: 'RUNNER_RUNS', class_name: 'RunnerRunCoordinator' },
    ]);
    expect(config.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['RunnerRunCoordinator'] },
    ]);
  });

  it('fetches other Workers of the same account through the public path', () => {
    // Without this compatibility flag Cloudflare answers a Worker-to-Worker
    // request on the same account with error 1042, so the credential intake
    // would never reach the ZeroCreds wallet API.
    expect(config.compatibility_flags).toContain('global_fetch_strictly_public');
  });

  it('keeps a revoked-connection fixture next to the live credential', () => {
    const registry = JSON.parse(config.vars.ZEROCREDS_WALLET_CREDENTIALS) as Record<
      string, { connection_id: string; env: string; field: string; scope: string }>;
    // "github" is the credential the lane actually uses. "github-revoked" points
    // at a connection that was revoked after intake: its value is gone from the
    // custody store, so a run that asks for it must fail closed instead of
    // starting without the credential. Keeping the ref in the registry is what
    // lets the live lane keep proving that.
    expect(registry['github']?.connection_id).toBe('2aaa6cbc-276c-45fc-9a11-dc4339df6c58');
    expect(registry['github-revoked']?.connection_id).toBe('736af6da-1dea-4933-a1ce-a73c9beb5c4d');
    expect(registry['github-revoked']?.connection_id).not.toBe(registry['github']?.connection_id);
    expect(registry['github-revoked']?.env).toBe(registry['github']?.env);
    expect(registry['github-revoked']?.scope).toBe(registry['github']?.scope);
  });
});
