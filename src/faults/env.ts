import { FAULT_POINTS, FaultRegistry } from './registry.js';

/**
 * Управляемые точки сбоя из переменной окружения (`AGENT_API_FAULTS=cleanup:1,export`),
 * по образцу `AGENT_API_FAKE_SCENARIO`: нужно упасть в конкретный момент lifecycle
 * (например, в уборку), а не «примерно тогда, когда процесс уже умер».
 *
 * Формат записи — `точка[:count]`, где `count` задаёт, сколько раз сработает отказ; без
 * него отказ одноразовый. Ошибка разбора валит старт намеренно: молча проигнорированная
 * точка означала бы пробу, которая отчиталась «прошла», ни разу не упав.
 */
export function parseFaultPoints(raw: string | undefined): string[] {
  const entries = (raw ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const [point, count] = entry.split(':');
    if (!FAULT_POINTS.includes(point as (typeof FAULT_POINTS)[number])) {
      throw new Error(`AGENT_API_FAULTS: unknown fault point "${point}" (expected one of ${FAULT_POINTS.join(', ')})`);
    }
    if (count !== undefined && !/^[1-9][0-9]*$/.test(count)) {
      throw new Error(`AGENT_API_FAULTS: "${entry}" — count must be a positive integer`);
    }
    if (entry.split(':').length > 2) {
      throw new Error(`AGENT_API_FAULTS: "${entry}" — expected "point" or "point:count"`);
    }
  }
  return entries;
}

/** Реестр сбоев по разобранным записям; пустой список = отказов нет (обычный сервис). */
export function faultRegistry(entries: readonly string[]): FaultRegistry | undefined {
  if (entries.length === 0) return undefined;
  const registry = new FaultRegistry();
  for (const entry of entries) {
    const [point, count] = entry.split(':');
    registry.inject(
      point as (typeof FAULT_POINTS)[number],
      count === undefined ? { kind: 'throw', once: true } : { kind: 'throw', count: Number(count) },
    );
  }
  return registry;
}
