import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
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

function defaultArgv(spec: RunSpec): string[] {
  const prompt = spec.input?.inlinePrompt;
  if (!prompt) {
    throw new EngineStartupError('opencode run requires a host-resolved input.inlinePrompt');
  }
  if (!spec.ingressManifest) return ['run', prompt];
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
  return ['run', `${prompt}\n\n${instruction}`];
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
    const argv = this.options.argv ?? defaultArgv(ctx.spec);
    const launch = launchCommand(ctx, binary, argv);
    const child = spawn(launch.command, launch.args, {
      cwd: ctx.cwd,
      env: ctx.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return handleForChild(child, { onLog: ctx.onLog, onExit: ctx.onExit });
  }
}
