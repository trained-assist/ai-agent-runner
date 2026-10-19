import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Provisions the credential intake lane on the dedicated sandbox3 Worker.
//
// It writes the ZeroCreds wallet configuration and one additive credential
// principal. Every write goes to its own Cloudflare secret, so the base
// registry, the sandbox3 registry, the developer registry and the additional
// registry of the lane are left untouched. The script never prints a secret
// and never redeploys the Worker: the reviewed source is deployed by the
// sandbox3 workflow.
const apiKey = process.env.CREDENTIAL_INTAKE_API_KEY;
if (typeof apiKey !== 'string' || apiKey.length < 32) throw new Error('credential intake API key is unavailable');
if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('Cloudflare sandbox token is unavailable');

const walletUrl = process.env.ZEROCREDS_WALLET_API_URL;
const issuer = process.env.ZEROCREDS_WALLET_ASSERTION_ISSUER;
const kid = process.env.ZEROCREDS_WALLET_ASSERTION_KID;
const privateJwk = process.env.ZEROCREDS_WALLET_ASSERTION_PRIVATE_JWK;
const profiles = process.env.ZEROCREDS_WALLET_PROFILES;
if (!walletUrl || !issuer || !kid || !privateJwk || !profiles) throw new Error('ZeroCreds wallet configuration is unavailable');

const profileId = process.env.CREDENTIAL_INTAKE_PROFILE_ID ?? 'sandbox3-credential-intake';
const records = [{
  keyHash: createHash('sha256').update(apiKey).digest('hex'),
  principalId: profileId,
  profileId,
  repository: 'trained-assist/ai-agent-runner',
  scopes: ['credentials:read', 'credentials:write'],
}];

function put(name, value) {
  const result = spawnSync('npx', [
    'wrangler', 'secret', 'put', name,
    '--name', 'trained-assist-runner-api-sandbox3',
    '--config', 'wrangler.sandbox3.jsonc',
  ], { input: value, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error(`failed to provision ${name}`);
}

put('RUNNER_API_KEYS_CREDENTIALS', JSON.stringify(records));
put('ZEROCREDS_WALLET_API_URL', walletUrl);
put('ZEROCREDS_WALLET_ASSERTION_ISSUER', issuer);
put('ZEROCREDS_WALLET_ASSERTION_KID', kid);
put('ZEROCREDS_WALLET_ASSERTION_PRIVATE_JWK', privateJwk);
put('ZEROCREDS_WALLET_PROFILES', profiles);
console.log('Provisioned the credential intake principal and the ZeroCreds wallet configuration on the sandbox3 Worker.');
