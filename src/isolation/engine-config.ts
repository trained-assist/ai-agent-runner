/**
 * Конфиг движка внутри run-scoped clean room (issue #51, блокер приёмки #23).
 *
 * Граница даёт ранy собственные HOME/XDG_CONFIG_HOME — и вместе с этим убирает у движка
 * конфиг пользователя сервиса. Для OpenCode это значит «нет провайдера и модели»: движок
 * уходит на платный профиль по умолчанию или падает (проверено на песочной VM2: без
 * конфига `opencode run` выбирает `google/gemini-3-pro-image-preview` и падает). Ключ
 * приходит отдельно (env allowlist рана), а provider/model — это файл конфигурации,
 * и положить его должен хост.
 *
 * Поэтому хост объявляет read-only каталог шаблонов (`AGENT_API_ENGINE_CONFIG_DIR`),
 * один файл на движок (`<engine>.json`), и Runner кладёт копию в run-scoped
 * XDG_CONFIG_HOME до старта движка. Копия принадлежит слоту (0600) и уезжает вместе со
 * sweep; шаблон остаётся хостовым read-only активом.
 *
 * Договор о секретах: в шаблоне — только имена провайдеров/моделей и несекретные настройки.
 * Значения credential'ов в шаблон не кладутся: они приходят в окружение рана по env
 * allowlist, который собирает хост.
 */
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CleanRoomError, type CleanRoom } from './contract.js';
import { writeFileAtomic } from '../runner/util.js';

/** Максимальный размер шаблона: конфиг движка — это несколько строк, а не данные. */
export const ENGINE_CONFIG_TEMPLATE_MAX_BYTES = 64 * 1024;

const ENGINE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Куда движок читает свой конфиг рана. Таблица намеренно мала: раскладку знает только
 * движок, и добавление нового движка — это новая строка здесь плюс шаблон на хосте.
 * Движка в таблице нет — хост объявил о нём шаблон, а Runner не знает, куда его положить:
 * это поломка настройки хоста, и ран падает ДО спавна.
 *
 * Конфиг кладётся в корень workspace рана (проектная директория движка), а не в
 * run-scoped XDG_CONFIG_HOME, и это не выбор вкуса:
 *  - `HOME`/`XDG_CONFIG_HOME` рана закрыты (0700) и принадлежат слоту; каталог, созданный
 *    Runner'ом внутри них, теряет ACL Runner'а (`mkdir` с явным режимом маскирует
 *    унаследованный default ACL), и дальше Runner не может ни дописать конфиг, ни снести
 *    его при sweep — уборка не завершается, слот блокируется;
 *  - в workspace у Runner'а уже есть явный и default ACL (persist/sweep), и opencode
 *    читает `opencode.json` проекта — проверено живым прогоном под идентичностью рана.
 */
export const ENGINE_CONFIG_LAYOUTS: Record<string, { file: string }> = {
  opencode: { file: 'opencode.json' },
};

export interface EngineConfigTemplate {
  /** Каталог хостовых шаблонов (объявлен хостом, читается только Runner'ом). */
  dir: string;
  /** Имена движков, для которых в каталоге есть шаблон. */
  engines: string[];
}

export interface MaterializedEngineConfig {
  /** Путь копии в корне workspace рана (проектная директория движка). */
  path: string;
  engine: string;
  bytes: number;
  /** sha256 копии: в лог и evidence попадает только он, не содержимое. */
  sha256: string;
}

/** Имя файла шаблона для движка. */
export function templateFileName(engineName: string): string {
  if (!ENGINE_NAME.test(engineName)) {
    throw new CleanRoomError('ENGINE_CONFIG_INVALID', `engine name "${engineName}" cannot be mapped to a config template file`);
  }
  return `${engineName}.json`;
}

/**
 * Каталог шаблонов, объявленный хостом. Несуществующий каталог — не ошибка старта: на хосте
 * без engine-конфигов поведение прежнее (движок читает свой конфиг сам).
 */
export function loadEngineConfigTemplates(dir: string | undefined): EngineConfigTemplate | null {
  const root = dir?.trim() ?? '';
  if (root === '') return null;
  if (!existsSync(root)) return null;
  if (!statSync(root).isDirectory()) {
    throw new CleanRoomError('ENGINE_CONFIG_INVALID', `engine config template path is not a directory: ${root}`);
  }
  const engines = readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
  return { dir: root, engines };
}

/**
 * Копия шаблона в run-scoped конфиг рана. Шаблона для движка нет — возвращается null: хост
 * не объявлял конфиг этому движку, и это не поломка границы. Объявленный шаблон, который
 * не читается, не парсится или некуда положить, — поломка настройки хоста: ран падает
 * ДО спавна, а не стартует с молчаливо неверной (часто платной) моделью.
 */
export function materializeEngineConfig(
  templates: EngineConfigTemplate | null,
  room: CleanRoom,
  engineName: string,
): MaterializedEngineConfig | null {
  if (!templates) return null;
  const source = join(templates.dir, templateFileName(engineName));
  if (!existsSync(source)) return null;

  const layout = ENGINE_CONFIG_LAYOUTS[engineName];
  if (!layout) {
    throw new CleanRoomError(
      'ENGINE_CONFIG_LAYOUT_UNKNOWN',
      `engine config template declared for engine "${engineName}", but this Runner does not know where that engine reads its config`,
    );
  }

  const stats = statSync(source);
  if (!stats.isFile()) {
    throw new CleanRoomError('ENGINE_CONFIG_INVALID', `engine config template for "${engineName}" is not a regular file`);
  }
  if (stats.size > ENGINE_CONFIG_TEMPLATE_MAX_BYTES) {
    throw new CleanRoomError(
      'ENGINE_CONFIG_INVALID',
      `engine config template for "${engineName}" is ${stats.size} bytes, over the ${ENGINE_CONFIG_TEMPLATE_MAX_BYTES} byte limit`,
    );
  }
  const text = readFileSync(source, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CleanRoomError(
      'ENGINE_CONFIG_INVALID',
      `engine config template for "${engineName}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CleanRoomError('ENGINE_CONFIG_INVALID', `engine config template for "${engineName}" must be a JSON object`);
  }

  const path = join(room.paths.cwd, layout.file);
  writeFileAtomic(path, text);
  // Права и владение — независимые шаги: смена владельца требует привилегий, а 0600
  // обязано быть и без них, иначе конфиг рана прочитал бы соседний слот. Порядок тоже
  // важен: chown каталога раньше chown файла закрыл бы путь и ломал уборку.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* файл создан с правами по umask; это увидит проба границы */
  }
  try {
    chownSync(path, room.identity.uid, room.identity.gid);
  } catch {
    /* chown требует привилегий: файл остаётся 0600 и принадлежит Runner'у */
  }
  return { path, engine: engineName, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
}
