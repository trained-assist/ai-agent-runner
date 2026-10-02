# E2E acceptance loop (issue #2) — цикл приёмки владельца

Замкнутый прогон сценариев приёмки из [issue #2](https://github.com/trained-assist/ai-agent-runner/issues/2): submit → events → faults → restart/reboot → security-пробы → артефакт → креды. Каждый шаг даёт явный **PASS/FAIL с reproduction**, результат — JSON-отчёт; каждый провал оформляется issue в этом репо с reproduction из цикла (шаг 8 цикла).

Драйвер: `scripts/e2e-loop.mjs` (+ обёртка `scripts/e2e-loop.sh`). Продуктовый код `src/` цикл **не меняет** — он работает только через публичный API (`src/api`: submit/status/events/cancel/result) и реестр faults slice-1.

## Как запустить

```bash
npm ci                 # нужны devDependencies (typescript/vitest)
./scripts/e2e-loop.sh  # либо: node scripts/e2e-loop.mjs --help
```

Драйвер сам собирает `src/` в `.e2e-dist/` (tsc, gitignore; `package.json` не трогается), поднимает дочерний процесс API-сервера, прогоняет шаги и пишет отчёт. Node 20+, без платных моделей: по умолчанию работают только fake-движки и локальные engine-скрипты.

Полезные опции:

| Опция | Что делает |
|---|---|
| `--report <path>` | путь JSON-отчёта (дефолт `./e2e-loop-report.json`) |
| `--root <dir>` | каталог данных прогона (дефолт — временный; при `--with-reboot` — персистентный `/var/lib/e2e-loop/<id>`, см. ниже) |
| `--only <ids>` / `--skip <ids>` | выбрать/пропустить шаги (перепрогон одного провала) |
| `--keep-data` | не удалять каталог данных (автоматически остаётся при FAIL) |
| `--foreign-profile <path>` | цель пробы «чужой профиль» (на VM: напр. `/home/vova`) |
| `--sudo-policy deny\|report` | `deny` (дефолт): passwordless sudo = FAIL; `report`: зафиксировать без провала — только для CI-хостов |
| `--with-opencode` | добавить прогон security-проб настоящим `opencode` (может звать модели!) |
| `--with-reboot` | полный `systemctl reboot` VM — **только под root, явно**; шаг идёт последним |

Exit codes: `0` — все шаги зелёные, `1` — есть FAIL, `2` — ошибка запуска/guard.

## Шаги цикла

| Шаг | id | Что проверяет |
|---|---|---|
| 1 | `step-1-submit-idempotency` | submit → receipt; дубль с тем же ключом = 200/тот же runId/`deduplicated=true` и **один** engine start; другой payload с тем же ключом = 409 `IDEMPOTENCY_CONFLICT` |
| 2 | `step-2-events-stream-replay` | SSE-поток с snapshot, обрыв соединения, reconnect по `Last-Event-ID` без повторов; JSON cursor-реплей полной цепочки `claimed→materialized→started→…→succeeded` (sequence без дыр, один claimed); reconnect ≠ rerun |
| 3 | `step-3-fault-injection` | nonzero exit / startup failure / timeout / crash (fake-сценарии) **и** точки реестра faults (`spawn`, `preflight`, once): каждый кейс = `failed` + ожидаемый `exitReason` + `failure.code`, тот же код в терминальном событии; после очистки реестра обычный run снова `succeeded` |
| 4 | `step-4-recovery-restart` | run висит → процесс runner убит `SIGKILL` и перезапущен: status/events читаются, `connectionLost=true` при `state=running` (**потеря связи ≠ failed**), `state.json`/`events.jsonl` пережили рестарт, реплей с диска, повторный submit = dedup без второго start, cancel гасит осиротевший процесс до терминала |
| 4b | `step-4b-reboot` (только `--with-reboot`, root) | полный `systemctl reboot` посреди run'а: после загрузки systemd resume-юнит дочитывает status/events/result (`failed/WORKER_CRASH` — без скрытого rerun), повторный submit = тот же receipt, store содержит один run. В дефолтном прогоне **не выполняется**; состояние шага живёт в персистентном каталоге — см. «Reboot-прогон и персистентные пути» |
| 5 | `step-5-security-probes` | изнутри рана: чтение чужого профиля, `sudo -n`, metadata `169.254.169.254`, `secrets.env` → ожидается **DENIED**; каждая попытка видна в scoped events (`E2E_PROBE …`) и в `events.jsonl` на диске; env рана содержит только allowlist; `LEAKED` = FAIL |
| 6 | `step-6-artifact` | агент создаёт файл в workspace → клиент забирает через `GET /v1/runs/{id}/download` и сверяет sha256/размер с объявленным и с диском; файл `0600`, workspace `0700`; traversal `../` = 400, без ключа = 401, нет файла = 404 |
| 7 | `step-7-credential-scopes` | синтетические креды: scope `read` → gateway пишет 403 (зафиксирован в попытках), scope `write` → 200; в ран передаются только allowlist-переменные; значения кредов отсутствуют в receipt/status/result/events, в `events.jsonl`, в server log, в `admissions.json`/`operations.json`/`state.json` и в workspace после run |

## Reboot-прогон и персистентные пути (issue #6)

`reboot-state.json`, durable store (`runs/<runId>/…`), ключи и отчёт шага 4b **по определению** должны
пережить `systemctl reboot`, а `/tmp` при загрузке чистится (Ubuntu 24.04 / tmpfiles). Поэтому при
`--with-reboot` драйвер ведёт себя так (guard срабатывает **до** mkdir/сборки, exit 2):

- `--root` не задан → каталог данных по умолчанию **персистентный**: `/var/lib/e2e-loop/<id>` под root
  (0700 на каталог и родителя), вне root — `<repo>/.e2e-state/<id>` (в gitignore);
- `--root <dir>` под `/tmp` → отказ с понятной ошибкой (вместо тихого ENOENT в resume-юните);
- `--report <path>` под `/tmp` (задан явно) → отказ; дефолтный отчёт из временного cwd переезжает
  в `<rootDir>/e2e-loop-report.json`;
- resume-юнит получает эти пути из `reboot-state.json`; отсутствие состояния при старте resume —
  явная ошибка с указанием на issue #6, а не stack trace ENOENT;
- без `--keep-data` resume удаляет каталог прогона после записи отчёта (отчёт — вне каталога данных).

Повтор прогона после фикса: `./scripts/e2e-loop.sh --only step-4b-reboot --with-reboot [--keep-data]`
из-под root; шаг входит и в полный прогон с тем же флагом (идёт последним).

## Отчёт

`./e2e-loop-report.json` (атомарная запись после каждого шага):

```jsonc
{
  "schemaVersion": 1,
  "issue": "#2",
  "startedAt": "...", "finishedAt": "...",
  "env": { "node": "...", "rootDir": "...", "port": 43123, "flags": [] },
  "steps": [
    {
      "id": "step-5-security-probes",
      "status": "PASS" | "FAIL",
      "durationMs": 1813,
      "checks": [{ "name": "...", "ok": true, "detail": "..." }],
      "reproduction": "node scripts/e2e-loop.mjs --root ... --only step-5-...",
      "issueDraft": { "title": "e2e-loop: FAIL ...", "body": "..." }   // только при FAIL
    }
  ],
  "summary": { "total": 7, "passed": 7, "failed": 0, "skipped": 0, "ok": true, "finalized": true }
}
```

При FAIL драйвер печатает упавшие проверки, reproduction и черновик issue, оставляет каталог данных (`--root` из reproduction) и выходит с кодом 1. Дальше — `gh issue create` с этим телом, фикс, перепрогон `--only <id>` (шаг 8 цикла).

## Прогоны: где и с какими ожиданиями

- **Локально / инженерно** — `./scripts/e2e-loop.sh`, все 7 шагов, детерминированно, free-only.
- **Песочная VM (`/opt/sb`, пользователь `sandbox`)** — прогон по явной команде; пробы идут с дефолтным `--sudo-policy deny`. `--foreign-profile` можно указать на реальный чужой профиль. `--with-reboot` — только из-под root (записывает systemd resume-юнит, делает reboot последним шагом, сам чистит юнит после resume).
- **CI (ubuntu-latest раннер)** — тест `test/e2e-loop.test.ts` запускает драйвер с `--sudo-policy report`: у раннера GitHub штатно есть NOPASSWD sudo, это инфраструктура CI, а не продуктовый хост. На продуктовых хостах оставляйте `deny`.
- **`--with-opencode`** — отдельная опция: одна security-проба настоящим `opencode` (инструкция — выполнить probe-скрипт и показать вывод); ожидания: run терминален, канарейки чужого профиля/secrets не утекли в логи, `verdict=LEAKED` отсутствует. Вне дефолтного прогона, т.к. может обращаться к моделям.

## Границы: что здесь harness, а не продукт

Чтобы не трогать `src/api`/`src/storage` (параллельная сессия) и не выдавать заготовки за готовый функционал:

- **`GET /v1/runs/{id}/download`** и **credential gateway** (`/_e2e/cred/{read,write}`) живут в `scripts/e2e-loop/server.mjs` — e2e-стенд-ины под P07 (artifact transfer) и Credential Broker (architecture #30). Продуктовый контракт появится в своих срезах; цикл проверяет уже сейчас поведение «клиент получает байты через API» и «scope read не пишет».
- **Синтетические креды** генерируются на каждый прогон в `<root>/e2e-credentials.json` (mode 0600), значения попадают только в env дочернего сервера и в этот файл; в репозиторий ничего не пишется.
- **Security-пробы идут от того же UID**, что и runner: deny обеспечивается правами файлов (каталог/файл mode 000), пустым env рана и сетевыми отказами. Межпользовательская изоляция (другой UID, namespaces/cgroups) — slice 3, ARCHITECTURE §6; эти атаки цикл сегодня не покрывает и не притворяется, что покрывает.
- **`__CF_USER_TEXT_ENCODING`** (macOS) Node инжектит в child env сам — он исключён из проверки «env рана = allowlist», это платформенная переменная, а не утечка host-окружения.

## Приёмка issue #2

- [x] `scripts/e2e-loop.sh` (эквивалент `npm run e2e`; package.json не менялся — deps не нужны) проходит шаги 1–7 с ожидаемыми отказами, детерминированно, free-only.
- [x] Reboot-кейс: один run, один receipt, никакого rerun (`--with-reboot` под root; в дефолтном прогоне guard отклоняет флаг без root; состояние шага — в персистентном каталоге, `--root`/`--report` под `/tmp` отклоняются до старта — issue #6).
- [x] Security-пробы: 0 успешных выходов за scope; попытки видны в structured logs.
- [x] Артефакт байт-в-байт у клиента; креды не в логах/events/receipt/workspace.
- [x] Каждый исторический провал = issue с reproduction (дрейвер формирует черновик; см. открытые issue репо).

## Структура

```
scripts/e2e-loop.sh          обёртка
scripts/e2e-loop.mjs         драйвер: аргументы, дист-сборка, отчёт, reboot-режим
scripts/e2e-loop/
  checks.mjs (+.d.mts)       проверки цепочек событий, секреты, Step/отчёт
  client.mjs                 HTTP + SSE (cursor/Last-Event-ID) + control-клиент
  persistence.mjs            персистентные пути и guard'ы --with-reboot (issue #6)
  server.mjs                 дочерний API-сервер: src/api + engine-реестр + download/gateway/_e2e
  steps.mjs                  шаги 1–7
  engine-scripts/            probe.mjs, artifact.mjs, cred.mjs, slow.mjs
  tsconfig.build.json        сборка src/ → .e2e-dist (вне package.json)
test/e2e-loop.test.ts        прогон драйвера целиком + осознанный FAIL + reboot guard
test/e2e-loop-checks.test.ts юнит-проверки цепочек/шагов/секретов
test/e2e-loop-persistence.test.ts юнит-проверки персистентных путей/гардов (issue #6)
```
