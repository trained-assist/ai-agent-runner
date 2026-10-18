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
  /** Модель в формате provider/model; по умолчанию ladder/free, чтобы не уходить на встроенный провайдер OpenCode. */
  model?: string;
}

function defaultArgv(spec: RunSpec, sessionId?: string, model?: string): string[] {
  const prompt = spec.input?.inlinePrompt;
  if (!prompt) {
    throw new EngineStartupError('opencode run requires a host-resolved input.inlinePrompt');
  }
  const modelArgs = model ? ['-m', model] : [];
  if (!spec.ingressManifest) return ['run', prompt, '--format', 'json', ...modelArgs, ...(sessionId ? ['--session', sessionId] : [])];
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
  const modelArgs2 = model ? ['-m', model] : [];
  return ['run', `${prompt}\n\n${instruction}`, '--format', 'json', ...modelArgs2, ...(sessionId ? ['--session', sessionId] : [])];
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
    const argv = shouldExport ? defaultArgv(ctx.spec, sessionId ?? undefined, this.options.model ?? 'ladder/free') : this.options.argv!;
    const launch = launchCommand(ctx, binary, argv);
    const child = spawn(launch.command, launch.args, {
      cwd: ctx.cwd,
      env: ctx.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // OpenCode emits completed text parts before the matching step_finish event.
    // Keep one bounded buffer per assistant message and publish only when that
    // message ends in a tool-call step; the final stop message remains covered
    // by the ordinary terminal result path, so it is not delivered twice.
    const pendingAssistantText = new Map<string, { sessionId: string; parts: string[]; chars: number }>();
    return handleForChild(child, {
      onLog: (stream, line) => {
        if (stream === 'stdout') {
          try {
            const event = JSON.parse(line) as {
              type?: unknown;
              sessionID?: unknown;
              request?: { id?: unknown; sessionID?: unknown; questions?: unknown; tool?: { callID?: unknown } };
              part?: { type?: unknown; id?: unknown; messageID?: unknown; text?: unknown; reason?: unknown; time?: { end?: unknown } };
            };
            if (typeof event.sessionID === 'string' && /^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(event.sessionID)) sessionId = event.sessionID;
            if (event.type === 'text' && event.part?.type === 'text' && typeof event.part.text === 'string') {
              if (event.part.time?.end) {
                if (typeof event.sessionID === 'string' && typeof event.part.messageID === 'string') {
                  const current = pendingAssistantText.get(event.part.messageID) ?? { sessionId: event.sessionID, parts: [], chars: 0 };
                  const available = Math.max(0, 64_000 - current.chars);
                  if (available > 0) {
                    current.parts.push(event.part.text.slice(0, available));
                    current.chars += Math.min(event.part.text.length, available);
                  }
                  pendingAssistantText.set(event.part.messageID, current);
                }
              }
              else ctx.onLog('stderr', `[opencode text] ${event.part.text}`);
              return;
            }
            if (event.type === 'step_finish' && event.part?.type === 'step-finish' && typeof event.part.messageID === 'string') {
              const pending = pendingAssistantText.get(event.part.messageID);
              pendingAssistantText.delete(event.part.messageID);
              if (pending && event.part.reason === 'tool-calls') {
                const text = pending.parts.join('').trim();
                if (text) ctx.onAssistantMessage?.({ sessionId: pending.sessionId, messageId: event.part.messageID, text });
              } else if (pending && typeof event.part.reason === 'string' && event.part.reason !== 'unknown') {
                const text = pending.parts.join('');
                if (text.trim()) ctx.onLog('stdout', text);
              }
            }
            if (event.type === 'question_asked') {
              const request = event.request;
              const rawQuestions = Array.isArray(request?.questions) ? request.questions : [];
              const questions = rawQuestions.flatMap((raw) => {
                if (!raw || typeof raw !== 'object') return [];
                const item = raw as { header?: unknown; question?: unknown; multiple?: unknown; options?: unknown };
                if (typeof item.question !== 'string' || !item.question.trim()) return [];
                const options = Array.isArray(item.options) ? item.options.flatMap((option) => {
                  if (!option || typeof option !== 'object') return [];
                  const value = option as { label?: unknown; description?: unknown };
                  if (typeof value.label !== 'string') return [];
                  return [{ label: value.label.slice(0, 200), description: typeof value.description === 'string' ? value.description.slice(0, 500) : '' }];
                }).slice(0, 20) : [];
                return [{ header: typeof item.header === 'string' ? item.header.slice(0, 200) : '', question: item.question.slice(0, 5000), multiple: item.multiple === true, options }];
              }).slice(0, 20);
              if (typeof event.sessionID === 'string' && /^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(event.sessionID)
                && typeof request?.id === 'string' && request.id.length > 0 && questions.length > 0) {
                ctx.onAssistantQuestion?.({ sessionId: event.sessionID, requestId: request.id.slice(0, 200), questions,
                  toolCallId: typeof request.tool?.callID === 'string' ? request.tool.callID.slice(0, 200) : null });
              }
              // The user-facing question is emitted through the structured event,
              // not duplicated into the unstructured log stream.
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
          let exportFinished = false;
          let exportExitCode: number | null = null;
          const finishExport = (exportCode: number | null): void => {
            if (exportFinished) return;
            exportFinished = true;
            clearTimeout(exportTimer);
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
          };
          exporter.once('exit', (exitCode) => {
            exportExitCode = exitCode === null ? null : (exitCode ?? 1);
          });
          exporter.once('error', () => {
            try { exporter.kill('SIGKILL'); } catch { /* already gone */ }
            finishExport(exportExitCode ?? 1);
          });
          exporter.once('close', (closeCode) => {
            finishExport(closeCode === null ? exportExitCode : (closeCode ?? 1));
          });
          const exportTimer = setTimeout(() => {
            ctx.onLog('stderr', 'opencode session checkpoint export timed out; terminating exporter');
            failed = true;
            try { exporter.kill('SIGKILL'); } catch { /* already gone */ }
            finishExport(exportExitCode ?? 1);
          }, 15000);
        } catch (error) {
          ctx.onLog('stderr', `opencode session checkpoint export failed: ${String(error)}`);
          ctx.onExit(code, signal);
        }
      },
    });
  }
}
