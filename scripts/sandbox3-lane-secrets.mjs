#!/usr/bin/env node
/**
 * Provision the sandbox3 lane's shared secrets from the repository secret store.
 * Mirrors the pattern used by `tools/deploy-cloudflare-telegram-ux-sandbox.mjs`
 * and `tools/deploy-cloudflare-production.mjs`.
 *
 * This script writes the lane's shared secrets onto the sandbox3 Cloudflare
 * Worker. It does NOT redeploy the Worker — the reviewed source is deployed
 * separately by the sandbox3 workflow.
 *
 * Required environment (repository secret store, visible to the `sandbox` env):
 *   - CF_API_TOKEN: Cloudflare API token with Worker:Edit on the account
 *   - LLM_LADDER_TOKEN: the model ladder provider token
 *
 * The script is idempotent and is meant to run on every deploy of the lane so
 * the Worker cannot silently drift away from the repository secret store.
 */

import { spawnSync } from 'node:child_process';

export const SANDBOX3_WORKER = 'trained-assist-runner-api-sandbox3';
export const SANDBOX3_CONFIG = 'wrangler.sandbox3.jsonc';

/**
 * Reads a required secret from the given environment.
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {number} minimumLength
 * @returns {string}
 */
export function sandbox3LaneSecret(env, name, minimumLength = 1) {
  const value = typeof env?.[name] === 'string' ? env[name].trim() : '';
  if (!value || value.length < minimumLength) {
    throw new Error(`sandbox3_lane_secret_invalid:${name}`);
  }
  return value;
}

/**
 * Writes one secret onto the sandbox3 Worker.
 * @param {string} name
 * @param {string} value
 */
export function putSandbox3Secret(name, value) {
  const result = spawnSync('npx', [
    'wrangler', 'secret', 'put', name,
    '--name', SANDBOX3_WORKER,
    '--config', SANDBOX3_CONFIG,
  ], {
    input: value,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CF_API_TOKEN },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`sandbox3_secret_provision_failed:${name}`);
  }
}

/**
 * Provisions the sandbox3 lane's shared secrets onto the Worker.
 *
 * Only the secrets the lane needs from the repository secret store are
 * written. The lane's own registries (key registry, developer registry,
 * credential-intake registry) are provisioned by their dedicated scripts and
 * are deliberately left untouched here.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(name: string, value: string) => void} putSecret
 * @returns {{ worker: string; secrets: string[] }}
 */
export function provisionSandbox3LaneSecrets(env = process.env, putSecret = putSandbox3Secret) {
  sandbox3LaneSecret(env, 'CF_API_TOKEN', 20);
  const ladderToken = sandbox3LaneSecret(env, 'LLM_LADDER_TOKEN', 1);

  putSecret('LLM_LADDER_TOKEN', ladderToken);

  return { worker: SANDBOX3_WORKER, secrets: ['LLM_LADDER_TOKEN'] };
}

if (process.argv[1]?.endsWith('/sandbox3-lane-secrets.mjs')) {
  try {
    const result = provisionSandbox3LaneSecrets();
    console.log(JSON.stringify({ ...result, provisioned: true }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'sandbox3_lane_secrets_provision_failed';
    console.error(message);
    process.exitCode = 1;
  }
}
