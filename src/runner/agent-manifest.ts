import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeRelativePath, isRegularFile, resolveExistingInsideRoot } from '../storage/local-paths.js';
import type { OutputSpec } from '../contracts/run-spec.js';
import { truncateLine } from './util.js';

/**
 * Явный финальный манифест агента (issue #52, шаг 2 «определить выход»).
 *
 * Выход рана определяется двумя разрешёнными источниками: объявленными `spec.outputs`
 * и манифестом, который сам агент оставил в своём workspace. Третий источник —
 * «просто просканировать HOME/секреты» — запрещён: агент не должен попадать в чужие
 * данные, а хранилище не должно наполняться тем, что ран не объявлял.
 *
 * Файл манифеста — единственная точка, где агент сам говорит, что считать выходом:
 *   {"outputs": [{"path": "report.md", "name": "report.md", "mime": "text/markdown"}],
 *    "answerFile": "answer.md"}
 * Путь манифеста фиксирован, чтобы движок не мог подсунуть «случайный» файл: агент
 * получает путь в prompt'е хоста (см. docs/API-SERVICE.md).
 */
export const AGENT_MANIFEST_DIR = '.agent';
export const AGENT_MANIFEST_FILE = 'final-manifest.json';
export const AGENT_MANIFEST_PATH = `${AGENT_MANIFEST_DIR}/${AGENT_MANIFEST_FILE}`;

/** Потолок манифеста: файл больше — это не объявление выхода, а попытка набить экспорт. */
export const AGENT_MANIFEST_MAX_BYTES = 64 * 1024;
export const AGENT_MANIFEST_MAX_OUTPUTS = 100;

export type AgentManifestProblem = 'absent' | 'not_regular_file' | 'too_large' | 'invalid_json' | 'invalid_shape' | 'unsafe_path';

export interface AgentFinalManifest {
  outputs: OutputSpec[];
  answerFile: string | null;
}

export type AgentManifestRead =
  | { status: 'absent'; manifest: null; reason: string }
  | { status: 'invalid'; manifest: null; reason: string; problem: AgentManifestProblem }
  | { status: 'ok'; manifest: AgentFinalManifest; reason: string };

/**
 * Чтение финального манифеста агента. Любой дефект — это `invalid` с причиной, а не
 * исключение: отказ манифеста не должен ронять ран, который объявил выходы сам.
 */
export function readAgentFinalManifest(cwd: string): AgentManifestRead {
  const target = join(cwd, ...AGENT_MANIFEST_PATH.split('/'));
  let size = 0;
  try {
    // symlink манифеста наружу запрещён: иначе агент объявил бы файл чужого рана
    if (!isRegularFile(target)) {
      return { status: 'absent', manifest: null, reason: 'the agent declared no final manifest' };
    }
    size = statSync(target).size;
  } catch {
    return { status: 'absent', manifest: null, reason: 'the agent declared no final manifest' };
  }
  if (size > AGENT_MANIFEST_MAX_BYTES) {
    return {
      status: 'invalid',
      manifest: null,
      problem: 'too_large',
      reason: `final manifest is ${size} bytes, above the ${AGENT_MANIFEST_MAX_BYTES} byte limit`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    return {
      status: 'invalid',
      manifest: null,
      problem: 'invalid_json',
      reason: `final manifest is not valid JSON: ${truncateLine(error instanceof Error ? error.message : String(error), 200)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'invalid', manifest: null, problem: 'invalid_shape', reason: 'final manifest must be a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !['outputs', 'answerFile'].includes(key));
  if (unknownKeys.length > 0) {
    return {
      status: 'invalid',
      manifest: null,
      problem: 'invalid_shape',
      reason: `final manifest has unsupported fields: ${unknownKeys.slice(0, 5).join(',')}`,
    };
  }
  const outputs: OutputSpec[] = [];
  const rawOutputs = record['outputs'] ?? [];
  if (!Array.isArray(rawOutputs)) {
    return { status: 'invalid', manifest: null, problem: 'invalid_shape', reason: 'final manifest.outputs must be an array' };
  }
  if (rawOutputs.length > AGENT_MANIFEST_MAX_OUTPUTS) {
    return {
      status: 'invalid',
      manifest: null,
      problem: 'invalid_shape',
      reason: `final manifest declares ${rawOutputs.length} outputs, above the limit of ${AGENT_MANIFEST_MAX_OUTPUTS}`,
    };
  }
  for (const [index, entry] of rawOutputs.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { status: 'invalid', manifest: null, problem: 'invalid_shape', reason: `final manifest.outputs[${index}] must be an object` };
    }
    const item = entry as Record<string, unknown>;
    const path = item['path'];
    if (typeof path !== 'string' || !isSafeRelativePath(path)) {
      return {
        status: 'invalid',
        manifest: null,
        problem: 'unsafe_path',
        reason: `final manifest.outputs[${index}].path must be a relative path inside the workspace without "..", "." or a leading "/"`,
      };
    }
    if (outputs.some((existing) => existing.path === path)) {
      return { status: 'invalid', manifest: null, problem: 'invalid_shape', reason: `final manifest declares "${path}" twice` };
    }
    const output: OutputSpec = { path };
    if (typeof item['name'] === 'string' && item['name'].length > 0 && item['name'].length <= 200 && !item['name'].includes('/')) {
      output.name = item['name'];
    }
    if (typeof item['mime'] === 'string' && item['mime'].length > 0 && item['mime'].length <= 100) output.mime = item['mime'];
    outputs.push(output);
  }
  let answerFile: string | null = null;
  const rawAnswer = record['answerFile'];
  if (typeof rawAnswer === 'string') {
    if (!isSafeRelativePath(rawAnswer)) {
      return {
        status: 'invalid',
        manifest: null,
        problem: 'unsafe_path',
        reason: 'final manifest.answerFile must be a relative path inside the workspace without "..", "." or a leading "/"',
      };
    }
    answerFile = rawAnswer;
  } else if (rawAnswer !== undefined && rawAnswer !== null) {
    return { status: 'invalid', manifest: null, problem: 'invalid_shape', reason: 'final manifest.answerFile must be a string or null' };
  }
  return { status: 'ok', manifest: { outputs, answerFile }, reason: `final manifest declares ${outputs.length} output(s)` };
}

/**
 * Текст ответа агента: из `answerFile` манифеста (явный выбор агента) либо, если его
 * нет, из накопленного хвоста stdout движка. Содержимое наружу не логируется — в журнал
 * рана попадает только источник и размер.
 */
export function readAgentAnswer(cwd: string, manifest: AgentFinalManifest | null): { text: string; source: 'agent_file' | 'engine_stdout' | null } {
  if (manifest?.answerFile) {
    try {
      const absolute = resolveExistingInsideRoot(cwd, manifest.answerFile, 'final manifest.answerFile');
      if (isRegularFile(absolute)) {
        return { text: readFileSync(absolute, 'utf8'), source: 'agent_file' };
      }
    } catch {
      // файл ответа вне workspace или недоступен — падаем на stdout движка
    }
  }
  return { text: '', source: null };
}

/**
 * Слияние плана выхода: объявленные `spec.outputs` плюс манифест агента. При конфликте
 * по пути объявленное клиентом объявление выигрывает — клиент владеет именем и mime.
 */
export function mergeOutputPlan(declared: OutputSpec[], fromAgent: OutputSpec[]): { plan: OutputSpec[]; merged: string[] } {
  const plan: OutputSpec[] = [...declared];
  const seen = new Set(declared.map((output) => output.path));
  const merged: string[] = [];
  for (const output of fromAgent) {
    if (seen.has(output.path)) {
      merged.push(output.path);
      continue;
    }
    seen.add(output.path);
    plan.push(output);
  }
  return { plan, merged };
}