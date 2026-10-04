/**
 * Политика экспорта профиля: что попадает в постоянный git-образ, что — только в
 * object storage, а что не выходит из профиля вообще.
 *
 * Совместимость с legacy `config/profile-clean-list.yaml` — сознательная: там та же
 * семантика «правило без `/` совпадает с именем на любой глубине, правило с `/` anchored
 * в корне, первое совпадение выигрывает, правило совпадает и с каталогом-предком».
 * Благодаря этому интегратор может скомпилировать существующий clean list в `ExportPolicy`
 * (см. `compileCleanListRules`), не форкая логику и не импортируя legacy internals.

 *
 * Значение по умолчанию — deny-list, а не whitelist: неизвестный пользовательский файл
 * должен попасть в образ, а не молча потеряться. Безопасность держит явный список
 * исключений (credentials, git, runtime-состояние движка, входы рана).
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isSafeRelativePath } from '../storage/local-paths.js';
import { sha256Hex } from '../storage/blob-store.js';
import { WorkspaceError } from './contract.js';

export const PROFILE_MARKER_DIR = '.trained-assist';
export const MAX_PATTERN_LENGTH = 200;

export type ExportRuleAction = 'exclude' | 'publish' | 'heavy';

/**
 * Предусловие правила из legacy clean list. Сейчас поддержан только `git-repo`:
 * правило действует, пока файл находится внутри рабочей копии (каталог, на любой
 * глубине которого есть `.git`). Именно так в legacy помечено правило `**` → ARCHIVE:
 * оно не должно применяться к профилю целиком, только к содержимому git-рабочей копии.
 */
export type ExportRuleWhen = 'git-repo';

export interface ExportRule {
  /** Без `/` — имя файла на любой глубине; с `/` — от корня профиля. `*` и `**` допустимы. */
  pattern: string;
  action: ExportRuleAction;
  reason: string;
  when?: ExportRuleWhen;
}

export interface ExportPolicy {
  policyId: string;
  version: number;
  /** Файл не больше этого размера идёт в git; больше — в object storage с ref в манифесте. */
  textMaxBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  /** Порядок значим: первое совпадение выигрывает. */
  rules: ExportRule[];
}

/**
 * Обязательные исключения. Список из двух частей: (1) формы credential'ов, найденные
 * сканом legacy-профилей 28.09 — `auth.json` движка перезаписывается каждый ран и содержит
 * OAuth-токены, `.mcp.json` содержал plaintext-секрет, storage-state — cookie jar;
 * (2) общие формы, которые нельзя пропустить ни при каком профиле.
 */
export const MANDATORY_EXCLUDES: readonly ExportRule[] = [
  // ── git и состояние самого образа ──
  { pattern: '.git', action: 'exclude', reason: 'git-метаданные репозитория профиля' },
  { pattern: '.gitignore', action: 'exclude', reason: 'правила игнора задаются политикой экспорта, а не образом профиля' },
  // ── входы и кандидаты рана: принадлежат ранy, а не профилю ──
  { pattern: '.inputs', action: 'exclude', reason: 'материализованные входы рана (#52)' },
  { pattern: `${PROFILE_MARKER_DIR}/candidates`, action: 'exclude', reason: 'черновики публикации' },
  // ── credential'ы: никогда в git и никогда в экспортируемых артефактах ──
  { pattern: 'auth.json', action: 'exclude', reason: 'OAuth-credential движка, перезаписывается каждый ран' },
  { pattern: '.mcp.json', action: 'exclude', reason: 'MCP-конфиг с plaintext-секретами' },
  { pattern: '.webpasswd', action: 'exclude', reason: 'пароль web-UI' },
  { pattern: 'storage-state.json', action: 'exclude', reason: 'cookie jar браузера' },
  { pattern: 'playwright-storage-state.json', action: 'exclude', reason: 'cookie jar playwright' },
  { pattern: 'creds.json', action: 'exclude', reason: 'секреты сайтов профиля' },
  { pattern: '*-creds', action: 'exclude', reason: 'секреты сайтов профиля' },
  { pattern: '*.creds', action: 'exclude', reason: 'секреты сайтов профиля' },
  { pattern: 'credentials.json', action: 'exclude', reason: 'хранилище credential-ов' },
  { pattern: '.git-credentials', action: 'exclude', reason: 'git-credential helper' },
  { pattern: '.netrc', action: 'exclude', reason: 'credential-ы внешних сервисов' },
  { pattern: '.npmrc', action: 'exclude', reason: 'может содержать _authToken' },
  { pattern: '.pypirc', action: 'exclude', reason: 'credential-ы PyPI' },
  { pattern: '.env', action: 'exclude', reason: 'environment с секретами' },
  { pattern: '.env.*', action: 'exclude', reason: 'environment с секретами' },
  { pattern: '*.pem', action: 'exclude', reason: 'ключ или сертификат' },
  { pattern: '*.key', action: 'exclude', reason: 'ключ' },
  { pattern: '*.p12', action: 'exclude', reason: 'ключ' },
  { pattern: '*.pfx', action: 'exclude', reason: 'ключ' },
  { pattern: '*.jks', action: 'exclude', reason: 'ключ' },
  { pattern: '*.keystore', action: 'exclude', reason: 'ключ' },
  { pattern: '*.kdbx', action: 'exclude', reason: 'password-менеджер' },
  { pattern: 'id_rsa', action: 'exclude', reason: 'ключ ssh' },
  { pattern: 'id_ed25519', action: 'exclude', reason: 'ключ ssh' },
  { pattern: '.ssh', action: 'exclude', reason: 'ключи и known_hosts' },
  { pattern: '.gnupg', action: 'exclude', reason: 'PGP-ключи' },
  { pattern: '.aws', action: 'exclude', reason: 'credential-ы AWS' },
  { pattern: '.config/gcloud', action: 'exclude', reason: 'credential-ы gcloud' },
  { pattern: '.docker/config.json', action: 'exclude', reason: 'credential-ы docker' },
  { pattern: 'secrets.json', action: 'exclude', reason: 'credential-ы и секреты' },
  { pattern: 'secrets.yaml', action: 'exclude', reason: 'credential-ы и секреты' },
  { pattern: 'secrets.yml', action: 'exclude', reason: 'credential-ы и секреты' },
  { pattern: '*.secret', action: 'exclude', reason: 'credential-ы и секреты' },
  // ── runtime-состояние движка и журналы ──
  { pattern: 'opencode.db', action: 'exclude', reason: 'runtime state движка (ARCH §5.1)' },
  { pattern: 'opencode.db-*', action: 'exclude', reason: 'runtime state движка' },
  { pattern: '.opencode', action: 'exclude', reason: 'конфиг и кэш движка' },
  { pattern: '.claude', action: 'exclude', reason: 'состояние чужого агента' },
  { pattern: '.local/share/opencode', action: 'exclude', reason: 'runtime state движка' },
  { pattern: '*.log', action: 'exclude', reason: 'журнал процесса, не рабочее состояние' },
];

/**
 * Каталоги, которые не имеет смысла публиковать: воспроизводимы и раздувают образ.
 * Это не credential-ы, поэтому решение «не публиковать» здесь явное и перечислимое.
 */
/**
 * Архивы и бинарные контейнеры — это артефакты, а не текст: они уходят в object storage по
 * ref и материализуются при чтении. Без этого правила маленькие архивы (сотни килобайт)
 * попадали бы прямо в git, раздувая образ прикладным содержимым, которое никто не читает
 * глазами, а распаковывает по ссылке.
 */
export const MIGRATION_BINARY_EXCLUDES: readonly ExportRule[] = [
  { pattern: '*.tar', action: 'heavy', reason: 'архив — ref в object storage, не текст в git' },
  { pattern: '*.tar.gz', action: 'heavy', reason: 'архив — ref в object storage, не текст в git' },
  { pattern: '*.tgz', action: 'heavy', reason: 'архив — ref в object storage, не текст в git' },
  { pattern: '*.zip', action: 'heavy', reason: 'архив — ref в object storage, не текст в git' },
  { pattern: '*.7z', action: 'heavy', reason: 'архив — ref в object storage, не текст в git' },
  { pattern: '*.dmg', action: 'heavy', reason: 'образ диска — ref в object storage' },
  { pattern: '*.iso', action: 'heavy', reason: 'образ диска — ref в object storage' },
  { pattern: '*.pdf', action: 'heavy', reason: 'документ — ref в object storage' },
  { pattern: '*.sqlite', action: 'heavy', reason: 'база данных — ref в object storage' },
  { pattern: '*.db', action: 'heavy', reason: 'база данных — ref в object storage' },
];

/**
 * Каталоги, которые движок создаёт как рабочий вывод: сборки, песочницы, чекауты,
 * одноразовые каталоги работы. В образе профиля им не место — они воспроизводимы, а в
 * случае сомнения лежат в `other` при отчёте инвентаря.
 */
export const MIGRATION_GENERATED_EXCLUDES: readonly ExportRule[] = [
  { pattern: 'dist', action: 'exclude', reason: 'сборка (build output) — воспроизводима' },
  { pattern: 'sandbox', action: 'exclude', reason: 'песочница агента — одноразовый чекаут' },
  { pattern: 'checkout', action: 'exclude', reason: 'чекаут агента — одноразовая копия' },
  { pattern: '*_clone', action: 'exclude', reason: 'клон агента (суффикс имени каталога)' },
  { pattern: '.work', action: 'exclude', reason: 'рабочий каталог агента (scratch)' },
  { pattern: 'release', action: 'exclude', reason: 'каталог релиза агента' },
];

export const DEFAULT_REGENERABLE_EXCLUDES: readonly ExportRule[] = [
  { pattern: 'node_modules', action: 'exclude', reason: 'восстанавливается установкой' },
  { pattern: '.venv', action: 'exclude', reason: 'восстанавливается установкой' },
  { pattern: '__pycache__', action: 'exclude', reason: 'восстанавливается запуском' },
  { pattern: '.cache', action: 'exclude', reason: 'восстанавливается запуском' },
  { pattern: '.DS_Store', action: 'exclude', reason: 'служебный файл файловой системы' },
];

/**
 * Сжатие образа при миграции: состояние, которое порождает движок/агент, а не пользователь.
 *
 * Почему отдельным набором, а не в `MANDATORY_EXCLUDES`: это расширение границы профиля, и
 * его применение — осознанное решение миграции. По архитектуре (ARCH §5.1) HOME движка и
 * его база создаются на каждый ран и не являются рабочим состоянием профиля; индексы
 * поиска и трассы сессий — сгенерированы и воспроизводимы.
 *
 * Inventory реальных профилей показал, что именно эти пути дают основную массу «текста»:
 * в одном профиле `.agent-home/agent-data/**` — 266 МБ (один файл эмбеддингов 247 МБ),
 * `.session-traces/**` — 68 МБ. Их исключение сжимает образ на порядок.
 *
 * Порядок важен: набор добавляется ПЕРЕД правилами clean list — первое совпадение
 * выигрывает, и KEEP-правило (`*.json` → publish) иначе вернуло бы движковое состояние в
 * образ. Эти же правила стоит внести в legacy `config/profile-clean-list.yaml` (он —
 * единственное определение границы профиля); до этого набор применяется явно на миграции.
 */
export const MIGRATION_COMPRESSION_EXCLUDES: readonly ExportRule[] = [
  { pattern: '.agent-home', action: 'exclude', reason: 'HOME движка: auth, конфиг, кэши, agent-data — на каждый ран создаётся заново (ARCH §5.1), не образ профиля' },
  { pattern: '.agent-tokens', action: 'exclude', reason: 'per-profile credentials — никогда не в образе' },
  { pattern: '.session-traces', action: 'exclude', reason: 'трассы сессий — класс sessions, место в object storage (M2)' },
  { pattern: '.mcp-runs', action: 'exclude', reason: 'scratch MCP-запусков рана' },
  { pattern: '.run-inputs', action: 'exclude', reason: 'материализованные входы рана (#52)' },
  { pattern: '.playwright-mcp', action: 'exclude', reason: 'scratch браузерного MCP' },
  { pattern: 'repo-maps', action: 'exclude', reason: 'сгенерированная карта репозитория' },
  { pattern: 'chunks.json', action: 'exclude', reason: 'сгенерированные чанки поискового индекса' },
  { pattern: 'embed-*.json', action: 'exclude', reason: 'сгенерированные эмбеддинги поискового индекса' },
  { pattern: '.system-prompt.txt', action: 'exclude', reason: 'сгенерированный системный промпт движка' },
  { pattern: '.skills-resolved.json', action: 'exclude', reason: 'сгенерированный список скилов рана' },
  { pattern: '.opencode-mcp.json', action: 'exclude', reason: 'сгенерированный конфиг MCP движка (может нести секреты)' },
  { pattern: '.pin_state.json', action: 'exclude', reason: 'служебное состояние агента' },
];

/**
 * Сборка политики миграции из трёх слоёв в правильном порядке (первое совпадение выигрывает):
 *
 *   1. `MANDATORY_EXCLUDES` — секреты, git, входы рана. Не отключаются никогда: даже если
 *      clean list про какую-то форму credential'а молчит, она обязана остаться вне образа;
 *   2. `MIGRATION_COMPRESSION_EXCLUDES` — движковое состояние и сгенерированные индексы;
 *   3. правила clean list — граница профиля.
 *
 * Без этого порядка KEEP-правило clean list (`*.json` → publish) или его молчание про
 * `*.key` вернули бы в образ то, что обязано быть исключено.
 */
export function buildMigrationPolicy(input: {
  policyId: string;
  cleanListRules: readonly ExportRule[];
  compress?: boolean;
  textMaxBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
}): ExportPolicy {
  return {
    policyId: input.policyId,
    version: 1,
    textMaxBytes: input.textMaxBytes ?? DEFAULT_EXPORT_POLICY.textMaxBytes,
    maxFiles: input.maxFiles ?? DEFAULT_EXPORT_POLICY.maxFiles,
    maxTotalBytes: input.maxTotalBytes ?? DEFAULT_EXPORT_POLICY.maxTotalBytes,
    rules: [
      ...MANDATORY_EXCLUDES,
      ...DEFAULT_REGENERABLE_EXCLUDES,
      ...(input.compress ? [...MIGRATION_COMPRESSION_EXCLUDES, ...MIGRATION_BINARY_EXCLUDES, ...MIGRATION_GENERATED_EXCLUDES] : []),
      ...input.cleanListRules,
    ],
  };
}

export const DEFAULT_EXPORT_POLICY: ExportPolicy = {
  policyId: 'profile-workspace-v1',
  version: 1,
  textMaxBytes: 1024 * 1024,
  maxFiles: 5000,
  maxTotalBytes: 128 * 1024 * 1024,
  rules: [...MANDATORY_EXCLUDES, ...DEFAULT_REGENERABLE_EXCLUDES],
};

export interface CompiledPolicy {
  policy: ExportPolicy;
  /** pattern → RegExp; порядок сохранён, первое совпадение выигрывает. */
  matchers: { action: ExportRuleAction; reason: string; matcher: RegExp; when?: ExportRuleWhen }[];
}

/** Контекст сопоставления: где находится файл, который классифицируют. */
export interface MatchContext {
  /** Файл внутри рабочей копии git (каталог-предок содержит `.git`). */
  insideGitRepo?: boolean;
}

/**
 * Компиляция правил. `pattern` без `/` совпадает с ИМЕНЕМ на любой глубине, с `/` —
 * от корня профиля. Правило совпадает и с самим путём, и с любым его предком-каталогом,
 * поэтому `node_modules` закрывает всё поддерево, а не только каталог верхнего уровня.
 */
export function compilePolicy(policy: ExportPolicy): CompiledPolicy {
  const matchers = policy.rules.map((rule) => {
    if (typeof rule.pattern !== 'string' || rule.pattern.length === 0 || rule.pattern.length > MAX_PATTERN_LENGTH) {
      throw new WorkspaceError('WORKSPACE_INVALID', `export policy: pattern must be 1..${MAX_PATTERN_LENGTH} chars, got ${JSON.stringify(rule.pattern)}`);
    }
    if (rule.pattern.startsWith('/')) {
      throw new WorkspaceError('WORKSPACE_INVALID', `export policy: pattern "${rule.pattern}" must be relative to the profile root (no leading "/")`);
    }
    if (rule.when !== undefined && rule.when !== 'git-repo') {
      throw new WorkspaceError('WORKSPACE_INVALID', `export policy: unsupported "when" precondition "${String(rule.when)}" for pattern "${rule.pattern}"`);
    }
    return { action: rule.action, reason: rule.reason, matcher: patternToRegExp(rule.pattern), when: rule.when };
  });
  return { policy, matchers };
}

export function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.includes('/');
  const body = anchored ? pattern : `**/${pattern}`;
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] as string;
    if (char === '*') {
      if (body[i + 1] === '*') {
        // `**/` — любой набор каталогов (включая ни одного); `**` в середине — любой путь
        if (body[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return new RegExp(`${prefix}${out}$`);
}

/** Первое совпадение или `defaultAction`, если ни одно правило не совпало. */
export function matchRule(compiled: CompiledPolicy, path: string, context: MatchContext = {}): { action: ExportRuleAction; reason: string } {
  const segments = path.split('/');
  // Проверяются и сам путь, и все его предки: правило для каталога закрывает поддерево.
  const candidates: string[] = [];
  for (let i = 1; i < segments.length; i += 1) candidates.push(segments.slice(0, i).join('/'));
  candidates.push(path);
  for (const entry of compiled.matchers) {
    // Предусловие `git-repo` срабатывает только внутри рабочей копии. Без него правило
    // `**` → ARCHIVE исключило бы весь профиль целиком, а не содержимое рабочей копии.
    if (entry.when === 'git-repo' && !context.insideGitRepo) continue;
    for (const candidate of candidates) {
      if (entry.matcher.test(candidate)) return { action: entry.action, reason: entry.reason };
    }
  }
  return { action: 'publish', reason: 'default: рабочее состояние профиля' };
}

/**
 * Решение по одному файлу: политика решает исключение/тяжёлый/текст, а размер —
 * порог между git и object storage. Размер проверяется последним, чтобы файл, который
 * политика запретила, не «спасался» тем, что он маленький.
 */
export function classifyPath(compiled: CompiledPolicy, path: string, size: number): { action: ExportRuleAction; reason: string } {
  const matched = matchRule(compiled, path);
  if (matched.action === 'exclude') return matched;
  if (matched.action === 'heavy') return matched;
  if (size > compiled.policy.textMaxBytes) {
    return { action: 'heavy', reason: `file is ${size} bytes, over the ${compiled.policy.textMaxBytes} byte git limit` };
  }
  return matched;
}

export interface ScannedFile {
  path: string;
  size: number;
  sha256: string;
  action: Extract<ExportRuleAction, 'publish' | 'heavy'>;
  reason: string;
}

export interface ExcludedFile {
  path: string;
  reason: string;
}

export interface ScanResult {
  files: ScannedFile[];
  excluded: ExcludedFile[];
  totalBytes: number;
}

export interface ScanOptions {
  /** Сужает обход до подмножества путей (публикация объявляет разрешённые пути). */
  paths?: readonly string[];
}

/**
 * Детерминированный обход каталога профиля (workspace рана или копии при импорте).
 *
 * Отказоустойчивость по построению:
 * - симлинк, каталог с `.git`, не-обычный файл (fifo/socket/device) не публикуются
 *   никогда — это и граница безопасности, и «произвольные symlinks не экспортируются»
 *   из контракта;
 * - `.git` найденный в любом подкаталоге закрывает это поддерево целиком (чужой репозиторий
 *   внутри профиля не разбирается на части);
 * - путь вне корня, `..`, абсолютный путь и не-UTF8-ish имя — отказ публикации, а не тихий пропуск;
 * - пустой результат — это `no_changes`, а не ошибка.
 */
export function scanWorkspace(compiled: CompiledPolicy, rootDir: string, options: ScanOptions = {}): ScanResult {
  const root = resolve(rootDir);
  // Стартовый контекст — НЕ рабочая копия. Учитываются только `.git` ВНУТРИ профиля:
  // legacy понимает `when: git-repo` как «файл внутри рабочей копии на любой глубине»
  // (engineering-workspaces/**, клоны в projects/), а не как «профиль лежит в чек-ауте
  // оператора». Иначе импорт копии, размещённой внутри чужого репозитория, молча исключил
  // бы весь профиль.
  const rootContext: MatchContext = { insideGitRepo: false };
  // Есть ли в политике правило для рабочих копий. Если нет — вложенный клон исключается
  // целиком; если есть — содержимое классифицируют правила (`when: git-repo`).
  const hasGitRepoRule = compiled.matchers.some((matcher) => matcher.when === 'git-repo');
  const allow = options.paths && options.paths.length > 0 ? new Set(options.paths.map((p) => p.replace(/\/+$/, ''))) : null;
  const files: ScannedFile[] = [];
  const excluded: ExcludedFile[] = [];
  let totalBytes = 0;

  const walk = (absoluteDir: string, relativeDir: string, inheritedContext: MatchContext, isRoot: boolean): void => {
    const entries = readdirSync(absoluteDir, { withFileTypes: true });
    // Порядок сортируется: два одинаковых обхода дают одинаковый манифест и одинаковый hash.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // Каталог с `.git` — начало рабочей копии: всё под ним подпадает под `when: git-repo`.
    // Проверка бесплатна: `readdir` уже сделан, ищем среди его же записей.
    const dirIsWorkingCopy = entries.some((entry) => entry.name === '.git');
    const context: MatchContext = dirIsWorkingCopy ? { insideGitRepo: true } : inheritedContext;
    if (dirIsWorkingCopy && !hasGitRepoRule && !isRoot) {
      // Политика не описывает рабочие копии (`when: git-repo`): публиковать содержимое
      // чужого клона целиком нельзя — это не образ профиля. Отказ, а не тихая публикация.
      excluded.push({ path: relativeDir, reason: 'nested git repository' });
      return;
    }
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolutePath = join(absoluteDir, entry.name);
      if (!isSafeRelativePath(relativePath)) {
        throw new WorkspaceError('WORKSPACE_PATH_DENIED', `path "${relativePath}" is not a safe relative path inside the workspace`);
      }
      // Каталог пропускается, только если сам не разрешён и внутри него нет разрешённых
      // путей: иначе сужённая публикация молча теряла бы половину явно перечисленного.
      if (allow && !allow.has(relativePath) && !coversAllowedPath(allow, relativePath)) continue;
      const matched = matchRule(compiled, relativePath, context);
      if (matched.action === 'exclude') {
        excluded.push({ path: relativePath, reason: matched.reason });
        if (entry.isDirectory()) continue;
        continue;
      }
      if (entry.isSymbolicLink()) {
        excluded.push({ path: relativePath, reason: 'symlink is not published (link target may leave the profile)' });
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath, context, false);
        continue;
      }
      if (!entry.isFile()) {
        excluded.push({ path: relativePath, reason: 'not a regular file' });
        continue;
      }
      const stats = lstatSync(absolutePath);
      const bytes = readFileSync(absolutePath);
      const sha256 = sha256Hex(bytes);
      const decision = classifyPath(compiled, relativePath, stats.size);
      if (decision.action === 'exclude') {
        excluded.push({ path: relativePath, reason: decision.reason });
        continue;
      }
      if (files.length >= compiled.policy.maxFiles) {
        throw new WorkspaceError('WORKSPACE_TOO_LARGE', `profile has more than ${compiled.policy.maxFiles} publishable files`);
      }
      totalBytes += bytes.length;
      if (totalBytes > compiled.policy.maxTotalBytes) {
        throw new WorkspaceError('WORKSPACE_TOO_LARGE', `profile exceeds the ${compiled.policy.maxTotalBytes} byte export limit`);
      }
      files.push({
        path: relativePath,
        size: bytes.length,
        sha256,
        action: decision.action,
        reason: decision.reason,
      });
    }
  };

  walk(root, '', rootContext, true);
  files.sort((a, b) => a.path.localeCompare(b.path));
  excluded.sort((a, b) => a.path.localeCompare(b.path));
  return { files, excluded, totalBytes };
}

/** Разрешён ли путь сам, его предок, или он является предком разрешённого пути. */
/** Находится ли каталог внутри рабочей копии git: есть ли `.git` у него или у предка. */
export function isInsideGitRepo(rootDir: string): boolean {
  let current = resolve(rootDir);
  for (let level = 0; level < 16; level += 1) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

function coversAllowedPath(allow: Set<string>, relativePath: string): boolean {
  const segments = relativePath.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    if (allow.has(segments.slice(0, i).join('/'))) return true;
  }
  const prefix = `${relativePath}/`;
  for (const entry of allow) {
    if (entry.startsWith(prefix)) return true;
  }
  return false;
}

function hasGitDir(directory: string): boolean {
  try {
    return readdirSync(directory).includes('.git');
  } catch {
    return false;
  }
}

/** `workspacePath` обязан быть существующим каталогом вне симлинков наружу. */
export function assertWorkspaceDir(workspacePath: string): string {
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'workspace path is required');
  }
  const root = resolve(workspacePath);
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    throw new WorkspaceError('WORKSPACE_INVALID', `workspace path does not exist: ${root}`);
  }
  if (real.split(sep).length < 2) {
    throw new WorkspaceError('WORKSPACE_INVALID', `refusing to use a filesystem root as a workspace: ${real}`);
  }
  return real;
}

// ── Имя репозитория профиля ────────────────────────────────────────────────────

const REPO_PREFIX = 'profile-';

/** `profileId` → безопасное имя: нижний регистр, `[a-z0-9-]`, без краевых дефисов. */
export function sanitizeProfileId(profileId: string): string {
  return String(profileId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sha6(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 6);
}

/**
 * Детерминированное имя репозитория: `profile-<sanitized>`, а если sanitized ≠ исходному
 * id — хвост из первых 6 hex sha256. Смысл хвоста: без него `Alice` и `alice` схлопнулись бы
 * на один репозиторий, и чужой профиль получил бы доступ к данным другого. Функция
 * переносит схему legacy-скрипта (scripts/profile-repo.mjs), но реализована здесь
 * независимо: импортировать legacy internals запрещено правилом потока.
 */
export function repositoryNameFor(profileId: string): string {
  const id = String(profileId ?? '');
  if (id.length === 0) throw new WorkspaceError('WORKSPACE_INVALID', 'profileId is required to derive a repository name');
  const base = sanitizeProfileId(id);
  if (base.length === 0) return `${REPO_PREFIX}${sha6(id)}`;
  const name = base === id ? `${REPO_PREFIX}${base}` : `${REPO_PREFIX}${base}-${sha6(id)}`;
  if (name.length > 100) {
    // Имя длиннее лимита github не пройдёт: обрезаем по base и оставляем хвост-хэш,
    // чтобы разные профили не получили одно имя.
    return `${REPO_PREFIX}${base.slice(0, 100 - REPO_PREFIX.length - 7)}-${sha6(id)}`;
  }
  return name;
}

/**
 * Компиляция legacy clean list в правила политики. Принимает уже разобранные правила
 * (`{pattern, action, reason}`) — разбор YAML остаётся на стороне интегратора: модуль не
 * тянет yaml-библиотеку и не знает про формат legacy-конфига.
 *
 * Соответствие действий: KEEP → publish, EXCLUDE → exclude, SYSTEM/ARCHIVE/MOVE/DEDUP/DELETE
 * → exclude с явной причиной («не в постоянном образе профиля»). UNKNOWN-файлы по-прежнему
 * публикуются: политика по умолчанию deny-list, чтобы пользовательские данные не терялись.
 */
export function compileCleanListRules(rules: readonly { pattern: string; action: string; reason?: string; when?: string }[]): ExportRule[] {
  const actionOf: Record<string, ExportRuleAction> = { KEEP: 'publish', EXCLUDE: 'exclude' };
  return rules.map((rule) => {
    const action = actionOf[rule.action.toUpperCase()];
    const reason = rule.reason && rule.reason.length > 0 ? rule.reason : `clean list action ${rule.action}`;
    // Предусловие обязано пережить компиляцию: без него правило `**` → ARCHIVE
    // (`when: git-repo`) исключало бы весь профиль целиком, а не содержимое рабочей копии.
    const when = rule.when === 'git-repo' ? ('git-repo' as const) : undefined;
    if (action === undefined) {
      return { pattern: rule.pattern, action: 'exclude' as const, reason: `${reason} (not part of the persistent profile image)`, ...(when ? { when } : {}) };
    }
    return { pattern: rule.pattern, action, reason, ...(when ? { when } : {}) };
  });
}
