import { EXTERNAL_WORKER_ADAPTER_VERSION, ExternalWorkerAdapter } from '../adapters/external-worker-adapter.js';
import type { AgentApiProcessConfig } from './config.js';

/**
 * Сборка воркеров процесса из конфига (issue #100).
 *
 * Вынесено из `main.ts` не ради красоты: сквозная сборка «конфиг → адаптер → LaunchRequest»
 * обязана проверяться тестом. Именно здесь один раз потерялся пул `AGENT_API_ENV`: адаптер
 * создавался без `env`, поэтому `LaunchRequest.env` уезжал пустым, ключ LLM не покидал API,
 * а агент в GitHub Actions падал с `unauthorized` — при зелёных тестах и живом шлюзе.
 */
export function createExternalWorkers(config: AgentApiProcessConfig, log: (entry: Record<string, unknown>) => void): ExternalWorkerAdapter[] {
  return config.workers.map(
    (worker) =>
      new ExternalWorkerAdapter({
        engineName: worker.engine,
        baseUrl: worker.baseUrl,
        ...(worker.token ? { token: worker.token } : {}),
        // Пул значений окружения рана. Без него `LaunchRequest.env` пуст, и воркер не
        // получает ни ключа LLM, ни иных значений, которые клиент разрешил в envAllowlist.
        env: config.env,
        deadlineMs: worker.launchDeadlineMs,
        // Бюджет приёма рана — свой у каждого движка (issue #100): не ответил за него,
        // цепочка берёт следующий исполнитель.
        acceptDeadlineMs: worker.acceptDeadlineMs,
        cancelDeadlineMs: worker.cancelDeadlineMs,
        log,
      }),
  );
}

export { EXTERNAL_WORKER_ADAPTER_VERSION };