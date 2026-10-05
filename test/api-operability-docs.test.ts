import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Раннбук оператора (`docs/API-SERVICE.md`) — единственный документ, по которому сервис
 * разворачивают на VM. Он отстал от кода один раз уже: описывал синхронный `launch`,
 * гонку отмены с запуском и код `WORKER_LAUNCH_TIMEOUT`, которого в репозитории нет.
 * Тест не проверяет стиль — он ловит расхождение трёх видов:
 *
 * 1. переменная окружения, которую читает `src/api`, не описана в §2 документа;
 * 2. код отказа, названный в документе, отсутствует в коде;
 * 3. путь журнала, который деплой кладёт по умолчанию, недоступен юниту на запись —
 *    тогда настройка не сработает молча, а дедупликация не переживёт рестарт.
 *
 * Проверки статические (по тексту файлов), как и «API не пишет на диск» в e2e-loop:
 * поведенческий тест здесь зависел бы от того, что на хосте никто больше не пишет.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = resolve(repoRoot, 'docs/API-SERVICE.md');
const doc = readFileSync(docPath, 'utf8');

/** Текст §2 «Конфигурация»: от заголовка до следующего заголовка второго уровня. */
function section2(): string {
  const start = doc.indexOf('## 2. Конфигурация');
  const end = doc.indexOf('\n## 3.', start);
  expect(start).toBeGreaterThan(-1);
  return doc.slice(start, end === -1 ? doc.length : end);
}

/** Все .ts-файлы каталога рекурсивно. */
function walkTypescript(target: string): string[] {
  const out: string[] = [];
  const visit = (path: string): void => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(resolve(path, entry));
      return;
    }
    if (path.endsWith('.ts')) out.push(path);
  };
  visit(target);
  return out;
}

const apiSources = walkTypescript(resolve(repoRoot, 'src/api')).map((file) => readFileSync(file, 'utf8'));
const adapterSource = readFileSync(resolve(repoRoot, 'src/adapters/external-worker-adapter.ts'), 'utf8');
const codeText = [...apiSources, adapterSource].join('\n');

/**
 * Хостовые переменные конфигурации: префиксы, которые сервис читает у себя, а не у воркера.
 * Всё остальное в `src/api` — это чтение пула `AGENT_API_ENV`, который уходит воркеру.
 */
const CONFIG_ENV_PREFIXES = ['AGENT_API_', 'EXTERNAL_WORKER_', 'RUNNER_DEFAULT_REPO', 'DYNAMIC_IP_AZURE_'];

/** Переменные, которые читает код: `env['X']`, `process.env['X']`, `process.env.X`, `intEnv(env, 'X'`. */
function readEnvNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/(?:env|process\.env)\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) {
    names.add(match[1]!);
  }
  for (const match of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(match[1]!);
  }
  for (const match of text.matchAll(/intEnv\(\s*env\s*,\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
    names.add(match[1]!);
  }
  return [...names];
}

/**
 * Семейства кодов отказа, которые документ вправе называть. Список закрытый намеренно:
 * новый код в документе с другим префиксом уронит тест и заставит решить — код это или
 * слово. Так расхождение «документ обещает код, которого нет» не пройдёт молча.
 */
const FAILURE_CODE_PREFIXES = [
  'AGENT_',
  'CAPABILITY_',
  'CANCEL_',
  'COHORT_',
  'CREDENTIAL_',
  'DATA_',
  'ENGINE_',
  'IDEMPOTENCY_',
  'INVALID_',
  'LAUNCH_',
  'METHOD_',
  'MISSING_',
  'NOT_FOUND',
  'PAYLOAD_',
  'PAID_',
  'PREFLIGHT_',
  'PROFILE_',
  'PROMOTION_',
  'PROVIDER_',
  'REGION_',
  'REPOSITORY_',
  'RESULT_',
  'ROUTE_',
  'RUNNER_',
  'SCOPE_',
  'STALE_',
  'TASK_',
  'UNAUTHENTICATED',
  'UPLOAD_',
  'WORKER_',
];

/**
 * Токены, которые документ называет не кодами отказа: удалённые переменные из §2 и переменные
 * окружения для CLI из §8. Они проходят по префиксам, но проверке на существование не
 * подлежат — иначе документ не смог бы честно сказать «этого больше нет».
 */
const NOT_FAILURE_CODES = new Set([
  'AGENT_API_DATA_DIR',
  'AGENT_API_FAULTS',
  'AGENT_API_RELEASE_MANIFEST',
  'RUNNER_API_KEY_FILE',
  'RUNNER_API_URL',
]);

/** Коды отказа, названные в документе: заглавные слова с подчёркиваниями из списка выше. */
function documentedFailureCodes(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9_]{4,})\b/g)) {
    const token = match[1]!;
    if (NOT_FAILURE_CODES.has(token)) continue;
    if (FAILURE_CODE_PREFIXES.some((prefix) => token.startsWith(prefix))) found.add(token);
  }
  return [...found];
}

describe('docs/API-SERVICE.md не отстаёт от кода', () => {
  it('каждая хостовая переменная окружения из src/api описана в §2', () => {
    const documented = section2();
    const missing = readEnvNames(codeText)
      .filter((name) => CONFIG_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .filter((name) => !documented.includes(name))
      .sort();
    expect(missing, `переменные без строки в §2: ${missing.join(', ')}`).toEqual([]);
  });

  it('ни один код отказа из документа не отсутствует в коде', () => {
    const missing = documentedFailureCodes(doc)
      .filter((code) => !codeText.includes(`'${code}'`))
      .sort();
    expect(missing, `коды отказа без реализации: ${missing.join(', ')}`).toEqual([]);
  });

  it('путь журнала по умолчанию доступен юниту на запись', () => {
    const deploy = readFileSync(resolve(repoRoot, 'scripts/deploy-api-service.sh'), 'utf8');
    const unit = readFileSync(resolve(repoRoot, 'infra/agent-runner-api.service'), 'utf8');

    const defaultMatch = deploy.match(/^JOURNAL_DIR="\$\{JOURNAL_DIR:-(.+?)\}"/m);
    expect(defaultMatch, 'в деплой-скрипте не найден дефолт JOURNAL_DIR').not.toBeNull();
    const journalDir = defaultMatch![1]!;

    // Юнит работает с ProtectSystem=full: без ReadWritePaths каталог журнала недоступен,
    // процесс не упадёт, но дедупликация останется в памяти — ровно та тихая поломка,
    // которую документ обязан предотвратить.
    const granted = unit
      .split('\n')
      .filter((line) => line.startsWith('ReadWritePaths='))
      .flatMap((line) => line.slice('ReadWritePaths='.length).split(' ').filter(Boolean));
    const covered = granted.some(
      (path) => journalDir === path || journalDir.startsWith(`${path.replace(/\/$/, '')}/`),
    );
    expect(
      covered,
      `юнит не даёт записи в ${journalDir} (ReadWritePaths: ${granted.join(', ') || 'нет'})`,
    ).toBe(true);
  });
});
