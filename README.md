# AI Agent Runner

Статус: **slice 1 + Serverless Agent API (P04–P06) + slice D1 (storage/артефакты) + E2E acceptance loop (issue #2) + MCP lifecycle и scoped bindings (P13, этап I04) реализованы** · 03.10.2026. Код жизненного цикла Run, внешний admission/result adapter, storage-контракт с менеджментом артефактов и цикл приёмки владельца есть в этом репозитории; materialize/sweep и межмашинные leases ещё не вынесены (см. roadmap).

**Agent Runner** управляет запуском **ai-agent-job** на выбранной виртуальной машине: готовит **Agent clean room**, запускает агентский движок с разрешёнными правами, наблюдает выполнение, сохраняет результат и освобождает ресурсы.

Диспетчер платформы выбирает машину и регион. Runner на этой машине исполняет согласованное описание запуска. Скрипт запуска — внутренний, версионируемый adapter движка; его недостаточно для всего жизненного цикла.

- [Draft архитектуры](ARCHITECTURE.md): границы, контракты, изоляция, восстановление и этапы выделения.
- [Общая архитектура платформы](https://github.com/trained-assist/trained-agent-architecture): пользовательские сценарии и межсервисные контракты.
- [Serverless Agent API spec](https://github.com/trained-assist/trained-agent-architecture/blob/main/SERVERLESS-AGENT-API.md): логический API, receipt, connection_lost.
- [Терминология](https://github.com/trained-assist/trained-agent-architecture/blob/main/TERMINOLOGY.md): Job, Run и типы заданий.
- [Observability-контракт](https://github.com/trained-assist/trained-agent-architecture/blob/main/OBSERVABILITY-AND-ERROR-CONTRACT.md): формат structured events.
- Эпики: [trained-agent-architecture#17](https://github.com/trained-assist/trained-agent-architecture/issues/17) (E1, карточки P01–P03), [trained-agent-architecture#18](https://github.com/trained-assist/trained-agent-architecture/issues/18) (E2, карточки P04–P06).

## Slice 1 — что реализовано

Соответствует [ARCHITECTURE §4–5](ARCHITECTURE.md) и пункту 1 порядка выделения (§9): «Согласовать RunSpec, события и ownership; подготовить fake adapter».

| Область | Файл | Что делает |
|---|---|---|
| Контракты | `src/contracts/` | `RunSpec` (минимальные группы §5 + `profileId/conversationId/userTaskId/ownerGeneration/engine/cwd/envAllowlist`), `RunnerEvent` (claimed/materialized/started/log/exit/finalizing/succeeded/failed/cancelled/connection_lost), `RunResult` — типы + лёгкая runtime-валидация без внешних зависимостей; неизвестные поля в запрете, секреты в spec не попадают |
| Движки | `src/adapters/engine/` | Интерфейс `EngineAdapter`, детерминированный `FakeEngine` (success, nonzero-exit, startup-failure, timeout, crash, cancel-with-children с настоящим внуком-процессом), заглушка `OpenCodeAdapter` (спавнит настоящий `opencode`, если бинарь есть, иначе падает типизированной startup-ошибкой) |
| Жизненный цикл | `src/runner/` | State machine `queued→starting→running→finalizing→succeeded/failed/cancelled`; идемпотентный `start(spec, operationId)` (повтор = один запуск, другой payload = conflict); `cancel` гасит процессное дерево (SIGTERM→grace→SIGKILL), повтор безопасен; fencing по `ownerGeneration`; `recover()` после рестарта рабочего процесса; идемпотентная финализация с одним `result.json` |
| Persist | `src/runner/run-store.ts` | Запись переживает процесс: `runs/<runId>/state.json`, `runs/<runId>/events.jsonl`, `runs/<runId>/result.json`, `operations.json` (durable receipt до запуска) |
| Scoped logs | `src/runner/scoped-log.ts` | JSONL, один файл на run: `schemaVersion/eventId/runId/jobId/userTaskId/profileId/ownerGeneration/sequence/timestamp(UTC)`, redaction секретов, ограниченный `droppedLogCount` при недоступном sink |
| Fault injection | `src/faults/` | Реестр injectable-точек: `preflight`, `spawn`, `heartbeat` (connection_lost), `finalization`, `log_sink`, `recovery`; поведения throw/custom/connection_lost с бюджетом once/count |

### Что покрыто тестами (§9 «Проверки до первого production rollout»)

- [x] Duplicate start до и после crash возвращает один запуск — `test/idempotency.test.ts`
- [x] Cancel останавливает engine и дочерние процессы; повтор cancel безопасен — `test/lifecycle.test.ts`, `test/fake-engine.test.ts`
- [x] Worker restart восстанавливает запись либо фиксирует потерю без скрытого rerun — `test/restart.test.ts`
- [x] Поздние события старого ownerGeneration не меняют текущую задачу — `test/fencing.test.ts`
- [x] Отсутствие бюджета, credentials и запрещённый регион дают структурированные outcomes — `test/structured-outcomes.test.ts`
- [x] Сбой export не теряет результат; повтор commit не дублирует изменения (локальный manifest) — `test/faults.test.ts`
- [x] Streaming/engine logs и события связаны с Run и доступны после restart — `test/restart.test.ts`, `test/lifecycle.test.ts`
- [ ] Cross-user filesystem/tool/credential probes — вне slice 1 (изоляция переносится в slice 3)
- [ ] Isolation failure не запускает движок с более широкими правами — вне slice 1
- [ ] Cleanup crash восстанавливается; переиспользование ресурса — вне slice 1 (sweep/storage — следующий slice)

Каждый сбой из §9, существующий в этом slice, воспроизводим fault-injection'ом на fake engine — `test/faults.test.ts`.

## Slice 2 — Serverless Agent API (P04–P06)

Соответствует [SERVERLESS-AGENT-API.md](https://github.com/trained-assist/trained-agent-architecture/blob/main/SERVERLESS-AGENT-API.md), ARCHITECTURE §4.6 и карточкам [P04/P05/P06 эпика E2](https://github.com/trained-assist/trained-agent-architecture/issues/18). Внешний admission/result adapter для одной VM: node:http без фреймворков, один процесс — один владелец.

| Область | Файл | Что делает |
|---|---|---|
| Auth/principals | `src/api/auth.ts` | Реестр ключей на одну VM: ключ хранится только как sha256 `keyHash`, сверка через `timingSafeEqual`, Bearer-схема; файловый реестр `keys.json` (hashes only); scopes `runs:read`/`runs:write` и allowlist engines на principal |
| Контракты API | `src/api/contracts.ts` | Submit body = подмножество RunSpec (server-owned поля запрещены), `Receipt {requestId, userTaskId, runId}`, статусы включая `awaiting_user` (зарезервировано за control plane), payload hash через canonical JSON |
| Durable store | `src/api/store.ts` | `api/admissions.json` (atomic write как в RunStore): write-ahead запись принятого запроса ДО `runner.start`, индексы по idempotency key/runId/userTaskId, переживает рестарт процесса |
| Сервис | `src/api/service.ts` | submit → write-ahead admission → `runner.start`; дедуп по (principal, Idempotency-Key) → тот же receipt, другой payload → 409 conflict; heal принятых, но не стартовавших записей; вторая живая попытка задачи → 409, после terminal — новый runId при том же userTaskId/requestId (`ownerGeneration+1`); status/cancel/result/events поверх runner; `recover()` = `runner.recover()` + admission heal |
| HTTP | `src/api/server.ts` | `POST /v1/runs`, `GET /v1/runs/{id}/status`, `POST .../cancel`, `GET .../result`, `GET .../events`, `GET .../artifacts`, `GET /v1/capabilities` (+`/healthz`); структурированные ошибки `{error:{code,message,details}}`; body cap 413; логи запросов без заголовков и ключей |
| SSE replay | `src/api/server.ts` | `GET .../events` с `Accept: text/event-stream`: snapshot + `id/event/data`, cursor из `?cursor` или `Last-Event-ID`, keepalive, завершение потока на терминальном событии |

Ключевые семантики:

- **Receipt значит «принято», а не «запущено»** (AC-65): успешный ответ202/200 возвращает receipt; запуск агента наблюдается через status/events.
- **Idempotency**: повтор submit с тем же ключом и payload → тот же receipt и ноль вторых запусков — до и после рестарта процесса (P06); другой payload с тем же ключом → `IDEMPOTENCY_CONFLICT`.
- **`connection_lost` ≠ `failed`** (AC-66): потеря связи — отдельное поле `connectionLost` в status; состояние остаётся последним наблюдённым; result отвечает `RESULT_NOT_READY`.
- **Cancel ≠ stopped** (AC-67): `stop_pending` (HTTP 202) отличается от `stopped`; stale `ownerGeneration` → 409 `STALE_OWNER_GENERATION` без изменения статуса (fencing slice-1).
- **Recovery API-сессии** (P06): после рестарта клиент дочитывает status/events/receipt без rerun; orphan помечается `connection_lost`, погибший worker — `failed` c `WORKER_CRASH`; ни один путь не запускает вторую копию.
- `awaiting_user` входит в контракт состояний, но standalone adapter его не производит (durable prompt+response — control plane, P12).
- **Декларация вместо догадок**: `GET /v1/capabilities` возвращает поддержку контракта — `engineResume: unsupported`, `awaitingUserInput: unsupported`, `autoRerunOnDisconnect: false`, `continuation.policy: new_run_same_user_task` (новая попытка = новый `runId`, тот же `userTaskId`/`conversationId`, сохранённые данные — `run_result`/`run_events`/`run_artifacts`). `status` отдаёт `conversationId`, чтобы приёмник проверял этот инвариант, а не полагался на свою память.
- **Ссылки на артефакты рана**: `GET /v1/runs/{id}/artifacts` — манифесты своего `profileId`, переживают рестарт процесса (шаг 4 «результат и ссылки на артефакты»).

### Что покрыто тестами

- [x] Duplicate submit до и после crash = один запуск — `test/api-service.test.ts`, `test/api-recovery.test.ts`
- [x] Несовместимый payload = conflict; без ключа/сcope/разрешённого engine — отказ до запуска — `test/api-service.test.ts`, `test/api-http.test.ts`
- [x] Секреты/ключи не попадают в логи, ответы и store-файлы — `test/api-http.test.ts`
- [x] Reconnect/replay без rerun: JSON cursor replay + SSE с обрывом потока — `test/api-service.test.ts`, `test/api-http.test.ts`
- [x] Принятый запрос переживает рестарт; status не запускает агента; heal write-ahead admission — `test/api-recovery.test.ts`
- [x] Late-события/stale cancel старого ownerGeneration не меняют статус — `test/api-service.test.ts`, `test/api-http.test.ts`
- [x] Structured outcomes: missing key, bad spec, budget/credentials denied — `test/api-service.test.ts`, `test/api-http.test.ts`
- [x] `connection_lost` ≠ failed; cancel requested ≠ stopped — `test/api-service.test.ts`, `test/api-http.test.ts`
- [x] Два principals изолированы (read/cancel чужого run → 404) — `test/api-service.test.ts`
- [x] Декларация контракта (`/v1/capabilities`), ссылки на артефакты рана (переживают restart), инвариант попытки (новый `runId`, тот же `userTaskId`/`conversationId`, `TASK_ATTEMPT_ACTIVE`) — `test/api-contract-readiness.test.ts`

## E2E acceptance loop (issue #2)

Замкнутый цикл приёмки: submit/идемпотентность → events stream/replay → fault injection → recovery после kill -9 (+ reboot по флагу) → security-пробы → артефакт через API → креды со скоупами. Каждый шаг — PASS/FAIL с reproduction, результат — JSON-отчёт, провал — готовый черновик issue.

```bash
npm ci                 # devDependencies (typescript/vitest)
./scripts/e2e-loop.sh  # либо node scripts/e2e-loop.mjs --help
# → ./e2e-loop-report.json, exit 0 = все шаги зелёные
```

Драйвер сам компилирует `src/` в `.e2e-dist/` (package.json/lock не меняются), поднимает дочерний API-сервер и работает только через его HTTP-контракт. Дефолтный прогон — детерминированный и free-only (fake-движки); `--with-reboot` (только root) и `--with-opencode` включаются явно. При `--with-reboot` состояние шага живёт в персистентном каталоге (`/var/lib/e2e-loop/<id>`, guard отклоняет `--root`/`--report` под `/tmp` до старта — issue #6). Провал шага: `node scripts/e2e-loop.mjs --root <data> --only <step-id>`.

Подробности, границы harness (download/gateway — e2e-стенд-ины под P07/#30) и ожидания на песочной VM — [docs/E2E-acceptance-loop.md](docs/E2E-acceptance-loop.md).

Из «Проверок до первого production rollout» ([ARCHITECTURE §9](ARCHITECTURE.md)) цикл закрывает: duplicate start = один запуск (шаги 1 и 4), worker restart восстанавливает запись либо фиксирует потерю без скрытого rerun (шаг 4), сбои дают структурированные outcomes (шаг 3), filesystem/tool/credential probes блокируются (шаг 5; оговорка про UID — в docs), engine logs и события доступны после restart (шаг 4).
## Slice D1 — Storage и менеджмент артефактов

Соответствует [ARCHITECTURE §5](ARCHITECTURE.md) (контракт C05), §7 «Рабочие данные и финализация» (export commit) и §10 «Открытые решения» (snapshot/commit semantics, result retention — остаются открытыми), [SERVERLESS-AGENT-API § direct artifact transfer](https://github.com/trained-assist/trained-agent-architecture/blob/main/SERVERLESS-AGENT-API.md) и [PR #13 в arch-репо](https://github.com/trained-assist/trained-agent-architecture/pull/13) (один контракт — три бэкенда; **никаких presigned URL в записях данных**).

| Область | Файл | Что делает |
|---|---|---|
| Контракт | `src/storage/blob-store.ts` | `BlobStore {put, get, head, delete?}`: `put → {sha256, size, generation}`, sha256 **сохранённых** байтов (C05) подтверждается бэкендом (local-fs — read-back хэша, GCS — crc32c объекта), каждый вызов ограничен дедлайном (`BLOB_TIMEOUT`), опциональный `shareUrl` для presigned-выдачи; ошибки `BLOB_*`/`ARTIFACT_*` проходят redaction |
| Ключи | `src/storage/keys.ts` | Один строитель ключей: `runs/<runId>/artifacts/<artifactId>` и `profiles/<profileId>/...`; запрет `..`, абсолютных путей, NUL и пустых сегментов (`BLOB_UNSAFE_KEY`), `slugKeySegment` для потенциально «грязных» id |
| local-fs | `src/storage/local-fs.ts` | Один VM + тесты: atomic write, **read-back sha256** после записи, `generation` = mtime; io асинхронный (`fs/promises`), поэтому дедлайну есть где сработать; инжектируемый `io` — в тестах нет живого диска (синхронный инжектируемый io блокирует loop и дедлайн не сработает — caveat) |
| GCS | `src/storage/gcs.ts` | `@google-cloud/storage`, **ADC через metadata-сервер, ключей на диске нет**; после записи сверяется `crc32c` объекта (иначе `BLOB_UPLOAD_UNVERIFIED`), клиент создаётся лениво при первом обращении, bucket инжектируется в тестах (никакого ADC/сети в тестах) |
| R2/S3 | `src/storage/r2.ts` | Заготовка: `BLOB_BACKEND_UNSUPPORTED` с явным gap — S3-клиент, presigned upload/download session, multipart/resume + abort-expiry, CORS браузера |
| Выбор по env | `src/storage/create-blob-store.ts` | `STORAGE_BACKEND=local-fs\|gcs\|r2` (default `local-fs`), `STORAGE_LOCAL_ROOT`, `GCS_BUCKET`, `STORAGE_DEADLINE_MS`; неизвестный бэкенд → `BLOB_BACKEND_MISCONFIGURED` |
| Manifest | `src/storage/manifest.ts` | Ровно `{artifactId, runId, userTaskId, profileId, name, mime, size, sha256, storageKey, createdAt}`; **неизвестные поля запрещены** — URL/токен в запись данных не попасть может |
| Менеджмент | `src/storage/artifact-store.ts` | Один json на артефакт рядом с run: `runs/<runId>/artifacts/<artifactId>.json` (atomic, рядом с `state.json/result.json`); `put` (идемпотентный по sha, дубль `artifactId` в другом run → `ARTIFACT_CONFLICT`, конфликт байтов → `ARTIFACT_CONFLICT`), `read` (сверка байтов с digest'ом), `commit` (глубокая сверка без перезаписи), `export` (чек `present/verified/missing/size_mismatch/corrupt`); неоднозначный id (файл появился вне store) → `find` отдаёт `null` → 404 (fail closed) |
| Share-by-link | `src/storage/share.ts` | `ShareTokenIssuer` — короткоживущий HMAC-токен, привязанный к `artifactId` + срок (секрет: аргумент или `ARTIFACT_SHARE_SECRET`); `createShareLink` → для local-fs токен-URL через API (`baseUrl` или `ARTIFACT_BASE_URL`), для GCS presigned/generation URL. **Ссылка нигде не хранится**: в manifest поля нет, в логи попадает путь без query-string |
| API-точка входа | `src/api/artifact-route.ts` | **Новый файл-роут**, существующие файлы `src/api/**` не менялись: `GET /v1/artifacts/:id[?t=…]`, алиас `GET /artifact/:id`, `…/meta` → manifest; auth = share-токен **или** Bearer + `runs:read` + сверка `profileId` (чужой профиль → 404) |

### Как шарить артефакт ссылкой

```ts
import { createLocalFsBlobStore, ArtifactStore, ShareTokenIssuer, createShareLink, createArtifactServer } from 'ai-agent-runner';

const blob = createLocalFsBlobStore({ rootDir: './data/blobs' });   // или createBlobStore() по env
const artifacts = new ArtifactStore({ rootDir: './data', blob });
const tokens = new ShareTokenIssuer({ secret: process.env.ARTIFACT_SHARE_SECRET, ttlSeconds: 600 });

const manifest = await artifacts.put({ runId, userTaskId, profileId, name: 'report.csv', mime: 'text/csv', bytes });
const link = await createShareLink({ blob, tokens, baseUrl: 'http://vm:8080' }, manifest);
// link.url → http://vm:8080/v1/artifacts/art-…?t=…   (не записывать в manifest/журналы)
createArtifactServer({ artifacts, keys, tokens, logger }).listen(8080);
```

`handleArtifactRequest(req, res, deps)` возвращает `null` для чужих путей — одна строка монтирования в существующий `createAgentApiServer`, если понадобится общий listener (в этом slice роут работает как отдельный сервер; **правки в существующие файлы `src/api/**` не вносились**, потому что их ведёт параллельная сессия).

Переменные окружения storage:

```bash
STORAGE_BACKEND=local-fs|gcs|r2   # выбор бэкенда, default local-fs
STORAGE_LOCAL_ROOT=data/blobs     # корень local-fs (относительно cwd)
GCS_BUCKET=<bucket>               # обязателен для gcs: ADC через metadata-сервер, ключи на диске не используются
STORAGE_DEADLINE_MS=60000         # дедлайн каждого вызова storage → BLOB_TIMEOUT
ARTIFACT_SHARE_SECRET=<random>    # HMAC-секрет share-токенов; без него — случайный секрет процесса (ссылки живут до рестарта)
```

### Что покрыто тестами

- [x] sha256 сохранённых байтов: read-back в local-fs, crc32c-сверка объекта в GCS — `test/storage-backends.test.ts`, `test/storage-manifest.test.ts`
- [x] Дедлайн каждого вызова (`BLOB_TIMEOUT`) — `test/storage-blob-store.test.ts`, `test/storage-backends.test.ts`
- [x] Мок-бэкенд: инжектируемые `io`/bucket, ни одного живого хранилища и ни одного обращения к ADC в тестах — `test/storage-backends.test.ts`
- [x] Manifest round-trip через переоткрытый store + запрет неизвестных полей — `test/storage-manifest.test.ts`
- [x] Дубль `artifactId` между runs: `ARTIFACT_CONFLICT` на put и fail-closed `find` — `test/storage-manifest.test.ts`
- [x] Ссылка/токен не утекает в manifest и в логи (путь без query, включая error-ответы) — `test/storage-share.test.ts`, `test/storage-api-route.test.ts`
- [x] Выбор бэкенда по env, включая отказ до ADC — `test/storage-backends.test.ts`
- [x] Share-ссылка: выдача, tamper, истечение, чужой артефакт, изоляция профилей — `test/storage-api-route.test.ts`

### Готово / не готово

- **Готово:** контракт C05 + local-fs + GCS + manifest/commit/export + share-by-link + точка входа в API.
- **Gap R2/S3:** заготовка без клиентской части (см. `src/storage/r2.ts`) — до неё presigned upload/download-сессии и multipart/resume не работают.
- **Gap GCS presigned:** v4-подпись под ADC требует `roles/iam.serviceAccountTokenCreator` у сервис-аккаунта (локального приватного ключа нет и не будет); без права `getSignedUrl` → `BLOB_BACKEND_UNSUPPORTED`, рабочая альтернатива — share-токен через API (local-fs путь) либо R2/S3. Smoke на живом бакете — отдельной задачей, в тестах только инжектируемый bucket.
- **Вне этого slice (roadmap):** интеграция с GitHub — текстовой образ профиля → приватные репозитории `profiles-artifacts` ([trained-assist-agent#1921](https://github.com/trained-assist/trained-assist-agent/issues/1921)); materialize при старте и sweep в finalizing (D2); открытые вопросы ARCH §10 — snapshot/commit semantics и retention/export-гарантии.

## Деплой на песочную VM + runner-cli (dogfooding, runner#7)

Сервисный запуск того же API на одной VM: `infra/agent-runner-api.service` (systemd, `User=sandbox`, `Restart=always`, durable store `/var/lib/agent-runner` `0700`) + `scripts/deploy-api-service.sh` (build → dirs → генерация API-ключа `0600` → юнит → enable+start → `GET /healthz` → проверка auth → **ufw открывает порт только после успешной auth-пробы**). Порт **8787**, health — `GET /healthz` (единственный маршрут без ключа).

Ключ генерируется при деплое, живёт только в `/etc/agent-runner/api-key` (`0600`) и один раз печатается в лог первого деплоя — в репо/доки/коммит не попадает; в key registry хранится только sha256.

Транспорт для runner#7 — `scripts/runner-cli.mjs`: `submit/status/events/follow/result/cancel` против `RUNNER_API_URL` + `RUNNER_API_KEY` (или `RUNNER_API_KEY_FILE`/флаги `--url/--key/--key-file`).

```bash
bash scripts/deploy-api-service.sh                 # на VM, от root
export RUNNER_API_URL=http://127.0.0.1:8787 RUNNER_API_KEY_FILE=/etc/agent-runner/api-key
node scripts/runner-cli.mjs submit --prompt "hi" --engine fake
node scripts/runner-cli.mjs follow <runId>         # SSE до терминального состояния
```

Факты прогона на живой VM (юнит, порт, health, auth-пробы, смоук рана и артефакта, restart-персистентность): **[docs/API-SERVICE.md](docs/API-SERVICE.md)**.

## Запуск в GitHub Actions — что можно, чего нельзя (эксперимент 01–04.10.2026)

Замеры ограничений GitHub-hosted runner'а для задач проекта: тесты, Playwright, opencode
headless и e2e-цикл гоняются в CI; reboot, входящие порты и привилегированная OS-проба —
нет. Полная сводка с замерами времени и требованиями к запуску —
[docs/GITHUB-ACTIONS-CAPABILITY.md](docs/GITHUB-ACTIONS-CAPABILITY.md).

Ключевое: `ubuntu-latest` (4 CPU / 15 GiB), Node 20, секрет `LLM_LADDER_TOKEN`,
`--sudo-policy report` (passwordless sudo в CI — норма). Запуск Runner в CI занимает
**~8.7 s** от старта джобы до готового результата (npm ci 6.7 s + dist 1.9 s + сам ран
42 ms). Потолок памяти ~15 GiB, аллокация до ~18 GB убивает джобу (exit 143). Для
reboot-валидации и доказательства OS-границы — только песочная VM. План «джоба сама
опрашивает очередь задач» — issue [#10](https://github.com/trained-assist/ai-agent-runner/issues/10).

## Repository context — репозиторий в контексте run (01.10.2026)

RunSpec получил необязательную группу `repository`: ран клонирует репозиторий **до** спавна движка, и cwd движка = этот клон. Движок работает *в чужой репе* — это основа будущего pr-fixer.

| Поле | Формат | Смысл |
|---|---|---|
| `repository.fullName` | `owner/name` (regex, до 200 символов) | целевая репозитория, клонируется из `<base>/<fullName>.git` |
| `repository.token` | непустая строка до 500 символов (опционально) | токен доступа для приватной репы |

- **Пустая/отсутствующая группа = дефолтный режим**: клонируется `trained-assist/ai-agent-runner` (константа `DEFAULT_REPOSITORY_FULL_NAME`, env-оверрайд `RUNNER_DEFAULT_REPO` — для тестов: `owner/name` либо готовый источник вида `/tmp/fixture.git`/`file:///…`). Задачи без явной репозитории идут в контексте этого продукта.
- **Клон делает runner, не движок**: child-процесс `git clone --depth 1` в `src/runner/repository.ts`, таймаут 60 с (`CLONE_TIMEOUT_MS`). Движок получает только `cwd` готового клона; токен в его окружение не передаётся.
- **Секретность токена**: токен не попадает в argv git (argv виден через `ps` всем локальным пользователям) — он уходит в окружение child'а и доходит до git через статический `GIT_ASKPASS`-помошник, файл секрета на диск не пишется и удаляется сразу после clone. `redactRepositoryToken` вычищает поле из `state.json`, `admissions.json` и из хэшей (`specHash`/`submitPayloadHash` — ротация токена не ломает идемпотентность), `stripRepositoryToken` вычищает его из живой структуры после clone; `redactSecrets` дополнительно маскирует `ghp_…`/`github_pat_…`/`x-access-token:…`. Итог: токена нет в events, status, result, receipt, логах, отчётах и на диске — проверяется поиском по строке в JSON (`test/repository-context.test.ts`).
- **Ошибки**: любой сбой clone (404/403/нет сети/нет git/таймаут) — не crash, а структурированный отказ: `failure.code = REPOSITORY_UNAVAILABLE`, состояние `failed`, `exitReason = preflight_refused`, понятное сообщение в `safeSummary` (через redaction). API-валидация кривого `fullName` → **400 `INVALID_REPOSITORY`**.
- **Переопределения для тестов/гетерогенных стендов**: `RUNNER_DEFAULT_REPO`, `RUNNER_REPOSITORY_BASE_URL` (базовый URL вместо `https://github.com` — локальный git-сервер в тестах, self-hosted GitHub). Тесты офлайновые: `npm test` поднимает локальный фикстурный репозиторий (`test/default-repo-fixture-setup.ts`), интеграционные пробы идут на локальном git-сервере с Basic-auth.

Env/константы: `RUNNER_DEFAULT_REPO` (дефолтная репа), `RUNNER_REPOSITORY_BASE_URL` (база URL), `CLONE_TIMEOUT_MS=60000` (таймаут clone).

Покрытие: `test/repository-context.test.ts` (clone с токеном против локального репо, file://-клон без токена, дефолтная репа, redaction по всем поверхностям, clone-fail → `REPOSITORY_UNAVAILABLE`, 400 `INVALID_REPOSITORY`), `test/contracts.test.ts` (валидация группы), `test/default-repo-fixture-setup.ts` (офлайн-фикстура).

Оговорка: токен хранится только в памяти процесса до clone — после рестарта воркера queued-ран возобновляется уже без токена (для приватной репы это `REPOSITORY_UNAVAILABLE` до нового submit с токеном). Это осознанный обмен: секретов на диске нет.

## MCP lifecycle и scoped bindings (P13, этап I04)

Соответствует карточке [#52](https://github.com/trained-assist/trained-agent-architecture/issues/52) и этапу [SANDBOX · I04](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md#i04--mcp-и-доменные-capabilities). Детали архитектуры — [docs/MCP-LIFECYCLE.md](docs/MCP-LIFECYCLE.md).

| Область | Файл | Что делает |
|---|---|---|
| Контракт | `src/contracts/run-spec.ts` | Группа `RunSpec.mcp`: per-run stdio-серверы, `allowedTools`, `bindingRef` (обязан быть в `credentialBindings`), таймауты; имя инструмента уникально в пределах рана |
| Скоуп | `src/mcp/scope.ts` | `McpRunScope`: приёмка хоста — инструмент вне `allowedTools` не уходит в процесс; binding объявлен/активен; значение binding'а резолвится только хостом |
| Транспорт | `src/mcp/jsonrpc.ts`, `src/mcp/session.ts` | JSON-RPC по stdio; `McpServerSession` (spawn → `initialize` → `notifications/initialized` → `tools/list` → readiness), таймаут вызова, гашение SIGTERM→SIGKILL с проверкой смерти |
| Мост | `src/mcp/bridge.ts` | Unix socket (0600) + run token: `tools/list`, `tools/call`, `capability/invoke`. Binding и caller подставляет хост — процесс не выбирает их сам |
| Handlers | `src/mcp/capabilities.ts`, `src/mcp/demo-capabilities.ts` | Реестр capability handler'ов: один handler на MCP-вызов рана и на `POST /v1/capabilities/invoke`; outcome-виды из спецификации; write без effect receipt наружу не выходит |
| Интеграция | `src/runner/runner.ts` | Старт MCP до движка, отказ старта → `MCP_STARTUP_FAILED` с причиной в логе, cleanup на выходе/отмене/таймауте/dispose, дочистка осиротевших процессов после рестарта, fault point `mcp` |
| Фикстуры | `src/mcp/fixtures/`, `scripts/fake-remote-domain-service.mjs` | Per-run stdio MCP-сервер (режимы управляемых сбоев), per-run broker для движка, клиент MCP со стороны движка, общий внешний доменный сервис с auth per operation и квитанциями эффекта |
| Приёмка | `scripts/mcp-lifecycle-probe.mjs` | Пять сценариев на реальных процессах → sanitized-транскрипт в `docs/evidence/p13-mcp-lifecycle*/` |

Ключевые семантики:

- **Инструмент вызван по-настоящему, а не только перечислен**: доказательство — квитанция
  эффекта внешнего сервиса (`effectReceiptId`) и строка в журнале сервиса, а не «ок»
  инструмента (ловушка PR-16).
- **Чужой binding недоступен**: три слоя приёмки — объявление в `credentialBindings`,
  `allowedTools` рана, `requiredScopes` handler'а. Отказ фиксируется в логе рана с причиной.
- **Изоляция MCP объявляется честно и зависит от настройки хоста**: без провайдера границы
  per-run процессы MCP стартуют под тем же service UID, что и runner
  (`isolation=same_service_uid_not_os_isolated`,
  `GET /v1/capabilities: mcp.osIsolation = not_proven_service_uid_only`); с настроенной
  границей [чистой среды](#agent-clean-room-граница-рана-и-lifecycle-issue-5152) они
  стартуют под идентичностью своего рана.
- **Значения binding'ов не покидают хост**: в spec/state/events/логах/конфиге движка и
  окружении дочерних процессов их нет — проверяется пробой и тестом.

### Что покрыто тестами

- [x] Реальный вызов инструмента с квитанцией эффекта; отказы по `tool_not_in_scope` и по scope binding'а — `test/mcp-lifecycle.test.ts`
- [x] Упавший старт, зависший handshake (readiness timeout), зависший инструмент (tool timeout + гашение сервера) — `test/mcp-lifecycle.test.ts`
- [x] Отмена рана и рестарт воркера гасят MCP-процессы, осиротевшие не остаются — `test/mcp-lifecycle.test.ts`
- [x] Значения binding'ов не попадают ни в одну поверхность — `test/mcp-lifecycle.test.ts`
- [x] Один capability handler на два транспорта (MCP ран + API control plane), отказ по scope одинаков — `test/capability-facade.test.ts`
- [x] Проба приёмки на песочной VM: 25/25 проверок, транскрипт `docs/evidence/p13-mcp-lifecycle-vm2/`

## Promotion и fleet acceptance (P29, этап I10)

Соответствует карточке [#68](https://github.com/trained-assist/trained-agent-architecture/issues/68) и этапу [SANDBOX · I10](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md#i10--promotion-совместимость-rueu). Детали — [docs/PROMOTION.md](docs/PROMOTION.md).

| Область | Файл | Что делает |
|---|---|---|
| Релиз | `src/release/manifest.ts` | Закреплённый релиз: `sourceCommit`, `configVersion`, host-манифест (workerId/region/environment/roles/roots/endpoint), env-манифест только по именам binding'ов, retention TTL. Без манифеста старт падает |
| Когорта | `src/release/cohort.ts` | `off` / `allowlist` / `percentage` с детерминированным бакетом: одно решение на любом воркере и после рестарта |
| Переходы | `src/release/promotion.ts` | Durable-журнал promotion/cohort/rollback/fencing/drain/retention с причиной каждого перехода; контроллер отката и возврата; `checkPromotionBoundary` — песочные артефакты нельзя объявить production |
| Владение | `src/release/dispatch-owner.ts` | Одна задача — один владелец на VM: общий файл под file-lock, partition ≠ failover, перехват только по явному сигналу, прежний владелец fenced, новая попытка = поколение +1 |
| Приём | `src/release/admission.ts` | Порядок отказов: откат → платный профиль → когорта → владение. Отказ видно по HTTP: 503 `PROMOTION_PAUSED`, 403 `COHORT_NOT_ENABLED` / `PAID_PROFILE_DISABLED`, 409 `TASK_OWNED_BY_OTHER_WORKER` |
| Приёмка | `scripts/recreate-sandbox.sh`, `scripts/promotion-probe.mjs` | Чистая песочница (новый namespace, свежие ключи, локальный fixture-репозиторий) и 12 шагов приёмки на двух настоящих процессах → sanitized-транскрипт + sha256 |

Ключевые семантики:

- **Откат — не рестарт задач.** Новые приёмы когорты останавливаются, обслуживает предыдущий
  релиз, а уже принятые раны доигрывает их прежний владелец; состояние готовится файлом и
  переживает рестарт процесса.
- **Платные профили выключены по умолчанию**: `paid.allowed` требует явного `approvedBy`,
  иначе 403 до запуска. В пробе работает только free-движок `fake`.
- **Правило 8 проверяется, а не декларируется**: попытка выдать песочный релиз за production
  отклоняется по workerId/корням/endpoint/ключам, ключи и данные живут только внутри
  namespace, транскрипт не содержит значений секретов.
- **Партиция ≠ failover**: перехват задачи требует явного сигнала прежнего владельца; сам
  молчающий воркер её не перехватывает.

### Что покрыто тестами

- [x] Контракты релиза, когорты, отката и реестра владельцев — `test/promotion-release.test.ts`
- [x] Внешний контракт поверх HTTP, включая два воркера на одной VM и откат прогоном — `test/promotion-api.test.ts`
- [x] Проба приёмки на песочной VM2: 59/59 проверок, транскрипт `docs/evidence/p29-promotion-vm2/`
- [x] Проба в CI на каждом PR: `.github/workflows/promotion-probe.yml`

## Multi-worker/region contract (P30, этап I10)

Соответствует карточке [#69](https://github.com/trained-assist/trained-agent-architecture/issues/69) и этапу [SANDBOX · I10](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md#i10--promotion-совместимость-rueu). Детали — [docs/MULTI-WORKER-REGION.md](docs/MULTI-WORKER-REGION.md).

| Область | Файл | Что делает |
|---|---|---|
| Размещение | `src/release/placement.ts` | Политика размещения fail-closed: движок × регион → explicit profile → провайдер модели → credential scopes → резидентность → `regionConstraints` рана. `screenWorkers` отбирает воркеров флота, `allowedEnginesForRegion` — список для повторной проверки Runner'ом |
| Приём | `src/release/admission.ts` | Порядок отказов: откат → **placement** → платный профиль → когорта → владение. Placement идёт перед paid-флагом: отказ «платно» маскировал бы нарушение региональной политики |
| Runner | `src/runner/runner.ts` | Повторная проверка региона движка по `host.allowedEngines` в preflight: `REGION_FORBIDDEN`, движок не запускается |
| Владение | `src/release/dispatch-owner.ts` | Перехват по явному сигналу оставляет запись без попытки; первый claim нового владельца принимает это поколение, а не увеличивает его |
| Приёмка | `scripts/recreate-sandbox.sh --regions … --placement …`, `scripts/p30-fleet-probe.mjs` | Два воркера одной VM в разных регионах, матрица размещения, drain, управляемый сбой и failover без двойного исполнения → sanitized-транскрипт + sha256 |

Ключевые семантики:

- **Claude/Codex не в RU; в EU — только с явным профилем.** Политика без `explicitProfileRef`
  отказывает с `REGION_EXPLICIT_PROFILE_REQUIRED`; профиль включается решением владельца, а не
  кодом (проба переключает его в конфиге и видит, как меняется отказ).
- **OpenCode — по провайдеру**: `free-ladder` разрешён в обеих зонах, `zen` только в EU
  (`PROVIDER_REGION_FORBIDDEN` в RU).
- **Резидентность данных не решается молча**: `dataResidency.decided: false` даёт 409
  `DATA_RESIDENCY_UNDECIDED`; симуляция песочницы не может объявить резидентность решённой
  (`authority: owner_decision` + ссылка на решение).
- **Нет двойного исполнения после failover**: partition ≠ failover, перехват только по явному
  сигналу, прежний владелец fenced, успешный результат ровно один на задачу.

### Что покрыто тестами

- [x] Политика размещения: валидация fail-closed, матрица регион × провайдер × credentials × резидентность — `test/placement-policy.test.ts`
- [x] Внешний контракт поверх HTTP на двух воркерах в разных регионах + failover без двойного исполнения — `test/placement-api.test.ts`
- [x] Проба приёмки на песочной VM2: 67/67 проверок, транскрипт `docs/evidence/p30-fleet-vm2/`
- [x] Проба в CI на каждом PR: `.github/workflows/p30-fleet-probe.yml`

## Agent clean room: граница рана и lifecycle (issue #51/#52)

Отдельный cwd — ещё не граница. Слот — эксклюзивно арендуемый Unix-пользователь пула
(`ta-agent-N`), а не процесс: он существует до рана и переиспользуется только после
проверенной очистки. Никакого нового управляющего сервиса и никакой VM на ран — граница
живёт на хосте Runner'а.

| Область | Файл | Что делает |
|---|---|---|
| Контракт | `src/isolation/contract.ts` | `CleanRoomProvider`: аренда слота, run-scoped каталоги, проба границы, sweep/release/reconcile, честная декларация `IsolationCapability` |
| Граница | `src/isolation/clean-room.ts` | Каталоги рана 0700 с владельцем-слотом, ACL для Runner'а, run-scoped HOME/config/cache/data/tmp, долговечная аренда `identity/leases/<runId>.json`, блокировка слота при неполной очистке |
| Переключение | `src/isolation/launcher.ts` | `setpriv --clear-groups` / `runuser`: меняется uid/gid И дополнительные группы — иначе дочерний процесс унаследовал бы права Runner'а |
| Проба | `src/isolation/probe/boundary-probe.mjs` | Отрицательные свойства ДО спавна движка: чужой ран, корень Runner'а и его credentials недоступны; свои HOME/tmp и общие read-only бинари доступны |
| Runner | `src/runner/runner.ts` | Стадия границы между materialize и MCP/спавном, fail-closed отказ до спавна, сверка uid процесса движка по `/proc`, дочистка аренды в `recover()` |
| Приёмка | `scripts/isolation-probe.mjs`, `.github/workflows/isolation-probe.yml` | Живые одновременные раны, матрица «свой/чужой», управляемые отказы и рестарт воркера → sanitized-транскрипт + sha256 |
| Конфиг движка | `src/isolation/engine-config.ts` | Хостовой read-only шаблон `<engine>.json` копируется в корень workspace рана (владелец — слот, `0600`) до старта движка: своя HOME рана убрала бы у движка provider/model, и `opencode` ушёл бы на платный профиль по умолчанию. Объявленный, но нечитаемый шаблон валит ран, а не оставляет движок без модели. В лог идут путь и sha256 копии, не содержимое |
| Возможности хоста | `src/isolation/host-capabilities.ts` | Только чтение: root, `setpriv`/`runuser`, `setfacl`, слоты в `passwd`. Непривилегированный хост честно SKIP-ает проверку, а не «проходит» её |

Ключевые семантики:

- **Fallback к service UID запрещён.** Нет `setpriv`/`runuser`, нет свободного слота, слот не
  на хосте или проба не прошла — ран отказывается ДО спавна движка (`ISOLATION_UNAVAILABLE`,
  `ISOLATION_SLOT_BUSY`, `ISOLATION_IDENTITY_UNAVAILABLE`, `ISOLATION_PROBE_FAILED`). То же и
  для запроса `isolation: per_run_unix_identity` на хосте без провайдера: требование клиента
  доходит до preflight, а не теряется по дороге.
- **Аренда переживает рестарт воркера** и снимается только после проверенного удаления
  каталогов рана; если выход остался единственной копией, аренда `blocked` и слот не
  переиспользуется — иначе следующий ран прочитал бы прежние данные.
- **Аренда ограничена во времени.** Движок запускается detached и переживает аварию воркера;
  после рестарта его гасит `recover()`, ран финализируется как `failed`/`WORKER_CRASH`
  (повторного запуска нет) и слот возвращается в пул. Без этого пул из двух слотов терялся бы
  навсегда после двух аварий.
- **Единственная копия важнее чистоты**: при отказе хранилища workspace не удаляется,
  `cleanup: pending`, причина — в логе рана и в аренде.
- **Возможности объявляются честно**: без настроенной границы `osIsolation =
  not_proven_service_uid_only`, с нерабочей настройкой — `configured_but_refusing_runs`.
- **Граница поднимается без root.** Каталоги среды создаются под служебным uid и только
  потом отдаются слоту: создать запись внутри уже отданного слота каталога может только
  root или `CAP_DAC_OVERRIDE`, и цена границы не должна быть обходом прав доступа. Юнит
  даёт ровно `CAP_SETUID`/`CAP_SETGID`/`CAP_CHOWN`/`CAP_FOWNER` — `DAC_OVERRIDE` в наборе
  нет. ACL persist/sweep выдаётся Runner'у на все каталоги рана, а не только на корень:
  persist пишет конфиг движка в `HOME/config` и читает выходы из cwd, sweep удаляет дерево.
- **Своя HOME рана не оставляет движок без модели.** Конфиг пользователя сервиса ран не
  видит — это и есть граница, — поэтому провайдера и модель кладёт хост: read-only шаблон в
  `AGENT_API_ENGINE_CONFIG_DIR`, копия — в корень workspace рана. Не в `XDG_CONFIG_HOME`:
  каталоги HOME рана принадлежат слоту, а `mkdir` с явным режимом маскирует унаследованный
  default ACL, поэтому каталог конфигурации внутри них остался бы недоступен Runner'у —
  и запись, и уборка. Ключ сюда не кладётся и не может: credential'ы приходят в окружение
  рана по `envAllowlist`, который собирает хост.

### Где живёт доказательство границы

Привилегированная проба **не гейт PR**: она требует root (`useradd`/`chown`/`setfacl`), а
обычный CI-раннер не может ни доказать, ни честно опровергнуть границу. Workflow запускается
вручную (`workflow_dispatch`), сам скрипт и workflow сначала детектят возможности и на
непривилегированном хосте пишут транскрипт со `status: skipped` — зелёный шаг «изоляция
проверена» там был бы доказательством от случайно выданных CI привилегий.

Доказательство берётся на привилегированной песочной VM и лежит в репозитории:
[`docs/evidence/p51-clean-room-vm2/`](docs/evidence/p51-clean-room-vm2/) — 81/81 проверок,
sha256 рядом. Воспроизведение (каждый прогон требует **нового** namespace, иначе
`blocked`-аренда предыдущего прогона занимает слот):

```bash
scripts/recreate-sandbox.sh --namespace iso-$(date -u +%Y%m%d-%H%M) \
  --fleet-root /var/lib/agent-runner --workers a --client-engines fake,opencode
node scripts/isolation-probe.mjs --fleet-root /var/lib/agent-runner \
  --namespace iso-... --out docs/evidence/p51-clean-room-vm2
```

Открытая строка приёмки: «два **настоящих** OpenCode Run одновременно». Бинарь `opencode` на
песочной VM есть; отсутствие провайдера/модели под run-scoped HOME закрыто хостовым
шаблоном конфигурации движка (`AGENT_API_ENGINE_CONFIG_DIR`, см. `src/isolation/engine-config.ts`),
а бесплатный движок `llm-ladder` сейчас не отвечает (`unknown ladder: free-ladder` — тем же
падает красный `probe`-job на `main`). Свойства OS-границы от движка не зависят и проверены
fake-движком.

### Что покрыто тестами

- [x] Слот, run-scoped HOME, движок и per-run MCP под идентичностью рана, сокет моста внутри среды — `test/clean-room-isolation.test.ts`
- [x] Поломанная граница и отсутствие слота отказывают до спавна, без расширения прав — `test/clean-room-isolation.test.ts`
- [x] Требование границы клиента доходит до рана; объявленные выходы доходят до экспорта — `test/clean-room-isolation.test.ts`
- [x] Закрытая (`released`) аренда возвращает слот; `active`/`blocked`/`sweeping` — нет — `test/clean-room-isolation.test.ts`
- [x] Аренда переживает рестарт воркера; блокировка слота дочекается sweep — `test/clean-room-isolation.test.ts`
- [x] Переживший воркер движок гасится восстановлением, слот возвращается, повторного запуска нет — `test/clean-room-isolation.test.ts`
- [x] Единственная копия выхода: `cleanup: pending`, слот заблокирован, после рестарта блокировка держится — `test/clean-room-isolation.test.ts`
- [x] Настоящая граница на привилегированном хосте (переключение uid) — `test/clean-room-isolation.test.ts`, блок `skipIf` с указанием причины на непривилегированном хосте
- [x] Конфиг движка в run-scoped HOME: копия 0600 от слота, sha256 в логе без содержимого, хостовый шаблон не меняется, сломанный шаблон валит ран до спавна — `test/engine-config-in-clean-room.test.ts`
- [x] Порядок владения каталогами: все каталоги среды создаются до передачи слоту (прав
  доступа в каталоге слота у непривилегированного Runner'а нет) — `test/clean-room-ownership-order.test.ts`
- [x] Проба приёмки на настоящем Linux-хосте: `docs/evidence/p51-clean-room-vm2` (81/81)

## Lifecycle рана: persist → проверенная уборка (#52)

Три статуса рана разделены, и каждый объяснён причиной — «почему не persisted» должно
читаться, а не угадываться:

| статус | смысл |
|---|---|
| `persistence: persisted` | каждый байт подтверждён **чтением** из долговечного хранилища (не «upload не вернул ошибку») |
| `persistence: failed` / `not_required` | ни один выход не сохранён (с причиной) / выходы не объявлялись |
| `cleanup: completed` | **проверенный контракт**: каталоги рана и его сокет сняты, идентичность освобождена. Отсутствие процессной группы таким контрактом не является и на статус не влияет |

Порядок lifecycle: ответ агента и объявленные выходы → экспорт → **намерение уборки на
диск** → sweep → терминальное событие. Намерение записывается до sweep, поэтому сбой в
момент уборки оставляет на диске ровно то, что нужно восстановлению; `recover()` повторяет
persist/sweep **без повторного запуска движка**, а отказ одного рана не роняет остальные.
Локальная копия несохранённого выхода держит каталог рана и слот — решение принимается по
факту наличия файла на диске, а не по флагу манифеста.

- [x] Persist подтверждён чтением; ошибка хранилища оставляет единственную копию, статус с причиной и рестарт, который её не стирает — `test/run-lifecycle.test.ts`
- [x] Сбой во время sweep переживает рестарт: уборка доводится один раз, байты сохранены, движок не перезапущен — `test/run-lifecycle.test.ts`, `test/clean-room-isolation.test.ts`
- [x] Отказ уборки одного рана не мешает восстановлению поднять API — `test/run-lifecycle.test.ts`
- [x] Cancel и timeout проходят тот же путь: движок погашен, каталоги сняты, статус честный — `test/run-lifecycle.test.ts`
- [x] Управляемый сбой в конкретный момент задаётся `AGENT_API_FAULTS` (формат и отказ при разборе — `test/fault-env.test.ts`)
- [x] Настоящая приёмка на привилегированной песочной VM2: [`docs/evidence/p52-lifecycle-vm2/`](docs/evidence/p52-lifecycle-vm2/) — 115/115 проверок, sha256 рядом

Проба на VM2 — не формальность: она нашла три дефекта, невидимые в тестах на одном
процессе (падение `recover()` от отказа уборки; потеря ссылки на байты при повторном
экспорте; незакрытая аренда идентичности после рестарта воркера), и все три исправлены.


## Разработка

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc -p tsconfig.build.json → dist/   (запуск сервиса: npm start)
```

Требования: Node 20+, npm. CI (`.github/workflows/ci.yml`) гоняет `npm ci` + typecheck + test на каждый push/PR.

Библиотека + внешний network-API: локальный adapter на VM (ARCHITECTURE §3) и Serverless Agent API выше — оба в этом репозитории; storage/артефакты есть (Slice D1), следующий этап — materialize/sweep и artifact transfer.

Минимальный запуск API (ключи — sha256-hashes в файле реестра, сам plaintext-ключ вне репозитория и логов):

```ts
import { AgentApi, createAgentApiServer, KeyRegistry, generateApiKey, hashApiKey, FakeEngine } from 'ai-agent-runner';

const key = generateApiKey();                       // показать клиенту один раз
const keys = KeyRegistry.fromRecords([
  { keyHash: hashApiKey(key), principalId: 'p-demo', profileId: 'profile-demo', scopes: ['runs:read', 'runs:write'], engines: ['fake'] },
]);
const api = new AgentApi({ rootDir: './data', adapters: { fake: new FakeEngine() } });
await api.recover();                                 // рестарт: runner.recover + admission heal
createAgentApiServer(api, { keys }).listen(8080);
```

```bash
curl -X POST localhost:8080/v1/runs \
  -H "Authorization: Bearer $KEY" -H 'Idempotency-Key: demo-1' -H 'Content-Type: application/json' \
  -d '{"engine":{"name":"fake","adapterVersion":"1"},"limits":{"timeoutMs":5000},"input":{"inlinePrompt":"hi"}}'
# → 202 {"requestId","userTaskId","runId"}; повтор того же запроса → 200 тот же receipt
```

## Roadmap

1. **Slice 1 (сделано)** — контракты RunSpec/события/результат, fake adapter, lifecycle state machine, scoped logs, fault injection, CI.
2. **Serverless Agent API P04–P06 (сделано)** — admission/result adapter на node:http: auth/keys, idempotent receipt, status/cancel/result/events + SSE replay, durable store и recovery API-сессии на одной VM.
3. **Storage/materialize** (детализация D1–D6 в [issue #17](https://github.com/trained-assist/trained-agent-architecture/issues/17)): **D1 сделан** — BlobStore-контракт, бэкенды local-fs/GCS/R2-заготовка, manifest+commit/export, share-by-link (см. «Slice D1»); остаётся materialize при старте, sweep в finalizing, маркер индекса, lease+generation на профиль.
4. **Live OpenCode на sandbox VM** — reproducible setup (P01/P02), free-only профиль, два synthetic principals, sanitized transcript приёмки.
5. **Artifact transfer P07–P09** — manifest/export и выдача ссылок есть (D1); остаётся direct signed upload/download-сессии, multipart/resume и реализация R2/S3-бэкенда (I02B).
6. **MCP lifecycle + scoped bindings (P13, сделано)** — per-run stdio процессы, handshake/readiness/timeout/cleanup, общий capability handler на MCP и API facade; дальше — доменные tools (P14) и интеграционная песочница (P15).
6. **Worker API и межмашинные leases/fencing** — при переходе к нескольким workers (ARCHITECTURE §9, пп. 5–6).
7. **Интеграция с GitHub** — текстовой образ профиля выгружается в приватные репозитории `profiles-artifacts` ([trained-assist-agent#1921](https://github.com/trained-assist/trained-assist-agent/issues/1921)); **не в этом slice**, только roadmap-строка — решение за владельцем (PR #13 arch-репо, открытый вопрос §8.3).
8. **Внешний OpenCode-воркер** — запуск opencode-рана по запросу нашего API из отдельного репозитория; ТЗ и контракты — [docs/TZ-EXTERNAL-OPENCODE-WORKER.md](docs/TZ-EXTERNAL-OPENCODE-WORKER.md).

Отложено из P04–P06 (вне этого этапа): callback delivery, квоты/конкурентность по principals (caps), `awaiting_user` durable prompt+response, multi-VM admission — контракты местами зарезервированы, реализация следует за control plane.

## Правила репозитория

- Секреты, адреса машин и токены в репозиторий не попадают — только имена переменных и binding refs ([SANDBOX.md](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md)).
- Spec в журналах и state-файлах проходит валидацию с запретом неизвестных полей; stdout красится redaction'ом перед записью в events.
- Core остаётся владельцем задачи; Runner хранит только локальные записи Run (ARCHITECTURE §3).
