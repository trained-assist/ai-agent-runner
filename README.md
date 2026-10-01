# AI Agent Runner

Статус: **slice 1 + Serverless Agent API (P04–P06) + slice D1 (storage/артефакты) + E2E acceptance loop (issue #2) реализованы** · 01.10.2026. Код жизненного цикла Run, внешний admission/result adapter, storage-контракт с менеджментом артефактов и цикл приёмки владельца есть в этом репозитории; materialize/sweep и межмашинные leases ещё не вынесены (см. roadmap).

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
| HTTP | `src/api/server.ts` | `POST /v1/runs`, `GET /v1/runs/{id}/status`, `POST .../cancel`, `GET .../result`, `GET .../events` (+`/healthz`); структурированные ошибки `{error:{code,message,details}}`; body cap 413; логи запросов без заголовков и ключей |
| SSE replay | `src/api/server.ts` | `GET .../events` с `Accept: text/event-stream`: snapshot + `id/event/data`, cursor из `?cursor` или `Last-Event-ID`, keepalive, завершение потока на терминальном событии |

Ключевые семантики:

- **Receipt значит «принято», а не «запущено»** (AC-65): успешный ответ202/200 возвращает receipt; запуск агента наблюдается через status/events.
- **Idempotency**: повтор submit с тем же ключом и payload → тот же receipt и ноль вторых запусков — до и после рестарта процесса (P06); другой payload с тем же ключом → `IDEMPOTENCY_CONFLICT`.
- **`connection_lost` ≠ `failed`** (AC-66): потеря связи — отдельное поле `connectionLost` в status; состояние остаётся последним наблюдённым; result отвечает `RESULT_NOT_READY`.
- **Cancel ≠ stopped** (AC-67): `stop_pending` (HTTP 202) отличается от `stopped`; stale `ownerGeneration` → 409 `STALE_OWNER_GENERATION` без изменения статуса (fencing slice-1).
- **Recovery API-сессии** (P06): после рестарта клиент дочитывает status/events/receipt без rerun; orphan помечается `connection_lost`, погибший worker — `failed` c `WORKER_CRASH`; ни один путь не запускает вторую копию.
- `awaiting_user` входит в контракт состояний, но standalone adapter его не производит (durable prompt+response — control plane, P12).

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

## E2E acceptance loop (issue #2)

Замкнутый цикл приёмки: submit/идемпотентность → events stream/replay → fault injection → recovery после kill -9 (+ reboot по флагу) → security-пробы → артефакт через API → креды со скоупами. Каждый шаг — PASS/FAIL с reproduction, результат — JSON-отчёт, провал — готовый черновик issue.

```bash
npm ci                 # devDependencies (typescript/vitest)
./scripts/e2e-loop.sh  # либо node scripts/e2e-loop.mjs --help
# → ./e2e-loop-report.json, exit 0 = все шаги зелёные
```

Драйвер сам компилирует `src/` в `.e2e-dist/` (package.json/lock не меняются), поднимает дочерний API-сервер и работает только через его HTTP-контракт. Дефолтный прогон — детерминированный и free-only (fake-движки); `--with-reboot` (только root) и `--with-opencode` включаются явно. Провал шага: `node scripts/e2e-loop.mjs --root <data> --only <step-id>`.

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

## Разработка

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest run
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
6. **Worker API и межмашинные leases/fencing** — при переходе к нескольким workers (ARCHITECTURE §9, пп. 5–6).
7. **Интеграция с GitHub** — текстовой образ профиля выгружается в приватные репозитории `profiles-artifacts` ([trained-assist-agent#1921](https://github.com/trained-assist/trained-assist-agent/issues/1921)); **не в этом slice**, только roadmap-строка — решение за владельцем (PR #13 arch-репо, открытый вопрос §8.3).

Отложено из P04–P06 (вне этого этапа): callback delivery, квоты/конкурентность по principals (caps), `awaiting_user` durable prompt+response, multi-VM admission — контракты местами зарезервированы, реализация следует за control plane.

## Правила репозитория

- Секреты, адреса машин и токены в репозиторий не попадают — только имена переменных и binding refs ([SANDBOX.md](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md)).
- Spec в журналах и state-файлах проходит валидацию с запретом неизвестных полей; stdout красится redaction'ом перед записью в events.
- Core остаётся владельцем задачи; Runner хранит только локальные записи Run (ARCHITECTURE §3).
