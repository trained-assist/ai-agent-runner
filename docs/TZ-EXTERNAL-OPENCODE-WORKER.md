# ТЗ: внешний воркер `dynamic-ip-azure-agent-run`

**Для:** внешней команды (отдельный репозиторий). Воркер запускает opencode-раны по запросу
нашего API.

**Имя движка:** `dynamic-ip-azure-agent-run` (Azure VM, динамический IP).

> **Актуальность контракта.** Канонический контракт `LaunchRequest`/`LaunchResult` —
> [issue #73](https://github.com/trained-assist/ai-agent-runner/issues/73). Расхождения с ним
> в этом документе (в первую очередь §8 «Артефакты») помечены как устаревшие: воркер **сам**
> коммитит артефакты в репозиторий юзера и грузит лог сессии в Google Storage, а наше API
> возвращает ссылки и байт не хранит.

---

## 1. Где что живёт

| Компонент | Где | Примечание |
|---|---|---|
| **Наш API** (`ai-agent-runner`) | VM, systemd, `169.58.15.230:8787` | НЕ Cloudflare. Cloudflare Worker `trained-assist-control-plane` — это резолвер секретов (токены GitHub), не раннер |
| **Внешний воркер** (этот ТЗ) | Azure VM, динамический IP | Строит внешняя команда |
| **Клиент** | Любой, кто дёргает `POST /v1/runs` | Выбирает движок через `engine.name` |

## 2. Кто что строит

| Сторона | Строит |
|---|---|
| **Внешняя команда** | Воркер: HTTP-эндпоинт, запуск opencode, возврат результата |
| **Мы (агент в этом репо)** | `DynamicIpAzureAdapter` — адаптер в нашем API, который дёргает воркер |

Направление вызовов: **наш API → воркер**. Воркер не знает про наш API, он просто
принимает запрос и возвращает результат.

## 3. Как подключаемся

```
Клиент
  │  POST /v1/runs  { "engine": { "name": "dynamic-ip-azure-agent-run", "adapterVersion": "1" }, … }
  ▼
Наш API (VM, 169.58.15.230:8787)
  │  DynamicIpAzureAdapter.start(ctx)
  │  POST {worker-endpoint}/v1/launch  { LaunchRequest }
  ▼
Внешний воркер (Azure, динамический IP)
  │  spawn opencode → захват stdout/stderr/exit
  │  → { LaunchResult }
  ▼
Наш API маппит LaunchResult → RunResult + RunnerEvent → обычный lifecycle
```

**Наш API владеет:** lifecycle, идемпотентность, события, артефакты, persistence,
cleanup, auth, изоляция.

**Воркер владеет:** запуск opencode, захват вывода, таймаут, возврат результата.
Воркер **stateless** — весь контекст приходит в запросе.

## 4. Динамический IP

IP воркера меняется. Наш API должен знать текущий эндпоинт. Два варианта (выбрать один):

### Вариант А (рекомендуется): воркер регистрирует эндпоинт

```
POST {наш API}/v1/engines/dynamic-ip-azure-agent-run/endpoint
{ "url": "https://<new-ip>:8080", "token": "<shared-secret>" }
```

- Воркер вызывает этот эндпоинт при старте и при смене IP.
- Наш API хранит последний известный эндпоинт.
- Если эндпоинт не зарегистрирован — наш API отказывает с `WORKER_UNREACHABLE`.

### Вариант Б: стабильный DNS

- Воркер имеет DNS-имя (например, `worker.example.com`), IP за ним динамический.
- Наш API резолвит DNS при каждом запуске.
- Регистрация не нужна.

**ТЗ не привязывается к варианту** — адаптер нашего API принимает эндпоинт из конфига
(`DYNAMIC_IP_AZURE_URL`), а как он обновляется — решает внешняя команда.

## 5. Контракт запроса (наш API → воркер)

### 5.1. Эндпоинт

```
POST {worker-endpoint}/v1/launch
Content-Type: application/json
Authorization: Bearer {WORKER_TOKEN}
```

### 5.2. Тело — `LaunchRequest`

```jsonc
{
  // Идентификация рана (наш API генерирует)
  "runId": "run_0fdd061d-…",
  "jobId": "job-…",
  "userTaskId": "task_…",
  "profileId": "profile-…",
  "conversationId": "conv-…",
  "operationId": "op-…",
  "ownerGeneration": 1,

  // Движок
  "engine": {
    "name": "dynamic-ip-azure-agent-run",
    "adapterVersion": "1",
    "modelSettings": { "model": "free" }
  },

  // Вход (всегда непусто)
  "input": {
    "inlinePrompt": "Сделай задачу …"
  },

  // Окружение запуска
  "cwd": "/abs/path/to/workspace",           // репозиторий уже склонирован нашим API
  "envAllowlist": ["PATH", "HOME", "NODE_ENV"],
  "env": {                                   // значения для envAllowlist
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": "/home/runner"
  },

  // Лимиты
  "limits": {
    "timeoutMs": 300000,                     // воркер обязан убить процесс по истечении
    "maxOutputBytes": 1048576,              // cap на stdout+stderr
    "maxLogBytes": 1048576
  },

  // Репозиторий (уже склонирован, воркер НЕ клонирует)
  "repository": { "fullName": "owner/name" },

  // Изоляция
  "isolation": { "mode": "per_run_unix_identity" },

  // Объявленные выходы (наш API заберёт после завершения)
  "outputs": [
    { "path": "report.md", "name": "report.md", "mime": "text/markdown" }
  ]
}
```

**Обязательные поля:** `runId`, `input.inlinePrompt`, `cwd`, `envAllowlist`,
`limits.timeoutMs`. Остальные опциональны, но если присутствуют — воркер обязан учесть.

## 6. Контракт ответа (воркер → наш API)

### 6.1. Успех (HTTP 200)

```jsonc
{
  "runId": "run_0fdd061d-…",                 // эхо
  "status": "started",                       // started | failed
  "pid": 12345,

  // Финальный результат (заполняется всегда)
  "exitCode": 0,                             // number | null
  "exitSignal": null,                        // string | null
  "exitReason": "completed",                  // см. таблицу ниже
  "stdout": "…",                             // обрезан до maxOutputBytes
  "stderr": "…",
  "answer": "…",                             // текст ответа агента (если извлёк)
  "answerSource": "engine_stdout",           // engine_stdout | agent_file | null
  "durationMs": 45230,
  "timedOut": false,
  "outputTruncated": false,
  "logUrl": "https://storage.googleapis.com/<bucket>/runs/<runId>/session.log"
}
```

**Воркер НЕ возвращает артефакты и repo** — артефакты публикует наш API через
`WorkspaceService.publishRunChanges` (модуль `src/workspace/`, уже реализован).
Воркер только оставляет файлы в `cwd`, а наш API после завершения публикует их в GitHub.

### 6.2. Немедленный отказ (процесс не запускался)

```jsonc
{
  "runId": "run_0fdd061d-…",
  "status": "failed",
  "exitReason": "startup_failure",
  "failure": {
    "code": "OPENCODE_BINARY_MISSING",
    "failureClass": "engine",                // preflight | engine | runtime | finalization
    "safeSummary": "opencode binary not found",
    "retryable": false
  }
}
```

### 6.3. `exitReason`

| exitReason | Когда |
|---|---|
| `completed` | exit code 0 |
| `nonzero_exit` | exit code ≠ 0 |
| `startup_failure` | процесс не смог стартовать |
| `timeout` | убит по `limits.timeoutMs` |
| `crash` | убит сигналом (не таймаут) |
| `cancelled` | наш API запросил отмену |

### 6.4. Коды отказов

| Код | Когда | retryable |
|---|---|---|
| `OPENCODE_BINARY_MISSING` | бинарь не найден | false |
| `OPENCODE_STARTUP_FAILED` | стартовал, сразу упал (< 2s) | true |
| `OPENCODE_TIMEOUT` | убит по таймауту | true |
| `OPENCODE_CRASH` | убит сигналом | true |
| `OPENCODE_OUTPUT_TRUNCATED` | превышен `maxOutputBytes` | false |
| `WORKER_INTERNAL` | внутренняя ошибка воркера | true |

## 7. Требования к воркеру

1. **Команда:** `opencode run "<prompt>"`, `cwd` = `LaunchRequest.cwd`.
2. **env процесса:** только переменные из `envAllowlist`, значения из `env`. Секреты
   хоста и токены в процесс не передаются.
3. **Таймаут:** убить дерево процессов по `limits.timeoutMs` (SIGTERM → через 5s SIGKILL).
4. **Отмена:** `POST {worker}/v1/runs/{runId}/cancel` → убить дерево, вернуть `cancelled`.
5. **Изоляция:** если `isolation.mode = "per_run_unix_identity"` — запускать opencode под
   Unix-идентичностью рана (setpriv/runuser), не под service UID. Если не поддерживаете —
   отказывайте с `ISOLATION_UNSUPPORTED`, `failureClass: "preflight"`.
6. **Вывод:** stdout/stderr захватываются, ограничиваются `maxOutputBytes`, при
   превышении сохраняется хвост + флаг `outputTruncated`.
7. **Логи:** секреты и токены не логируются в открытом виде. Лог сессии загружается в GCS,
   возвращается `logUrl`.
8. **Stateless:** повторный запрос с тем же `runId` не ломит состояние.
9. **Артефакты:** коммитит в `repository.fullName` и возвращает `artifacts[]` + `repo` (issue #73).

## 8. Артефакты

**Устарело.** Актуальная версия — issue #73: воркер **сам** складывает `outputs` в репозиторий
`repository.fullName` и возвращает в `LaunchResult` список `artifacts[]` (`path`/`name`/`mime`/
`sha256`/`size`) вместе с `repo: {fullName, commit}` и `logUrl` на лог сессии в Google Storage.
Наше API не читает `cwd` и не хранит байты — оно адресует то, что вернул воркер
(`https://github.com/<owner>/<name>/blob/<commit>/<path>` и `logUrl`).

Прежняя схема (воркер оставляет файлы в `cwd`, наш API публикует их через
`WorkspaceService.publishRunChanges`) требует от нашего API доступа к диску воркера и потому
в stateless-модели невозможна.

## 9. Приёмка (чеклист)

- [ ] `POST /v1/launch` принимает `LaunchRequest`, запускает `opencode run "<prompt>"` в `cwd`.
- [ ] env процесса = только `envAllowlist`, без секретов.
- [ ] Таймаут: процесс убивается, `exitReason: "timeout"`.
- [ ] Отмена: `POST /v1/runs/{runId}/cancel` убивает дерево, возвращает `cancelled`.
- [ ] Ответ: `exitCode`, `exitReason`, `stdout`, `stderr`, `answer`, `durationMs`.
- [ ] Бинарь не найден → `OPENCODE_BINARY_MISSING`, `retryable: false`.
- [ ] Изоляция `per_run_unix_identity` поддержана (или отказ `ISOLATION_UNSUPPORTED`).
- [ ] Секреты не в логах и не в процессе.
- [ ] Эндпоинт регистрируется в нашем API (Вариант А) или есть стабильный DNS (Вариант Б).
- [ ] Наш API регистрирует движок как `dynamic-ip-azure-agent-run` и получает полный цикл
      submit → events → result → artifacts.

## 10. Что делаем мы (агент в этом репо)

1. `DynamicIpAzureAdapter implements EngineAdapter`:
   - `name = "dynamic-ip-azure-agent-run"`.
   - `start(ctx)` → `POST {endpoint}/v1/launch` с `LaunchRequest` (маппинг из `RunSpec`).
   - `LaunchResult` → `ctx.onExit` + `RunResult`.
2. Эндпоинт воркера приходит из конфига: `DYNAMIC_IP_AZURE_URL`, `DYNAMIC_IP_AZURE_TOKEN`.
3. Регистрация в `engines`: `["fake", "opencode", "dynamic-ip-azure-agent-run"]`.
4. Тесты: `test/dynamic-ip-azure-adapter.test.ts` — мок воркера, проверка маппинга.

## 11. Контракты в нашем репозитории

| Контракт | Файл |
|---|---|
| `RunSpec` | `src/contracts/run-spec.ts` |
| `RunnerEvent` | `src/contracts/events.ts` |
| `RunResult` | `src/contracts/result.ts` |
| `EngineAdapter` | `src/adapters/engine/engine-adapter.ts` |
| Пример адаптера | `src/adapters/engine/opencode-adapter.ts` |
| Маршруты API | `src/api/server.ts` |
| Деплой на VM | `docs/API-SERVICE.md` |
