# ТЗ: внешний воркер `dynamic-ip-azure-agent-run`

> **Superseded runtime topology.** This document is historical. The Runner API now runs as
> a Cloudflare Worker and the France VM is only an execution worker. Control Plane calls
> its configured Cloudflare Runner API HTTPS endpoint (`RUNNER_API_URL` in the current CP
> sandbox); it does not call this VM directly. See
> [CLOUDFLARE-RUNNER-API.md](CLOUDFLARE-RUNNER-API.md).

**Для:** внешней команды (отдельный репозиторий). Воркер запускает opencode-раны по запросу
нашего API.

**Имя движка:** `dynamic-ip-azure-agent-run` (Azure VM, динамический IP).

> **Актуальность контракта.** Канонический контракт `LaunchRequest`/`LaunchResult` —
> [issue #73](https://github.com/trained-assist/ai-agent-runner/issues/73). Расхождения с ним
> в этом документе (в первую очередь §8 «Артефакты») помечены как устаревшие: воркер **сам**
> коммитит артефакты в репозиторий юзера и грузит лог сессии в Google Storage, а наше API
> возвращает ссылки и байт не хранит.
>
> Решение владельца от 04.10.2026: артефакты публикует **воркер**, наше API в их публикации
> не участвует. Схема «воркер оставил файлы в `cwd`, наш API их забирает и публикует» отклонена.

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

  // Репозиторий и ветка рана: воркер клонирует и работает в этой ветке (§8.1)
  "repository": { "fullName": "owner/name", "branch": "agent-run/run_0fdd061d-…" },

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
4. **Ветка рана:** создать `repository.branch`, коммитить в неё, запушить её (§8.1). Не
   коммитить в ветку по умолчанию. Креды на push — свои, из секретов воркера.
5. **Отмена:** `POST {worker}/v1/runs/{runId}/cancel` → убить дерево, вернуть `cancelled`.
6. **Изоляция:** если `isolation.mode = "per_run_unix_identity"` — запускать opencode под
   Unix-идентичностью рана (setpriv/runuser), не под service UID. Если не поддерживаете —
   отказывайте с `ISOLATION_UNSUPPORTED`, `failureClass: "preflight"`.
7. **Вывод:** stdout/stderr захватываются, ограничиваются `maxOutputBytes`, при
   превышении сохраняется хвост + флаг `outputTruncated`.
8. **Логи:** секреты и токены не логируются в открытом виде. Лог сессии загружается в GCS,
   возвращается `logUrl`.
9. **Stateless:** повторный запрос с тем же `runId` не ломит состояние.
10. **Артефакты:** коммитит `outputs` в ветку `repository.branch`, пушит её и возвращает
    `artifacts[]` + `repo` (issue #73, §8.1).

## 8. Артефакты

**Решено (владелец, 04.10.2026): коммитит воркер.** Агент во время сессии пишет нужное ему
в свой рабочий каталог; этот каталог — эфемерный, он живёт на машине воркера и умирает вместе
с ней, поэтому держать результат там нельзя. Долговечно попадает **объявленное клиентом в
`outputs`**, и единственное место, которое его принимает, — репозиторий самого юзера.

### 8.1 Каждый ран — своя ветка

Результат рана кладётся не в ветку по умолчанию, а в **отдельную ветку рана**: клон → ветка →
всё дальше в ветке. Имя ветки задаёт наше API, поле `repository.branch` в `LaunchRequest`.

Почему так: результат рана — это предложение изменения, а не готовое состояние ветки. В ветке
видно ровно то, что сделал агент, её можно открыть в PR, отрецензировать, откатить одним
движением и смержить одним действием. Прямой коммит в ветку по умолчанию этого не даёт: правки
смешиваются с чужой работой, их не отличить от чужих, а откат — только revert-ом чужого коммита.

| Что | Кто | Значение |
|---|---|---|
| Имя ветки | наше API | `agent-run/<runId>` — уникально и трассируемо до рана, не конфликтует с ветками юзера |
| База | воркер | ветка, от которой ответвляется ран (по умолчанию — дефолтная ветка репозитория) |
| Коммит | воркер | `outputs` коммитятся в ветку рана |
| Пуш | воркер | ветка пушится в `repository.fullName` |
| Merge | человек или control plane | наше API **не мержит**: оно строит ссылку `compare/<base>...<branch>` и отдаёт её клиенту |

Механика:

1. Воркер клонирует `repository.fullName` в `cwd`, создаёт ветку `repository.branch`.
2. Агент работает в `cwd` (то есть в этой ветке) и пишет объявленные `outputs`.
3. Воркер коммитит `outputs` в ветку рана и пушит её.
4. Воркер возвращает в `LaunchResult` `artifacts[]` (`path`/`name`/`mime`/`sha256`/`size`),
   `repo: {fullName, branch, commit, baseRef}` и `logUrl` на лог сессии в Google Storage.
5. Наше API ничего не читает с диска воркера и не хранит байт — оно адресует то, что вернули:
   `https://github.com/<owner>/<name>/blob/<commit>/<path>` (файл на коммите),
   `.../tree/<branch>` (ветка целиком) и `.../compare/<baseRef>...<branch>` (куда мержить).

**Требование к воркеру: у него должны быть креды на push в репозиторий юзера.**

Изначально предполагалось, что это постоянные креды самого воркера (deploy key или GitHub
App), и клиентский `repository.token` наружу не уходит. На живом запуске 05.10.2026 это
оказалось неверно: воркер запускается в чужом репозитории (кольцо), и его собственные креды
не имеют прав на репозиторий задачи. Из 16 запусков артефакты легли в 1, остальные ушли
как `completed artifacts=0` — агент отработал, а результат положить было нечем.

Поэтому `repository.token` передаётся воркеру в поле `publicationToken` запроса. Оно
приходит в claim-ответе, а не в `inputs` диспатча: `workflow_dispatch` публичного
репозитория показывает inputs в метаданных прогона и в логах, то есть секрет в inputs —
утечка в мир. Клиенту токен не возвращается ни в квитанции, ни в статусе, ни в событиях,
ни в логи процесса, и не попадает в журнал приёма на диск.

Требование к контракту: `artifacts[]` и `repo` обязательны, даже если список пуст (тогда это
значит «объявленных выходов не было», а не «воркер не смог»); `repo.branch` обязателен, без него
клиент не сможет найти результат.

**Почему не «забирает наш API».** Наш API stateless: у него нет ни диска, ни сетевого доступа
к машине воркера — она эфемерная и может быть уже убита. Схема с забором `cwd` потребовала бы
либо вернуть воркеру статус «мы забираем», либо держать воркер живым до вычитки, и то и другое
ломает «после рана VM можно убить». Публикация через `WorkspaceService` в нашем API отклонена
по той же причине — это путь в durable-хранилище, которого у оркестратора нет.

## 9. Приёмка (чеклист)

- [ ] `POST /v1/launch` принимает `LaunchRequest`, запускает `opencode run "<prompt>"` в `cwd`.
- [ ] env процесса = только `envAllowlist`, без секретов.
- [ ] Таймаут: процесс убивается, `exitReason: "timeout"`.
- [ ] Отмена: `POST /v1/runs/{runId}/cancel` убивает дерево, возвращает `cancelled`.
- [ ] Ответ: `exitCode`, `exitReason`, `stdout`, `stderr`, `answer`, `durationMs`.
- [ ] Бинарь не найден → `OPENCODE_BINARY_MISSING`, `retryable: false`.
- [ ] Изоляция `per_run_unix_identity` поддержана (или отказ `ISOLATION_UNSUPPORTED`).
- [ ] Ветка рана создана, `outputs` закоммичены в неё, ветка запушена в `repository.fullName`.
- [ ] В ответе `repo.branch` — та самая ветка, `repo.commit` — её HEAD, `repo.baseRef` — база.
- [ ] У воркера есть креды на push в репозиторий юзера (проверено пробным ран'ом).
- [ ] Секреты не в логах и не в процессе.
- [ ] Эндпоинт регистрируется в нашем API (Вариант А) или есть стабильный DNS (Вариант Б).
- [ ] Наш API регистрирует движок как `dynamic-ip-azure-agent-run` и получает полный цикл
      submit → events → result → artifacts (ссылки на коммит, ветку и merge).

## 10. Что делаем мы (агент в этом репо) — сделано в #74

1. `ExternalWorkerAdapter` в `src/adapters/external-worker-adapter.ts`:
   - `name = "dynamic-ip-azure-agent-run"`;
   - `launch(spec)` → `POST {endpoint}/v1/launch` с `LaunchRequest` (маппинг из `RunSpec`,
     включая имя ветки рана `agent-run/<runId>`);
   - `LaunchResult` → `RunResult` + `RunnerEvent[]`;
   - `cancel(runId)` → `POST {endpoint}/v1/runs/{runId}/cancel`.
2. Эндпоинт и токен приходят из конфига: `EXTERNAL_WORKER_URL`/`EXTERNAL_WORKER_TOKEN`
   (принимаются и `DYNAMIC_IP_AZURE_*` из ранней редакции ТЗ, `EXTERNAL_WORKER_*` приоритетнее).
3. `engines` = `["dynamic-ip-azure-agent-run"]` — единственный, больше никаких локальных движков.
4. Тесты: `test/external-worker-adapter.test.ts` (контракт и маппинг) и
   `test/e2e-loop.test.ts` (полный цикл с мок-воркером, включая разные ветки у параллельных ранов).

## 11. Контракты в нашем репозитории

| Контракт | Файл |
|---|---|
| `RunSpec` | `src/contracts/run-spec.ts` |
| `RunnerEvent` | `src/contracts/events.ts` |
| `RunResult` | `src/contracts/result.ts` |
| `LaunchRequest` / `LaunchResult` | `src/adapters/external-worker-adapter.ts` |
| Ветка рана и ссылки на результат | `runBranchName`, `artifactUrl`, `branchUrl`, `mergeUrl` там же |
| Маршруты API | `src/api/server.ts` |
| Деплой на VM | `docs/API-SERVICE.md` |
