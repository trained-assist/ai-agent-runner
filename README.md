# AI Agent Runner

Статус: **slice 1 + Serverless Agent API (P04–P06) реализованы** · 01.10.2026. Код жизненного цикла Run и внешний admission/result adapter для одной VM есть в этом репозитории; storage/materialize, artifact transfer и межмашинные leases ещё не вынесены (см. roadmap).

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

## Разработка

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Требования: Node 20+, npm. CI (`.github/workflows/ci.yml`) гоняет `npm ci` + typecheck + test на каждый push/PR.

Библиотека + внешний network-API: локальный adapter на VM (ARCHITECTURE §3) и Serverless Agent API выше — оба в этом репозитории; следующий этап — storage/materialize и artifacts.

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
3. **Slice 3 — storage/materialize** (детализация D1–D6 в [issue #17](https://github.com/trained-assist/trained-agent-architecture/issues/17)): BlobStore-контракт, materialize при старте, sweep в finalizing, маркер индекса, lease+generation на профиль.
4. **Live OpenCode на sandbox VM** — reproducible setup (P01/P02), free-only профиль, два synthetic principals, sanitized transcript приёмки.
5. **Artifact transfer P07–P09** — manifest/export, direct signed upload/download (I02B).
6. **Worker API и межмашинные leases/fencing** — при переходе к нескольким workers (ARCHITECTURE §9, пп. 5–6).

Отложено из P04–P06 (вне этого этапа): callback delivery, квоты/конкурентность по principals (caps), `awaiting_user` durable prompt+response, multi-VM admission — контракты местами зарезервированы, реализация следует за control plane.

## Правила репозитория

- Секреты, адреса машин и токены в репозиторий не попадают — только имена переменных и binding refs ([SANDBOX.md](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md)).
- Spec в журналах и state-файлах проходит валидацию с запретом неизвестных полей; stdout красится redaction'ом перед записью в events.
- Core остаётся владельцем задачи; Runner хранит только локальные записи Run (ARCHITECTURE §3).
