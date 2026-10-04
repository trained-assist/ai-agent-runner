/**
 * Разбор legacy `config/profile-clean-list.yaml` в правила политики экспорта.
 *
 * Зачем отдельный модуль: политика экспорта — версионируемая часть контракта (см. уточнение
 * 6 в AGENT-RUNNER-DATA-PERSISTENCE-IMPLEMENTATION.md), а clean list — единственное место,
 * где описан образ профиля. Без разборщика интегратор либо форкает логику, либо молча
 * использует deny-list по умолчанию — а он НЕ исключает сессии (`sessions` → ARCHIVE в
 * clean list), то есть импорт притащил бы в репозиторий профиля тела сессий, которые legacy
 * намеренно держит вне текстового образа.
 *
 * Формат — строгое подмножество YAML, описанное в шапке файла: `version: <int>` и список
 * `rules` с полями `pattern` (обязательное), `action` (обязательное), `reason`
 * (обязательное), `when` (опциональное). Разборчик намеренно fail-loud: неизвестное поле,
 * неизвестное действие или структура, которую он не понимает, — ошибка, а не догадка.
 * Так же ведёт себя legacy-парсер (`scripts/profile-migrate/classifier.cjs`).
 *
 * Семантика сопоставления (правило без `/` — имя на любой глубине, с `/` — от корня,
 * первое совпадение выигрывает, правило совпадает и с каталогом-предком) реализована в
 * `policy.ts`; здесь только чтение файла в правила.
 */

import { WorkspaceError } from './contract.js';

export interface CleanListRule {
  pattern: string;
  action: string;
  reason: string;
  when?: string;
}

export interface CleanList {
  version: number;
  rules: CleanListRule[];
}

const KNOWN_ACTIONS = new Set(['DELETE', 'ARCHIVE', 'MOVE', 'DEDUP', 'SYSTEM', 'KEEP', 'EXCLUDE', 'UNKNOWN']);

/**
 * Построчный разбор документированного подмножества. YAML-библиотека не нужна и не
 * подключается: формат строгий, а зависимость ради десяти строк конфига — лишняя поверхность.
 */
export function parseCleanList(text: string): CleanList {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'clean list is empty');
  }
  const lines = text.split('\n');
  let version: number | null = null;
  let inRules = false;
  let rules: CleanListRule[] = [];
  let current: CleanListRule | null = null;

  const flush = (): void => {
    if (!current) return;
    if (current.pattern.length === 0) throw new WorkspaceError('WORKSPACE_INVALID', 'clean list rule is missing "pattern"');
    if (!KNOWN_ACTIONS.has(current.action)) {
      throw new WorkspaceError('WORKSPACE_INVALID', `clean list rule "${current.pattern}" has unknown action "${current.action}"`);
    }
    if (current.reason.length === 0) throw new WorkspaceError('WORKSPACE_INVALID', `clean list rule "${current.pattern}" is missing "reason"`);
    rules.push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    const line = raw.replace(/\t/g, '  ');
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    if (indent === 0) {
      flush();
      if (content.startsWith('version:')) {
        const value = content.slice('version:'.length).trim();
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new WorkspaceError('WORKSPACE_INVALID', `clean list: version must be a positive integer, got "${value}"`);
        }
        version = parsed;
        continue;
      }
      if (content.startsWith('rules:')) {
        inRules = true;
        continue;
      }
      throw new WorkspaceError('WORKSPACE_INVALID', `clean list: unexpected top-level entry "${content}"`);
    }

    if (!inRules) {
      throw new WorkspaceError('WORKSPACE_INVALID', `clean list: entry "${content}" appears before "rules:"`);
    }

    // Первое поле правила может стоять на той же строке, что и дефис (`- pattern: x`),
    // а может быть на следующей (`-` отдельно, поля с отступом). Оба формы допустимы.
    if (content.startsWith('- ')) {
      flush();
      const rest = content.slice(2).trim();
      const colon = rest.indexOf(':');
      const looksLikeField = colon > 0 && !rest.startsWith('"') && !rest.startsWith("'");
      current = { pattern: '', action: '', reason: '' };
      if (looksLikeField) applyField(current, rest.slice(0, colon).trim(), rest.slice(colon + 1).trim());
      else current.pattern = unquote(rest);
      continue;
    }
    if (!current) {
      throw new WorkspaceError('WORKSPACE_INVALID', `clean list: field "${content}" appears before any rule`);
    }
    const colon = content.indexOf(':');
    if (colon < 0) throw new WorkspaceError('WORKSPACE_INVALID', `clean list: cannot parse rule line "${content}"`);
    applyField(current, content.slice(0, colon).trim(), content.slice(colon + 1).trim());
  }
  flush();

  if (version === null) throw new WorkspaceError('WORKSPACE_INVALID', 'clean list: missing "version"');
  if (rules.length === 0) throw new WorkspaceError('WORKSPACE_INVALID', 'clean list: no rules');
  return { version, rules };
}

function applyField(rule: CleanListRule, key: string, value: string): void {
  if (key === 'pattern') rule.pattern = unquote(value);
  else if (key === 'action') rule.action = unquote(value).toUpperCase();
  else if (key === 'reason') rule.reason = unquote(value);
  else if (key === 'when') rule.when = unquote(value);
  else throw new WorkspaceError('WORKSPACE_INVALID', `clean list rule "${rule.pattern}" has unknown field "${key}"`);
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Правила в форме, принимаемой `ExportPolicy.rules` (см. `compileCleanListRules`). */
export function cleanListRulesOf(cleanList: CleanList): { pattern: string; action: string; reason: string; when?: string }[] {
  return cleanList.rules.map((rule) => ({ pattern: rule.pattern, action: rule.action, reason: rule.reason, ...(rule.when ? { when: rule.when } : {}) }));
}
