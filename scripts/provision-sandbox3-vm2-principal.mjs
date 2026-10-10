import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const apiKey = process.env.RUNNER_API_KEY_AGENT_API;
if (typeof apiKey !== 'string' || apiKey.length < 32) throw new Error('sandbox API key is unavailable');
if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('Cloudflare sandbox token is unavailable');

const records = [{
  keyHash: createHash('sha256').update(apiKey).digest('hex'),
  principalId: 'sandbox3-vm2-live-canary',
  profileId: 'sandbox3-vm2-live-canary',
  repository: 'trained-assist/ai-agent-runner',
  scopes: ['runs:read', 'runs:write'],
  engines: ['eu-vm-agent-run'],
}];
const result = spawnSync('npx', [
  'wrangler', 'secret', 'put', 'RUNNER_API_KEYS_ADDITIONAL',
  '--name', 'trained-assist-runner-api-sandbox3',
  '--config', 'wrangler.sandbox3.jsonc',
], { input: JSON.stringify(records), encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] });
if (result.error || result.status !== 0) throw new Error('failed to provision the additive sandbox3 canary principal');
const deploy = spawnSync('npx', ['wrangler', 'deploy', '--config', 'wrangler.sandbox3.jsonc'], {
  encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'],
});
if (deploy.error || deploy.status !== 0) throw new Error('failed to deploy the sandbox3 Worker with additive registry support');
console.log('Provisioned the additive sandbox3 canary principal and deployed the reviewed sandbox Worker without changing its base registry.');
