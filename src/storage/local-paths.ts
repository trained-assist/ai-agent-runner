import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StorageError } from './errors.js';

export const MAX_WORKSPACE_PATH_LENGTH = 512;

/**
 * Относительный путь внутри workspace: без корня, без `..`, без управляющих символов.
 * Это граница, через которую ни один байт из воркспейса ранда не попадает наружу.
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_WORKSPACE_PATH_LENGTH) return false;
  if (value.includes('\0') || /[\x00-\x1f]/.test(value)) return false;
  if (isAbsolute(value) || value.startsWith('~')) return false;
  if (value.includes('\\')) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  return true;
}

export function assertSafeRelativePath(value: unknown, field: string): string {
  if (!isSafeRelativePath(value)) {
    throw new StorageError(
      'ARTIFACT_PATH_ESCAPE',
      `invalid ${field}: expected a relative path inside the run workspace without "..", "." or a leading "/"`,
    );
  }
  return value;
}

/**
 * Разрешает относительный путь в абсолютный строго внутри root.
 * Симлинк наружу (workspace/link -> /etc) тоже отвергается: проверяется realpath цели.
 */
export function resolveInsideRoot(root: string, relativePath: string, field = 'path'): string {
  const safe = assertSafeRelativePath(relativePath, field);
  const base = resolve(root);
  const target = resolve(join(base, ...safe.split('/')));
  const inside = relative(base, target);
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
    throw new StorageError('ARTIFACT_PATH_ESCAPE', `invalid ${field}: "${relativePath}" escapes the workspace root`);
  }
  return target;
}

/**
 * То же, но с проверкой существующей цели: symlink, уводящий за пределы root, запрещён.
 * Отсутствующий файл — не ошибка (вызывающий сам решает, missing это или нет).
 */
export function resolveExistingInsideRoot(root: string, relativePath: string, field = 'path'): string {
  const target = resolveInsideRoot(root, relativePath, field);
  const real = realpathSafe(target);
  if (real === null) return target;
  const base = resolve(root);
  let baseReal = base;
  try {
    baseReal = realpathSync(base);
  } catch {
    // корень ещё не существует — сравниваем лексикографически
  }
  const inside = relative(baseReal, real);
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
    throw new StorageError('ARTIFACT_PATH_ESCAPE', `invalid ${field}: "${relativePath}" resolves outside the workspace root through a link`);
  }
  return target;
}

function realpathSafe(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

export function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function assertNoTrailingSeparator(path: string): void {
  if (path.endsWith(sep)) {
    throw new StorageError('ARTIFACT_PATH_ESCAPE', `invalid path: "${path}" must not end with a separator`);
  }
}