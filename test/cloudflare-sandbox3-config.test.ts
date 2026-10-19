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
});
