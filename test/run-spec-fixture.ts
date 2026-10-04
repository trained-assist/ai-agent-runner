import { validateRunSpec, type RunSpec } from '../src/contracts/run-spec.js';

/** Минимальный валидный `RunSpec` для тестов контрактов: поля проходят общий валидатор. */
let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function makeRunSpec(over: Partial<RunSpec> = {}): RunSpec {
  const runId = nextId('run');
  const base = {
    contractVersion: 1,
    jobId: nextId('job'),
    runId,
    operationId: nextId('op'),
    userTaskId: nextId('task'),
    profileId: 'profile-a',
    conversationId: nextId('conv'),
    ownerGeneration: 1,
    engine: { name: 'dynamic-ip-azure-agent-run', adapterVersion: '1' },
    cwd: `/workspace/${runId}`,
    envAllowlist: [],
    limits: { timeoutMs: 5000 },
  };
  const merged = { ...base, ...over };
  const validated = validateRunSpec(merged);
  if (!validated.ok) throw new Error(`bad test spec: ${validated.errors.join('; ')}`);
  return validated.value;
}
