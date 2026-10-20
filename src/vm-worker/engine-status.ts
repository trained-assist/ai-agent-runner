import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Что воркер исполняет на самом деле.
 *
 * `build.opencode` в метаданных подписанного релиза описывает бинарь, который
 * лежит в бандле. Это не то же самое, что бинарь, который воркер запускает:
 * хост может переопределить путь через `OPENCODE_BIN`, и тогда сервис молча
 * уходит на другую сборку, пока `/version` продолжает рапортовать о бандле.
 * Именно так прод однажды остался на сборке месячной давности.
 *
 * Поэтому воркер отдельно рапортует о фактически исполняемом бинаре: путь,
 * sha256 и версию. По этим данным деплой и дрейф-проверка видят расхождение.
 */
export interface VmWorkerEngineStatus {
  name: 'opencode';
  /** Абсолютный путь бинаря, который воркер запускает для прогонов. */
  binaryPath: string | null;
  /** SHA-256 исполняемого файла. */
  binarySha256: string | null;
  /** Первая строка вывода `opencode --version`. */
  binaryVersion: string | null;
}

/** Статус движка для хоста, где бинарь найти не удалось. */
export const UNAVAILABLE_ENGINE_STATUS: VmWorkerEngineStatus = {
  name: 'opencode',
  binaryPath: null,
  binarySha256: null,
  binaryVersion: null,
};

/**
 * Описать бинарь, который воркер будет исполнять.
 *
 * Путь резолвится адаптером (`OPENCODE_BIN` или поиск по `PATH`), поэтому
 * сюда приходит уже окончательный путь. Хеш считается потоком, а не чтением
 * файла целиком: бинарь весит порядка двухсот мегабайт.
 */
export async function describeEngineStatus(binaryPath: string | null): Promise<VmWorkerEngineStatus> {
  if (!binaryPath) return UNAVAILABLE_ENGINE_STATUS;
  return {
    name: 'opencode',
    binaryPath,
    binarySha256: await sha256OfFile(binaryPath),
    binaryVersion: readBinaryVersion(binaryPath),
  };
}

/** SHA-256 файла. `null`, если файл недоступен для чтения. */
export async function sha256OfFile(path: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/** Первая строка `opencode --version`. `null`, если бинарь не отвечает. */
export function readBinaryVersion(path: string): string | null {
  try {
    const raw = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
    const first = raw.split('\n')[0]?.trim() ?? '';
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}
