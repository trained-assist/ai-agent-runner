import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineStartupError } from '../../contracts/validate.js';
import type { RunSpec } from '../../contracts/run-spec.js';
import type { EngineAdapter, EngineHandle, EngineStartContext } from './engine-adapter.js';
import { launchCommand } from './launch.js';
import { findOnPath, handleForChild, isExecutableFile } from './process-tree.js';

export interface OpenCodeAdapterOptions {
  binary?: string;
  argv?: string[];
}

function defaultArgv(spec: RunSpec, sessionId?: string): string[] {
  const prompt = spec.input?.inlinePrompt;
  if (!prompt) {
    throw new EngineStartupError('opencode run requires a host-resolved input.inlinePrompt');
  }
  if (!spec.ingressManifest) return ['run', prompt, '--format', 'json', ...(sessionId ? ['--session', sessionId] : [])];
  const indexPath = join(spec.cwd, '.inputs', 'ingress', spec.runId, 'input-items.json');
  try {
    if (!lstatSync(indexPath).isFile()) throw new Error('not a regular file');
  } catch {
    throw new EngineStartupError('opencode ingress input index is not materialized');
  }
  const instruction = [
    'Runtime input bundle: read the ordered items in the platform-materialized index at',
    `${JSON.stringify(indexPath)}. Process inputItems in array order and handle each item as a unit; its text is verbatim user input and its artifacts belong with that text.`,
    'Artifact paths are relative to the index directory; read the referenced files as needed. Do not infer order from filenames.',
  ].join(' ');
  return ['run', `${prompt}\n\n${instruction}`, '--format', 'json', ...(sessionId ? ['--session', sessionId] : [])];
}

export class OpenCodeAdapter implements EngineAdapter {
  readonly name = 'opencode';
  private readonly options: OpenCodeAdapterOptions;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.options = options;
  }

  resolveBinary(): string | null {
    if (this.options.binary) return isExecutableFile(this.options.binary) ? this.options.binary : null;
    return findOnPath('opencode');
  }

  isAvailable(): boolean {
    return this.resolveBinary() !== null;
  }

  async start(ctx: EngineStartContext): Promise<EngineHandle> {
    const binary = this.resolveBinary();
    if (!binary) {
      throw new EngineStartupError('opencode binary is not available on this host');
    }
    if (ctx.spec.ingressManifest && this.options.argv) {
      throw new EngineStartupError('custom OpenCode argv cannot be used with task-scoped ingress inputs');
    }
    const shouldExport = this.options.argv === undefined;
    let checkpointPath: string | null = null;
    let sessionId: string | null = null;
    if (ctx.spec.input?.resumeSessionFrom) {
      if (!shouldExport) throw new EngineStartupError('custom OpenCode argv cannot resume a durable session checkpoint');
      const resume = ctx.spec.input.resumeSessionFrom;
      if (resume.path !== `.session-traces/${resume.sessionId}.json`) throw new EngineStartupError('OpenCode session checkpoint path is invalid');
      checkpointPath = join(ctx.cwd, ...resume.path.split('/'));
      let bytes: Buffer;
      try {
        bytes = readFileSync(checkpointPath);
      } catch {
        throw new EngineStartupError('restored OpenCode session checkpoint is missing from the profile archive');
      }
      let parsed: { info?: { id?: unknown } };
      try { parsed = JSON.parse(bytes.toString('utf8')) as { info?: { id?: unknown } }; }
      catch { throw new EngineStartupError('restored OpenCode session checkpoint is invalid JSON'); }
      if (bytes.length !== resume.size || createHash('sha256').update(bytes).digest('hex') !== resume.sha256
        || parsed.info?.id !== resume.sessionId || typeof parsed.info.id !== 'string'
        || !/^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(parsed.info.id)) {
        throw new EngineStartupError('restored OpenCode session checkpoint failed archive integrity validation');
      }
      sessionId = resume.sessionId;
      const importLaunch = launchCommand(ctx, binary, ['import', checkpointPath]);
      const imported = await new Promise<number | null>((resolve, reject) => {
        const importer = spawn(importLaunch.command, importLaunch.args, {
          cwd: ctx.cwd,
          env: ctx.env,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        importer.stderr?.setEncoding('utf8');
        importer.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
        importer.once('error', reject);
        importer.once('close', (code) => resolve(code === 0 ? 0 : (code ?? 1)));
        importer.once('exit', () => undefined);
        importer.once('close', () => {
          if (stderr.trim()) ctx.onLog('stderr', `opencode checkpoint import: ${stderr.trim()}`);
        });
      }).catch((error: unknown) => {
        throw new EngineStartupError(`could not import OpenCode session checkpoint: ${String((error as Error).message)}`);
      });
      if (imported !== 0) throw new EngineStartupError(`OpenCode rejected the session checkpoint (exit=${String(imported)})`);
    }
    const argv = shouldExport ? defaultArgv(ctx.spec, sessionId ?? undefined) : this.options.argv!;
    const launch = launchCommand(ctx, binary, argv);
    const child = spawn(launch.command, launch.args, {
      cwd: ctx.cwd,
      env: ctx.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return handleForChild(child, {
      onLog: (stream, line) => {
        if (stream === 'stdout') {
          try {
            const event = JSON.parse(line) as { type?: unknown; sessionID?: unknown; part?: { type?: unknown; text?: unknown; time?: { end?: unknown } } };
            if (typeof event.sessionID === 'string' && /^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(event.sessionID)) sessionId = event.sessionID;
            if (event.type === 'text' && event.part?.type === 'text' && typeof event.part.text === 'string') {
              if (event.part.time?.end) ctx.onLog('stdout', event.part.text);
              else ctx.onLog('stderr', `[opencode text] ${event.part.text}`);
              return;
            }
            if (typeof event.type === 'string') {
              ctx.onLog('stderr', `[opencode ${event.type}] ${line}`);
              return;
            }
          } catch {
            // Non-JSON stdout from an older compatible CLI stays visible as text.
          }
        }
        ctx.onLog(stream, line);
      },
      onExit: (code, signal) => {
        if (!shouldExport) {
          ctx.onExit(code, signal);
          return;
        }
        // A completed or interrupted OpenCode run must leave a portable checkpoint
        // before Runner finalizes and sweeps its workspace. `export` defaults to the
        // full transcript; sanitized exports are unsuitable for resuming a session.
        if (!sessionId) {
          ctx.onLog('stderr', 'opencode session checkpoint export skipped: CLI did not emit a session id');
          ctx.onExit(code, signal);
          return;
        }
        try {
          checkpointPath = join(ctx.cwd, '.session-traces', `${sessionId}.json`);
          mkdirSync(join(ctx.cwd, '.session-traces'), { recursive: true, mode: 0o700 });
          const exportLaunch = launchCommand(ctx, binary, ['export', sessionId]);
          const exporter = spawn(exportLaunch.command, exportLaunch.args, {
            cwd: ctx.cwd,
            env: ctx.env,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          const chunks: Buffer[] = [];
          let size = 0;
          let failed = false;
          exporter.stdout?.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024 * 1024) {
              failed = true;
              exporter.kill('SIGKILL');
              return;
            }
            chunks.push(chunk);
          });
          exporter.once('error', () => ctx.onExit(code, signal));
          exporter.once('close', (exportCode) => {
            if (exportCode === 0 && !failed) {
              try {
                const text = Buffer.concat(chunks).toString('utf8');
                const parsed = JSON.parse(text) as { info?: { id?: string } };
                if (parsed.info?.id !== sessionId) throw new Error('OpenCode exported a different session id');
                writeFileSync(checkpointPath!, text, { mode: 0o600 });
              } catch (error) {
                ctx.onLog('stderr', `opencode session checkpoint export failed: ${String(error)}`);
              }
            } else {
              ctx.onLog('stderr', `opencode session checkpoint export failed (exit=${String(exportCode)}, sizeLimit=${failed})`);
            }
            ctx.onExit(code, signal);
          });
        } catch (error) {
          ctx.onLog('stderr', `opencode session checkpoint export failed: ${String(error)}`);
          ctx.onExit(code, signal);
        }
      },
    });
  }
}
