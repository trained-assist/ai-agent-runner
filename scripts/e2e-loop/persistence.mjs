// Персистентные пути для reboot-прогона (issue #6).
//
// reboot-state.json и durable store шага 4b ПО ОПРЕДЕЛЕНИЮ должны пережить
// systemctl reboot: /tmp на Ubuntu 24.04 чистится при загрузке (tmpfiles),
// поэтому состояние, нужное resume-юниту, живёт в персистентном каталоге,
// а не во временном (урок docs/API-SERVICE.md: data dir сервиса — /var/lib/agent-runner).
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** Базовый каталог reboot-прогона под root (создаётся 0700). */
export const PERSISTENT_ROOT_BASE = '/var/lib/e2e-loop';

/** Неперсистентные корни: всё, что живёт под ними, перезагрузку не переживает. */
function tempRoots() {
  const roots = new Set();
  for (const candidate of [tmpdir(), '/tmp', '/private/tmp']) {
    try {
      roots.add(resolve(candidate));
    } catch {
      // ignore unresolvable candidates
    }
    try {
      roots.add(realpathSync(candidate));
    } catch {
      // tmpdir()/симлинки могут не существовать — сравниваем как есть
    }
  }
  return roots;
}

/**
 * true, если путь лежит во временном каталоге (пережить reboot не может).
 * @param {string} candidate
 * @returns {boolean}
 */
export function isTempPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  let path;
  try {
    path = resolve(candidate);
  } catch {
    return false;
  }
  let real = null;
  try {
    real = realpathSync(path);
  } catch {
    real = null;
  }
  for (const root of tempRoots()) {
    if (path === root || path.startsWith(root + sep)) return true;
    if (real !== null && (real === root || real.startsWith(root + sep))) return true;
  }
  return false;
}

/**
 * Дефолтный каталог данных при --with-reboot (без --root):
 * под root — /var/lib/e2e-loop/<id>, иначе — <repo>/.e2e-state/<id> (в gitignore).
 * Чистая функция: каталог не создаётся, guard'ы срабатывают до mkdir.
 *
 * @param {{uid?: number|null, repoRoot: string, id?: string}} options
 * @returns {string}
 */
export function persistentRootDefault(options) {
  const uid = options.uid !== undefined ? options.uid : typeof process.getuid === 'function' ? process.getuid() : null;
  const id =
    options.id ??
    `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
  if (uid === 0) return join(PERSISTENT_ROOT_BASE, id);
  if (!options.repoRoot) throw new Error('persistentRootDefault: repoRoot обязателен для non-root');
  return join(options.repoRoot, '.e2e-state', id);
}

/**
 * Guard'ы --with-reboot до старта прогона (fail fast вместо тихого ENOENT в resume).
 *
 * @param {{
 *   rootDir: string,
 *   reportPath: string,
 *   reportExplicit: boolean,
 *   uid: number|null,
 *   systemctlOk: boolean,
 * }} options
 * @returns {string[]} понятные причины отказа; пусто = можно запускать
 */
export function rebootGuards(options) {
  const problems = [];
  if (options.uid !== 0 || !options.systemctlOk) {
    problems.push(
      '--with-reboot требует root и systemd: запускайте под root явно; в дефолтном прогоне reboot не выполняется.',
    );
  }
  if (isTempPath(options.rootDir)) {
    problems.push(
      `--with-reboot: каталог данных "${options.rootDir}" лежит во временном каталоге (/tmp) — ` +
        'reboot-state.json и durable store не переживут перезагрузку (issue #6). ' +
        `Укажите --root в персистентном пути (напр. ${PERSISTENT_ROOT_BASE}/<run>) либо уберите --root — ` +
        `при --with-reboot дефолт сам ложится в ${PERSISTENT_ROOT_BASE}.`,
    );
  }
  if (isTempPath(options.reportPath)) {
    if (options.reportExplicit) {
      problems.push(
        `--with-reboot: путь отчёта "${options.reportPath}" лежит во временном каталоге (/tmp) — ` +
          'отчёт не переживёт перезагрузку, resume не сможет его дочитать (issue #6). ' +
          'Укажите --report в персистентном пути.',
      );
    }
  }
  return problems;
}

/** true, если inner лежит внутри dir. */
export function isInside(dir, inner) {
  const base = resolve(dir);
  const target = resolve(inner);
  return target === base || target.startsWith(base + sep);
}
