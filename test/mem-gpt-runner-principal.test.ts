import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { memGptRunnerPrincipalRecord, provisionMemGptRunnerPrincipal, MEM_GPT_BINDING, MEM_GPT_PRINCIPAL_ID } from '../scripts/provision-mem-gpt-runner-principal.mjs';

describe('mem-gpt Runner API principal provisioning', () => {
  it('creates a hash-only record bound to the pinned user catalog', () => {
    const apiKey = `ak_${'a'.repeat(48)}`;
    const record = memGptRunnerPrincipalRecord(`${apiKey}\n`);
    expect(record).toEqual({
      keyHash: createHash('sha256').update(apiKey).digest('hex'),
      principalId: MEM_GPT_PRINCIPAL_ID,
      profileId: 'integration-telegram-ux-v1',
      repository: 'trained-assist/ai-agent-runner',
      scopes: ['runs:read', 'runs:write'],
      engines: ['eu-vm-agent-run', 'azure-cloud'],
      mcpBindings: [MEM_GPT_BINDING],
    });
    expect(JSON.stringify(record)).not.toContain(apiKey);
  });

  it('refuses a key that is too short to be an API key', () => {
    expect(() => memGptRunnerPrincipalRecord('short')).toThrow('mem_gpt_runner_api_key_invalid');
  });

  it('refuses to publish without a Cloudflare token', async () => {
    await expect(provisionMemGptRunnerPrincipal({})).rejects.toThrow('mem_gpt_cloudflare_token_missing');
  });
});
