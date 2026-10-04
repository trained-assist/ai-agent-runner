# ТЗ: внешний OpenCode-воркер (запуск opencode-рана по запросу нашего API)

**Для:** агента в внешнем репозитории, который будет запускать opencode-раны по запросу
нашего Serverless Agent API и подключаться как опция движка (`engine.name`).

**Статус:** черновик для передачи во внешний репозиторий.

---

## 1. Цель

Наш API (`ai-agent-runner`, Serverless Agent API) умеет запускать раны через движки
(`fake`, `opencode`). Нужен **внешний воркер** в отдельном репозитории, который:

1. Принимает запрос от нашего API (HTTP).
2. Запускает opencode-ран в своём окружении.
3. Возвращает результат в формате, который наш API уже умеет принимать.

Воркер подключается как **новая опция движка** — регистрируется в `engines` нашего API,
клиент выбирает её в `POST /v1/runs` через `engine.name`.

## 2. Роль в системе

```
Клиент
  │  POST /v1/runs  { engine: { name: "external-opencode", adapterVersion: "1" }, … }
  ▼
Наш Serverless Agent API (ai-agent-runner)
  │  ExternalOpenCodeAdapter.start(ctx)  ← новый адаптер, вызывает воркер по HTTP
  │  POST {воркер}/v1/launch  { RunSpec }
  ▼
Внешний OpenCode-воркер (этот ТЗ)
  │  spawn opencode, захват stdout/stderr/exit
  │  POST {воркер}/v1/launch → { LaunchResult }
  ▼
Наш API маппит LaunchResult → RunResult + RunnerEvent, дальше обычный lifecycle
```

**Разделение ответственности:**

| Сторона | Ответственность |
|---|---|
| Наш API | lifecycle рана, идемпотентность, события (sequence/replay), артефакты, persistence, cleanup, auth, изоляция (per_run_unix_identity) |
| Внешний воркер | запуск opencode, захват вывода, таймаут, возврат результата |

Воркер **не** должен знать про наши артефакты, persistence, cleanup и идемпотентность —
это делает наш API. Воркер отвечает только за «запустил opencode и вернул результат».

## 3. Контракт запроса (наш API → воркер)

### 3.1. Эндпоинт

```
POST {WORKER_URL}/v1/launch
Content-Type: application/json
Authorization: Bearer {WORKER_TOKEN}     ← общий секрет, выдаётся нашему API
```

### 3.2. Тело запроса — `LaunchRequest`

```jsonc
{
  // === Идентификация рана (наш API генерирует, воркер не валидирует) ===
  "runId": "run_0fdd061d-14c3-42ea-b182-9393ff3564fa",
  "jobId": "job-…",
  "userTaskId": "task_…",
  "profileId": "profile-…",
  "conversationId": "conv-…",
  "operationId": "op-…",
  "ownerGeneration": 1,

  // === Движок ===
  "engine": {
    "name": "external-opencode",
    "adapterVersion": "1",
    "modelSettings": { "model": "free", "temperature": 0.2 }
  },

  // === Вход ===
  "input": {
    "inlinePrompt": "Сделай задачу …"    // всегда непусто (наш API гарантирует)
  },

  // === Окружение запуска ===
  "cwd": "/abs/path/to/workspace",        // абсолютный путь, куда воркер клонировал репозиторий
  "envAllowlist": ["PATH", "HOME", "NODE_ENV"],  // только эти имена попадают в env процесса
  "env": {                                // значения для envAllowlist (наш API собирает)
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": "/home/runner"
  },

  // === Лимиты ===
  "limits": {
    "timeoutMs": 300000,                  // воркер обязан убить процесс по истечении
    "maxOutputBytes": 1048576,            //  cap на суммарный stdout+stderr
    "maxLogBytes": 1048576
  },

  // === Репозиторий (уже склонирован нашим API, воркер НЕ клонирует) ===
  "repository": {
    "fullName": "owner/name"
    // token сюда не приходит — клонирование делает наш API
  },

  // === Изоляция (наш API решает, воркер исполняет) ===
  "isolation": { "mode": "per_run_unix_identity" },

  // === Объявленные выходы (наш API заберёт после завершения) ===
  "outputs": [
    { "path": "report.md", "name": "report.md", "mime": "text/markdown" }
  ],

  // === Манифест агента (опционально, ищется в cwd после выхода) ===
  // .agent/final-manifest.json — наш API читает сам, воркер не обязан
}
```

### 3.3. Обязательные поля запроса

`runId`, `input.inlinePrompt`, `cwd`, `envAllowlist`, `limits.timeoutMs` — всегда присутствуют.
Остальные — опциональны, но если присутствуют, воркер обязан их учесть.

## 4. Контракт ответа (воркер → наш API)

### 4.1. Успешный запуск (HTTP 200)

```jsonc
{
  "runId": "run_0fdd061d-…",              // эхо запроса
  "status": "started",                    // started | failed
  "pid": 12345,                           // pid процесса opencode (для отладки)

  // === Заполняется при status="started", обновляется по мере выполнения ===
  // Воркер может возвращать промежуточные результаты через отдельный эндпоинт
  // (см. §4.3) или только финальный — тогда поля ниже заполняются в /v1/result.

  // === Финальный результат (заполняется всегда, даже при failed) ===
  "exitCode": 0,                          // number | null (null если убит по сигналу/таймауту)
  "exitSignal": null,                     // string | null
  "exitReason": "completed",               // см. §4.4
  "stdout": "…",                          // полный stdout (обрезан до maxOutputBytes)
  "stderr": "…",                          // полный stderr (обрезан до maxOutputBytes)
  "answer": "…",                          // текст ответа агента (если удалось извлечь)
  "answerSource": "engine_stdout",        // engine_stdout | agent_file | null
  "durationMs": 45230,                    // фактическая длительность рана
  "timedOut": false,                      // true если убит по limits.timeoutMs
  "killedByTimeout": false
}
```

### 4.2. Немедленный отказ (HTTP 4xx/5xx, процесс не запускался)

```jsonc
{
  "runId": "run_0fdd061d-…",
  "status": "failed",
  "exitReason": "startup_failure",        // startup_failure | preflight_refused
  "failure": {
    "code": "OPENCODE_BINARY_MISSING",     // машиночитаемый код
    "failureClass": "engine",             // preflight | engine | runtime | finalization
    "safeSummary": "opencode binary not found at /usr/local/bin/opencode",
    "retryable": false
  }
}
```

Коды отказов (воркер выбирает подходящий):

| Код | Когда | retryable |
|---|---|---|
| `OPENCODE_BINARY_MISSING` | бинарь opencode не найден | false |
| `OPENCODE_STARTUP_FAILED` | процесс стартовал, но сразу упал (< 2s) | true |
| `OPENCODE_TIMEOUT` | убит по `limits.timeoutMs` | true |
| `OPENCODE_CRASH` | упал с сигналом (не по таймауту) | true |
| `OPENCODE_OUTPUT_TRUNCATED` | превышен `maxOutputBytes` | false |
| `WORKER_INTERNAL` | внутренняя ошибка воркера | true |

### 4.3. Потоковые события (опционально, рекомендуется)

Если воркер хочет отдавать события в реальном времени (для `log`-событий нашего API),
он может зарегистрировать callback при запуске:

```jsonc
// В LaunchRequest (опциональное поле):
"callback": {
  "url": "https://our-api.internal/v1/runs/{runId}/events",  // наш API принимает события
  "token": "…"                                               // одноразовый токен на ран
}
```

Формат события — `RunnerEvent` (schemaVersion 1), как в нашем API. Если callback не
передан — воркер возвращает только финальный результат, наш API сгенерирует `log`-события
из `stdout`/`stderr`.

### 4.4. `exitReason` (согласованно с нашим `RunResult`)

| exitReason | Когда |
|---|---|
| `completed` | процесс завершился с exit code 0 |
| `nonzero_exit` | процесс завершился с exit code ≠ 0 |
| `startup_failure` | процесс не смог стартовать |
| `timeout` | убит по `limits.timeoutMs` |
| `crash` | убит сигналом (не таймаут) |
| `cancelled` | наш API запросил отмену (см. §6) |

## 5. Требования к запуску opencode

### 5.1. Команда

```bash
opencode run "<prompt>"
```

- Бинарь: `opencode` (ищется в `PATH`, либо явный путь из конфига воркера).
- Аргументы: `run`, затем `input.inlinePrompt` как один аргумент.
- Дополнительные флаги (модель и т.д.) — из конфига воркера, не из запроса.

### 5.2. Окружение процесса

- `cwd` = `LaunchRequest.cwd` (абсолютный путь, репозиторий уже склонирован нашим API).
- `env` = только переменные из `envAllowlist`, значения из `LaunchRequest.env`.
  Воркер **не** должен передавать свои секреты, токены и переменные хоста в процесс.
- `detached: true` (новая процессная группа), `stdio: pipe`.

### 5.3. Таймаут

- Воркер обязан убить процесс (и его дерево) по истечении `limits.timeoutMs`.
- Убийство — `SIGTERM`, через 5s — `SIGKILL`.
- При таймауте: `exitReason: "timeout"`, `timedOut: true`, `killedByTimeout: true`.

### 5.4. Изоляция

- Если `isolation.mode = "per_run_unix_identity"` — воркер запускает opencode под
  Unix-идентичностью рана (setpriv/runuser), а не под service UID воркера.
- Воркер обязан поддержать это, если хочет получать запросы с таким режимом.
- Если воркер не поддерживает изоляцию — он отказывает с `failureClass: "preflight"`,
  код `ISOLATION_UNSUPPORTED`, наш API не будет отправлять ему такие раны.

### 5.5. Захват вывода

- `stdout` и `stderr` захватываются порционно, суммарно ограничиваются `maxOutputBytes`.
- При превышении — хвост сохраняется, в ответе флаг `outputTruncated: true`.
- Вывод **не** должен попадать в логи воркера в открытом виде, если он может содержать
  секреты (наш API применяет redaction, но воркер не должен логировать построчно).

## 6. Отмена рана

Наш API может запросить отмену:

```
POST {WORKER_URL}/v1/runs/{runId}/cancel
Authorization: Bearer {WORKER_TOKEN}
```

Воркер обязан:

1. Найти процесс по `runId`.
2. Послать `SIGTERM` дереву процессов, через 5s — `SIGKILL`.
3. Вернуть `{ "runId": "…", "status": "cancelled" }`.

Если процесс уже завершился — вернуть текущий статус (идемпотентно).

## 7. Артефакты и выходы

- Воркер **не** загружает артефакты и **не** пишет в storage — это делает наш API.
- Воркер только оставляет файлы в `cwd` (workspace рана).
- Наш API после завершения прочитает:
  - `outputs` — объявленные клиентом пути (проверка на выход из workspace).
  - `.agent/final-manifest.json` — финальный манифест агента (если opencode его создал).
  - `answer.txt` — текст ответа (из манифеста или хвоста stdout).
- Воркер может вернуть `answer` и `answerSource` в ответе, чтобы наш API не искал.

## 8. Идемпотентность и состояния

- Воркер не обязан хранить состояние между запросами — наш API хранит `admissions`,
  `events`, `result`.
- Повторный `POST /v1/launch` с тем же `runId` — воркер может вернуть текущий статус
  или отказать с `409 RUN_ALREADY_ACTIVE` (наш API обработает).
- Воркер должен быть stateless относительно рана: весь контекст приходит в запросе.

## 9. Ограничения и отказы (честно)

- Воркер не знает про наши артефакты, persistence, cleanup, идемпотентность — только
  запускает и возвращает результат.
- Воркер не клонирует репозиторий — клонирование делает наш API.
- Воркер не передаёт токены и секреты в процесс opencode.
- Воркер обязан убить процесс по таймауту и по отмене.
- Воркер обязан поддержать `per_run_unix_identity`, если хочет получать изолированные раны.

## 10. Приёмка (чеклист для внешнего агента)

- [ ] `POST /v1/launch` принимает `LaunchRequest`, запускает `opencode run "<prompt>"` в `cwd`.
- [ ] Процесс стартует под идентичностью рана (per_run_unix_identity), не под service UID.
- [ ] `env` процесса = только `envAllowlist`, без секретов хоста.
- [ ] Таймаут: процесс убивается по `limits.timeoutMs`, `exitReason: "timeout"`.
- [ ] Отмена: `POST /v1/runs/{runId}/cancel` убивает дерево, возвращает `cancelled`.
- [ ] Ответ содержит `exitCode`, `exitReason`, `stdout`, `stderr`, `answer`, `durationMs`.
- [ ] При отсутствии бинаря — `OPENCODE_BINARY_MISSING`, `retryable: false`.
- [ ] При превышении `maxOutputBytes` — хвост сохраняется, флаг `outputTruncated`.
- [ ] Секреты и токены не попадают в логи воркера и в процесс.
- [ ] Воркер stateless: повторный запрос с тем же `runId` не ломит состояние.
- [ ] Наш API может зарегистрировать воркер как `engine.name = "external-opencode"` и
      получить полный цикл submit → events → result → artifacts.

## 11. Интеграция с нашим API (что делаем мы)

1. Новый адаптер `ExternalOpenCodeAdapter implements EngineAdapter`:
   - `name = "external-opencode"`.
   - `start(ctx)` → `POST {WORKER_URL}/v1/launch` с `LaunchRequest` (маппинг из `RunSpec`).
   - Потоковые события из воркера → `ctx.onLog`.
   - Финальный `LaunchResult` → `ctx.onExit` + `RunResult`.
2. Регистрация в `engines` нашего API: `["fake", "opencode", "external-opencode"]`.
3. Конфиг воркера: `EXTERNAL_OPENCODE_URL`, `EXTERNAL_OPENCODE_TOKEN` (env).
4. Тесты: `test/external-opencode-adapter.test.ts` — мок воркера, проверка маппинга.

## 12. Ссылки на контракты (в нашем репозитории)

| Контракт | Файл |
|---|---|
| `RunSpec` (contractVersion 1) | `src/contracts/run-spec.ts` |
| `RunnerEvent` (schemaVersion 1) | `src/contracts/events.ts` |
| `RunResult` (schemaVersion 1) | `src/contracts/result.ts` |
| `EngineAdapter` / `EngineStartContext` / `EngineHandle` | `src/adapters/engine/engine-adapter.ts` |
| Пример адаптера (локальный opencode) | `src/adapters/engine/opencode-adapter.ts` |
| Приёмка запроса (submit) | `src/api/contracts.ts` |
| Маршруты API | `src/api/server.ts` |
| Деплой на VM (не CI) | `docs/API-SERVICE.md` |
| Лимиты CI | `docs/GITHUB-ACTIONS-CAPABILITY.md` |
