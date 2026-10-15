#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const base = (process.env.RUNNER_API_URL || 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev').replace(/\/+$/, '');
const keyFile = process.env.RUNNER_API_KEY_FILE || join(homedir(), '.config/opencode/secrets/serverless-agent-api-key');
const [action = 'start', id] = process.argv.slice(2).filter((arg) => arg !== '--no-open');
const noOpen = process.argv.includes('--no-open');

if (!/^https:\/\/[^/?#]+$/.test(base)) throw new Error('RUNNER_API_URL must be an HTTPS origin');
if (!['start', 'status', 'revoke'].includes(action)) throw new Error('usage: connect-github-sandbox.mjs start|status ID|revoke ID [--no-open]');
if (action !== 'start' && !/^ghc_[0-9a-f]{32}$/.test(id || '')) throw new Error('a valid connection ID is required');

const apiKey = (await readFile(keyFile, 'utf8')).trim();
if (!apiKey) throw new Error('Runner API key file is empty');
const path = `/v1/developer/github/connections${action === 'start' ? '' : `/${id}`}`;
const method = action === 'start' ? 'POST' : action === 'status' ? 'GET' : 'DELETE';
const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
const result = await response.json();
if (!response.ok) {
  console.error(JSON.stringify(result));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result, null, 2));
  if (action === 'start' && !noOpen && process.platform === 'darwin' && typeof result.formUrl === 'string') {
    const browser = spawn('open', [result.formUrl], { stdio: 'ignore' });
    browser.unref();
  }
}
