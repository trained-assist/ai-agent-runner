import { spawn } from 'node:child_process';
import { EngineStartupError, type ValidationResult } from '../../contracts/validate.js';
import type { EngineAdapter, EngineHandle, EngineStartContext } from './engine-adapter.js';
import { handleForChild } from './process-tree.js';

export const FAKE_SCENARIOS = [
  'success',
  'nonzero-exit',
  'startup-failure',
  'timeout',
  'crash',
  'cancel-with-children',
] as const;

export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

const SCRIPTS: Record<Exclude<FakeScenario, 'startup-failure'>, string> = {
  success: [
    "const fs = require('node:fs');",
    "fs.writeFileSync('ran.txt', 'ok');",
    "console.log('envkeys:' + Object.keys(process.env).sort().join(','));",
    "console.log('fake-engine: done');",
    'process.exit(0);',
  ].join(''),
  'nonzero-exit': ["console.log('fake-engine: exiting with code 3');", 'process.exit(3);'].join(''),
  timeout: ["console.log('fake-engine: hanging until killed');", 'setInterval(() => {}, 1000);'].join(''),
  crash: [
    "console.log('fake-engine: about to crash');",
    "setTimeout(() => { try { process.kill(process.pid, 'SIGKILL'); } catch {} }, 30);",
    'setInterval(() => {}, 1000);',
  ].join(''),
  'cancel-with-children': [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "console.log('grandchild:' + child.pid);",
    'setInterval(() => {}, 1000);',
  ].join(''),
};

export class FakeEngine implements EngineAdapter {
  readonly name = 'fake';
  startCalls = 0;
  readonly scenario: FakeScenario;

  constructor(scenario: FakeScenario = 'success') {
    this.scenario = scenario;
  }

  async start(ctx: EngineStartContext): Promise<EngineHandle> {
    this.startCalls += 1;
    if (this.scenario === 'startup-failure') {
      throw new EngineStartupError('fake engine failed to start (deterministic scenario)');
    }
    const script = SCRIPTS[this.scenario];
    const child = spawn(process.execPath, ['-e', script], {
      cwd: ctx.cwd,
      env: ctx.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return handleForChild(child, { onLog: ctx.onLog, onExit: ctx.onExit });
  }
}

export function fakeScenarioResult(scenario: string): ValidationResult<FakeScenario> {
  if ((FAKE_SCENARIOS as readonly string[]).includes(scenario)) {
    return { ok: true, value: scenario as FakeScenario };
  }
  return { ok: false, errors: [`unknown fake scenario: ${scenario}`] };
}
