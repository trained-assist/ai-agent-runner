#!/usr/bin/env node
// Mock worker for local dev — implements /v1/launch, /v1/runs/{id}/status, /v1/runs/{id}/result
// When OPENCODE_BIN is set (or `opencode` is on PATH), /v1/launch actually runs
// `opencode run` with spec.input.inlinePrompt instead of faking the result.

import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { URL } from 'url';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PORT = 9999;
const OPENCODE_CONFIG_PATH = '/tmp/opencode-playwright-mcp.json';
function ensureOpencodeBrowserConfig() {
  let base = {};
  try { base = JSON.parse(readFileSync('/Users/vova/.config/opencode/opencode.json', 'utf8')); } catch {}
  base.mcp = { ...(base.mcp || {}),
    playwright: { type: 'local', command: ['npx', '-y', '@playwright/mcp@latest', '--browser', 'chrome', '--headless', '--user-data-dir', '/tmp/pw-profile', '--ignore-https-errors'], enabled: true }
  };
  writeFileSync(OPENCODE_CONFIG_PATH, JSON.stringify(base, null, 2));
}
ensureOpencodeBrowserConfig();
const HOST = '127.0.0.1';
const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';

function runOpenCode(prompt, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const cwd = mkdtempSync(join(tmpdir(), 'opencode-run-'));
    const child = spawn(OPENCODE_BIN, ['run', prompt], {
      cwd,
      env: { ...process.env, OPENCODE_CONFIG: OPENCODE_CONFIG_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        exitSignal: signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        exitSignal: null,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

const runs = new Map();

function enc(obj, status = 200) {
  return { status, body: JSON.stringify(obj), headers: { 'content-type': 'application/json' } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  console.log(`[${new Date().toISOString()}] ${method} ${path}`);

  try {
    // Health
    if (path === '/healthz' && method === 'GET') {
      const r = enc({ status: 'ok', service: 'mock-worker', ready: true, timestamp: new Date().toISOString() });
      res.writeHead(r.status, r.headers);
      res.end(r.body);
      return;
    }

    // Launch
    if (path === '/v1/launch' && method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const spec = JSON.parse(body);
      const runId = spec.runId;
      const operationId = spec.operationId;

      console.log(`  → Launch run ${runId}, engine: ${spec.engine?.name}`);

      const receipt = {
        runId,
        operationId,
        status: 'accepted',
        statusUrl: `http://${HOST}:${PORT}/v1/runs/${runId}/status`,
        resultUrl: `http://${HOST}:${PORT}/v1/runs/${runId}/result`
      };

      // Store run state
      runs.set(runId, { status: 'running', spec, receipt, completed: false });

      // Actually run opencode with the prompt
      const prompt = spec.input?.inlinePrompt ?? 'hello';
      const timeoutMs = spec.limits?.timeoutMs ?? 120000;
      console.log(`  → Running opencode for ${runId} (timeout ${timeoutMs}ms)`);
      void runOpenCode(prompt, timeoutMs).then((r) => {
        const run = runs.get(runId);
        if (!run) return;
        run.status = r.timedOut || r.exitCode !== 0 ? 'failed' : 'succeeded';
        run.completed = true;
        run.result = {
          runId,
          status: 'started',
          pid: null,
          exitCode: r.exitCode,
          exitSignal: r.exitSignal,
          exitReason: r.timedOut ? 'timeout' : r.exitCode === 0 ? 'completed' : 'nonzero_exit',
          stdout: r.stdout,
          stderr: r.stderr,
          answer: r.stdout.trim() || null,
          answerSource: 'engine_stdout',
          durationMs: r.durationMs,
          timedOut: r.timedOut,
          outputTruncated: false,
          artifacts: [],
          logUrl: '',
          repo: { fullName: 'dev/repo', branch: `agent-run/${runId}`, commit: null, baseRef: 'main' },
          profileChanges: { files: [], deletes: [] },
        };
        console.log(`  ✓ Run ${runId} ${run.status} (exit ${r.exitCode}, ${r.durationMs}ms)`);
      });

      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify(receipt));
      return;
    }

    // Status
    const statusMatch = path.match(/^\/v1\/runs\/([^\/]+)\/status$/);
    if (statusMatch && method === 'GET') {
      const runId = statusMatch[1];
      const run = runs.get(runId);
      
      if (!run) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId, status: 'unknown', updatedAt: new Date().toISOString() }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runId, status: run.status, updatedAt: new Date().toISOString() }));
      return;
    }

    // Result
    const resultMatch = path.match(/^\/v1\/runs\/([^\/]+)\/result$/);
    if (resultMatch && method === 'GET') {
      const runId = resultMatch[1];
      const run = runs.get(runId);
      
      if (!run) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId, status: 'not_ready' }));
        return;
      }

      if (!run.completed) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId, status: 'not_ready' }));
        return;
      }

      const result = run.result ?? {
        runId,
        status: 'started',
        pid: 12345,
        exitCode: 0,
        exitSignal: null,
        exitReason: 'completed',
        stdout: 'Mock agent completed successfully\n',
        stderr: '',
        answer: 'Hello! This is a mock result from the fake agent.',
        answerSource: 'engine_stdout',
        durationMs: 1234,
        timedOut: false,
        outputTruncated: false,
        artifacts: [{ path: 'output.txt', name: 'output.txt', mime: 'text/plain', sha256: 'abc123def456', size: 42 }],
        logUrl: '',
        repo: { fullName: 'dev/repo', branch: `agent-run/${runId}`, commit: 'abc123', baseRef: 'main' },
        profileChanges: { files: [], deletes: [] }
      };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Cancel
    const cancelMatch = path.match(/^\/v1\/runs\/([^\/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const runId = cancelMatch[1];
      const run = runs.get(runId);
      
      if (!run) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'unknown_run' }));
        return;
      }

      run.status = 'cancelled';
      run.completed = true;

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'cancelled' }));
      return;
    }

    // 404
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));

  } catch (err) {
    console.error('Error:', err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🔧 Mock worker listening on http://${HOST}:${PORT}`);
  console.log(`   Health:    http://${HOST}:${PORT}/healthz`);
  console.log(`   Launch:    POST http://${HOST}:${PORT}/v1/launch`);
  console.log(`   Status:    GET  http://${HOST}:${PORT}/v1/runs/{id}/status`);
  console.log(`   Result:    GET  http://${HOST}:${PORT}/v1/runs/{id}/result`);
  console.log(`   Cancel:    POST http://${HOST}:${PORT}/v1/runs/{id}/cancel`);
});