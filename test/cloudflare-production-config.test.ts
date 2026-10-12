import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync(new URL('../wrangler.production.jsonc', import.meta.url), 'utf8'));

describe('production Cloudflare Runner config', () => {
  it('uses a dedicated production Worker and Durable Object namespace', () => {
    expect(config.name).toBe('trained-assist-runner-api-production');
    expect(config.durable_objects.bindings).toEqual([
      { name: 'RUNNER_RUNS', class_name: 'RunnerRunCoordinator' },
    ]);
    expect(config.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['RunnerRunCoordinator'] },
    ]);
  });

  it('defaults to France and fails closed for runs until production profiles are explicitly approved', () => {
    expect(config.vars.RUNNER_ENGINE).toBe('eu-vm-agent-run');
    expect(config.vars.MOCK_TEST_ENABLED).toBe('false');
    expect(config.vars.ALLOWED_REPOSITORIES).toBe('');
    expect(config.vars.ALLOWED_ENVIRONMENT_NAMES).toBe('');
    expect(config.vars.RUNNER_API_PUBLIC_URL).toBe(
      'https://trained-assist-runner-api-production.skillset-apply.workers.dev',
    );
    expect(config.vars.SANDBOX_CLEANUP_PROFILES).toBeUndefined();
  });
});
