/**
 * Конфигурация процесса из окружения (epic #74). Вынесена из `main.ts` отдельным модулем,
 * потому что `main.ts` при импорте поднимает сервер, а правила разбора env должны
 * проверяться тестом, а не только на старте сервиса.
 */

import { statSync } from 'node:fs';
import {
  DEFAULT_ACCEPT_DEADLINE_MS,
  DEFAULT_CANCEL_DEADLINE_MS,
  DEFAULT_RECONCILE_DEADLINE_MS,
  DEFAULT_LAUNCH_DEADLINE_MS,
  EXTERNAL_WORKER_ENGINE,
  ExternalWorkerAdapter,
} from '../adapters/external-worker-adapter.js';
import { KeyRegistry } from './auth.js';

export const DEFAULT_API_PORT = 8787;
export const DEFAULT_API_HOST = '0.0.0.0';

export interface WorkerConfig {
  /** Имя движка, которым этот воркер отвечает: `azure-dynamic-ip-agent-run`, `eu-vm-agent-run`, … */
  engine: string;
  baseUrl: string;
  token: string;
  launchDeadlineMs: number;
  /**
   * Бюджет приёма рана этим движком (issue #100): сколько ждём квитанцию `POST /v1/launch`.
   * Не ответил за бюджет — цепочка берёт следующий движок, поэтому у GitHub Actions он короткий.
   */
  acceptDeadlineMs: number;
  cancelDeadlineMs: number;
}

export interface AgentApiProcessConfig {
  host: string;
  port: number;
  keyRegistryPath: string;
  /** Воркеры по движкам. Имя движка — адрес воркера, а не его внутренняя деталь. */
  workers: WorkerConfig[];
  /**
   * Приоритетная цепочка движков (issue #100): `AGENT_API_ENGINE_CHAIN`. Порядок проб задаёт
   * конфиг, а не сортировка имён. `null` — цепочка не объявлена, ран идёт ровно на тот движок,
   * который назвал клиент.
   */
  engineChain: string[] | null;
  /** Пулы значений окружения, которые можно передать воркеру (по envAllowlist рана). */
  env: Record<string, string>;
  /** Репозиторий по умолчанию, когда клиент не объявил `repository` (воркер клонирует его сам). */
  defaultRepository: string | null;
  /**
   * Публичный адрес этого API: воркер возвращает результат на `POST {resultUrl}`. Без него
   * воркер не получает адрес для возврата и не может быть запущен.
   */
  publicUrl: string | null;
  /**
   * Бюджет reconcile (issue #100): сколько ждём ответа на `GET /v1/runs/{id}/status`, когда
   * квитанции не было. Отдельно от таймаута запуска: мёртвый движок не должен вешать
   * проверку на 10 минут, иначе флот встаёт.
   */
  reconcileDeadlineMs: number;
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Читает из переданного окружения, а не из `process.env`: иначе аргумент функции не работает. */
function intEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  return positiveInt(envValue(env, name), name, fallback);
}

/** Положительное целое из строки (env) или из уже разобранного значения (JSON-конфиг). */
function positiveInt(raw: unknown, name: string, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new Error(`${name}: expected a positive integer`);
  }
  const text = typeof raw === 'number' ? String(raw) : raw.trim();
  if (text === '') return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name}: expected a positive integer, got "${text}"`);
  }
  return value;
}

/**
 * Воркеры одним списком: `AGENT_API_WORKERS='[{"engine":"…","baseUrl":"…","token":"…"}]'`.
 * Формат списком, потому что движков больше одного, а одиночный `EXTERNAL_WORKER_*` больше
 * не выражает «какой воркер какому движку».
 */
function parseWorkers(
  env: Record<string, string | undefined>,
  raw: string | undefined,
  launchDeadlineMs: number,
  acceptDeadlineMs: number,
  cancelDeadlineMs: number,
): WorkerConfig[] {
  if (raw === undefined) {
    // Одиночный конфиг остаётся рабочим: у нас пока один движок.
    const baseUrl = env['EXTERNAL_WORKER_URL']?.trim() || env['DYNAMIC_IP_AZURE_URL']?.trim();
    if (!baseUrl) return [];
    // Схему проверяем здесь же, а не только в списке: опечатка в адресе должна валить старт,
    // а не первый запрос клиента.
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new Error(`EXTERNAL_WORKER_URL: expected an http(s) URL, got "${baseUrl}"`);
    }
    return [
      {
        engine: env['EXTERNAL_WORKER_ENGINE']?.trim() || EXTERNAL_WORKER_ENGINE,
        baseUrl,
        token: env['EXTERNAL_WORKER_TOKEN']?.trim() || env['DYNAMIC_IP_AZURE_TOKEN']?.trim() || '',
        launchDeadlineMs,
        acceptDeadlineMs,
        cancelDeadlineMs,
      },
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AGENT_API_WORKERS: expected a JSON array of {engine, baseUrl, token}');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('AGENT_API_WORKERS: expected a non-empty JSON array of {engine, baseUrl, token}');
  }
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`AGENT_API_WORKERS[${index}]: expected an object`);
    const record = entry as Record<string, unknown>;
    const engine = typeof record['engine'] === 'string' ? record['engine'].trim() : '';
    const baseUrl = typeof record['baseUrl'] === 'string' ? record['baseUrl'].trim() : '';
    const token = typeof record['token'] === 'string' ? record['token'].trim() : '';
    if (!engine) throw new Error(`AGENT_API_WORKERS[${index}].engine: required`);
    if (!/^https?:\/\//.test(baseUrl)) throw new Error(`AGENT_API_WORKERS[${index}].baseUrl: expected an http(s) URL`);
    if (seen.has(engine)) throw new Error(`AGENT_API_WORKERS: engine "${engine}" is declared twice`);
    seen.add(engine);
    // Бюджет приёма свой у каждого движка (issue #100): не задан — общий из env.
    return {
      engine,
      baseUrl,
      token,
      launchDeadlineMs,
      acceptDeadlineMs: positiveInt(record['acceptDeadlineMs'], `AGENT_API_WORKERS[${index}].acceptDeadlineMs`, acceptDeadlineMs),
      cancelDeadlineMs,
    };
  });
}

/**
 * Приоритетная цепочка движков: `AGENT_API_ENGINE_CHAIN='gha,eu,rf'`. Порядок в конфиге — это
 * порядок проб; сортировать имена нельзя, потому что приоритет задаёт владелец, а не алфавит.
 * Не объявлена — `null`, и ран идёт ровно на названный клиентом движок (прежнее поведение).
 */
function parseEngineChain(raw: string | undefined, workers: readonly WorkerConfig[]): string[] | null {
  const value = raw?.trim();
  if (!value) return null;
  const chain = value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (chain.length === 0) throw new Error('AGENT_API_ENGINE_CHAIN: expected a comma-separated list of engine names');
  const seen = new Set<string>();
  const configured = new Set(workers.map((worker) => worker.engine));
  for (const engine of chain) {
    if (seen.has(engine)) throw new Error(`AGENT_API_ENGINE_CHAIN: engine "${engine}" is listed twice`);
    // Движок цепочки без воркера — опечатка в конфиге: молча пропустить его нельзя, иначе ран
    // будет падать на середине цепочки вместо отказа на старте.
    if (!configured.has(engine)) {
      throw new Error(`AGENT_API_ENGINE_CHAIN: engine "${engine}" has no worker in AGENT_API_WORKERS (declared: ${[...configured].join(', ')})`);
    }
    seen.add(engine);
  }
  return chain;
}

/** `AGENT_API_ENV='{"PATH":"/usr/bin","LANG":"C.UTF-8"}'` — значения, отдаваемые воркеру. */
function parseEnvPool(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AGENT_API_ENV: expected a JSON object of environment name → value');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('AGENT_API_ENV: expected a JSON object of environment name → value');
  }
  const pool: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error(`AGENT_API_ENV.${name}: expected a string value`);
    pool[name] = value;
  }
  return pool;
}

export function requireKeyRegistry(path: string): KeyRegistry {
  try {
    statSync(path);
  } catch {
    throw new Error(`key registry not found: ${path}`);
  }
  const registry = KeyRegistry.loadFile(path);
  if (registry.size() === 0) {
    throw new Error(`key registry ${path} holds no keys; refusing to start an API that cannot authenticate anyone`);
  }
  return registry;
}

export function loadAgentApiConfig(env: Record<string, string | undefined> = process.env): AgentApiProcessConfig {
  const portRaw = env['AGENT_API_PORT']?.trim() || String(DEFAULT_API_PORT);
  const keyRegistry = env['AGENT_API_KEY_REGISTRY']?.trim();
  if (!keyRegistry) {
    throw new Error('AGENT_API_KEY_REGISTRY is required: path to a mode-0600 key registry JSON file with a principals array');
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`AGENT_API_PORT: expected an integer in [1, 65535], got "${portRaw}"`);
  }

  const keyRegistryPath = env['AGENT_API_KEY_REGISTRY']?.trim();
  if (!keyRegistryPath) {
    throw new Error('AGENT_API_KEY_REGISTRY is required: path to a mode-0600 key registry JSON file with a principals array');
  }

  const launchDeadlineMs = intEnv(env, 'EXTERNAL_WORKER_LAUNCH_DEADLINE_MS', DEFAULT_LAUNCH_DEADLINE_MS);
  // Бюджет приёма рана: по умолчанию 30 с, у каждого движка переопределяется полем acceptDeadlineMs.
  const acceptDeadlineMs = intEnv(env, 'EXTERNAL_WORKER_ACCEPT_DEADLINE_MS', DEFAULT_ACCEPT_DEADLINE_MS);
  const cancelDeadlineMs = intEnv(env, 'EXTERNAL_WORKER_CANCEL_DEADLINE_MS', DEFAULT_CANCEL_DEADLINE_MS);
  const reconcileDeadlineMs = intEnv(env, 'EXTERNAL_WORKER_RECONCILE_DEADLINE_MS', DEFAULT_RECONCILE_DEADLINE_MS);
  const workers = parseWorkers(env, env['AGENT_API_WORKERS'], launchDeadlineMs, acceptDeadlineMs, cancelDeadlineMs);
  if (workers.length === 0) {
    throw new Error('no external worker configured: set AGENT_API_WORKERS, or EXTERNAL_WORKER_URL for a single default worker');
  }
  // Цепочка разбирается после воркеров: её имена обязаны быть среди объявленных движков.
  const engineChain = parseEngineChain(env['AGENT_API_ENGINE_CHAIN'], workers);

  return {
    host: env['AGENT_API_HOST']?.trim() || DEFAULT_API_HOST,
    port,
    keyRegistryPath,
    workers,
    engineChain,
    env: parseEnvPool(env['AGENT_API_ENV']),
    defaultRepository: env['RUNNER_DEFAULT_REPO']?.trim() || null,
    publicUrl: env['AGENT_API_PUBLIC_URL']?.trim() || null,
    reconcileDeadlineMs,
  };
}

