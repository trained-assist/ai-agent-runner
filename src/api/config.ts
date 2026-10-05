/**
 * Конфигурация процесса из окружения (epic #74). Вынесена из `main.ts` отдельным модулем,
 * потому что `main.ts` при импорте поднимает сервер, а правила разбора env должны
 * проверяться тестом, а не только на старте сервиса.
 */

import { statSync } from 'node:fs';
import {
  DEFAULT_CANCEL_DEADLINE_MS,
  DEFAULT_LAUNCH_DEADLINE_MS,
  EXTERNAL_WORKER_ENGINE,
  ExternalWorkerAdapter,
} from '../adapters/external-worker-adapter.js';
import { KeyRegistry } from './auth.js';

export const DEFAULT_API_PORT = 8787;
export const DEFAULT_API_HOST = '0.0.0.0';

export interface WorkerConfig {
  /** Имя движка, которым этот воркер отвечает: `dynamic-ip-azure-agent-run`, … */
  engine: string;
  baseUrl: string;
  token: string;
  launchDeadlineMs: number;
  cancelDeadlineMs: number;
}

export interface AgentApiProcessConfig {
  host: string;
  port: number;
  keyRegistryPath: string;
  publicUrl: string | null;
  /** Воркеры по движкам. Имя движка — адрес воркера, а не его внутренняя деталь. */
  workers: WorkerConfig[];
  /** Пулы значений окружения, которые можно передать воркеру (по envAllowlist рана). */
  env: Record<string, string>;
  /** Репозиторий по умолчанию, когда клиент не объявил `repository` (воркер клонирует его сам). */
  defaultRepository: string | null;
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Читает из переданного окружения, а не из `process.env`: иначе аргумент функции не работает. */
function intEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = envValue(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name}: expected a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Воркеры одним списком: `AGENT_API_WORKERS='[{"engine":"…","baseUrl":"…","token":"…"}]'`.
 * Формат списком, потому что движков больше одного, а одиночный `EXTERNAL_WORKER_*` больше
 * не выражает «какой воркер какому движку».
 */
function parseWorkers(env: Record<string, string | undefined>, raw: string | undefined, launchDeadlineMs: number, cancelDeadlineMs: number): WorkerConfig[] {
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
    return { engine, baseUrl, token, launchDeadlineMs, cancelDeadlineMs };
  });
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
  const cancelDeadlineMs = intEnv(env, 'EXTERNAL_WORKER_CANCEL_DEADLINE_MS', DEFAULT_CANCEL_DEADLINE_MS);
  const workers = parseWorkers(env, env['AGENT_API_WORKERS'], launchDeadlineMs, cancelDeadlineMs);
  if (workers.length === 0) {
    throw new Error('no external worker configured: set AGENT_API_WORKERS, or EXTERNAL_WORKER_URL for a single default worker');
  }

  const publicUrl = envValue(env, 'AGENT_API_PUBLIC_URL') ?? null;
  if (publicUrl !== null) {
    let parsed: URL;
    try {
      parsed = new URL(publicUrl);
    } catch {
      throw new Error('AGENT_API_PUBLIC_URL: expected an absolute http(s) URL without credentials, query, or fragment');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('AGENT_API_PUBLIC_URL: expected an absolute http(s) URL without credentials, query, or fragment');
    }
  }

  return {
    host: env['AGENT_API_HOST']?.trim() || DEFAULT_API_HOST,
    port,
    keyRegistryPath,
    publicUrl,
    workers,
    env: parseEnvPool(env['AGENT_API_ENV']),
    defaultRepository: env['RUNNER_DEFAULT_REPO']?.trim() || null,
  };
}

export function createExternalWorkers(config: AgentApiProcessConfig, log?: (entry: Record<string, unknown>) => void): ExternalWorkerAdapter[] {
  return config.workers.map((worker) => new ExternalWorkerAdapter({
    engineName: worker.engine,
    baseUrl: worker.baseUrl,
    env: config.env,
    ...(config.publicUrl ? { baseUrlForResult: config.publicUrl } : {}),
    ...(worker.token ? { token: worker.token } : {}),
    deadlineMs: worker.launchDeadlineMs,
    cancelDeadlineMs: worker.cancelDeadlineMs,
    log,
  }));
}
