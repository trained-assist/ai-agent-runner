# AI Agent Runner

Статус: **slice 1 реализован** · 01.10.2026. Код жизненного цикла Run появился в этом репозитории; storage/materialize, Serverless API и межмашинные leases ещё не вынесены (см. roadmap).

**Agent Runner** управляет запуском **ai-agent-job** на выбранной виртуальной машине: готовит **Agent clean room**, запускает агентский движок с разрешёнными правами, наблюдает выполнение, сохраняет результат и освобождает ресурсы.

Диспетчер платформы выбирает машину и регион. Runner на этой машине исполняет согласованное описание запуска. Скрипт запуска — внутренний, версионируемый adapter движка; его недостаточно для всего жизненного цикла.

- [Draft архитектуры](ARCHITECTURE.md): границы, контракты, изоляция, восстановление и этапы выделения.
- [Общая архитектура платформы](https://github.com/trained-assist/trained-agent-architecture): пользовательские сценарии и межсервисные контракты.
- [Терминология](https://github.com/trained-assist/trained-agent-architecture/blob/main/TERMINOLOGY.md): Job, Run и типы заданий.
- [Observability-контракт](https://github.com/trained-assist/trained-agent-architecture/blob/main/OBSERVABILITY-AND-ERROR-CONTRACT.md): формат structured events.
- Эпик выделения: [trained-agent-architecture#17](https://github.com/trained-assist/trained-agent-architecture/issues/17) (E1, карточки P01–P03).

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

## Разработка

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Требования: Node 20+, npm. CI (`.github/workflows/ci.yml`) гоняет `npm ci` + typecheck + test на каждый push/PR.

Библиотека пока без network-API: первый вариант — локальная библиотека с adapter на VM (ARCHITECTURE §3). Serverless API будет отдельным этапом.

## Roadmap

1. **Slice 1 (сделано)** — контракты RunSpec/события/результат, fake adapter, lifecycle state machine, scoped logs, fault injection, CI.
2. **Slice 2 — storage/materialize** (детализация D1–D6 в [issue #17](https://github.com/trained-assist/trained-agent-architecture/issues/17)): BlobStore-контракт, materialize при старте, sweep в finalizing, маркер индекса, lease+generation на профиль.
3. **Live OpenCode на sandbox VM** — reproducible setup (P01/P02), free-only профиль, два synthetic principals, sanitized transcript приёмки.
4. **External Serverless Agent API** — admission/result adapter этого репо, идемпотентные операции, cancel, статусы.
5. **Worker API и межмашинные leases/fencing** — при переходе к нескольким workers (ARCHITECTURE §9, пп. 5–6).

## Правила репозитория

- Секреты, адреса машин и токены в репозиторий не попадают — только имена переменных и binding refs ([SANDBOX.md](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md)).
- Spec в журналах и state-файлах проходит валидацию с запретом неизвестных полей; stdout красится redaction'ом перед записью в events.
- Core остаётся владельцем задачи; Runner хранит только локальные записи Run (ARCHITECTURE §3).
