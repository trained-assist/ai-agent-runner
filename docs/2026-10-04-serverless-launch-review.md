# Ревью: запуск агента во внешнем serverless-воркере

**Дата:** 2026-10-04
**Ветка ревью:** `feat/async-launch-contract` (HEAD `7c18b50` + незакоммиченные правки)
**Контракт:** `docs/EXTERNAL-WORKER-CONTRACT.md` (смержен в main через PR #80)
**ТЗ:** `docs/TZ-EXTERNAL-OPENCODE-WORKER.md`, `docs/SERVERLESS-API-REWORK.md`

## 0. Главное первым

**Ветка не компилируется и не проходит тесты. Приёмка в текущем виде невозможна.**

```
$ npx tsc --noEmit
src/adapters/external-worker-adapter.ts(37,13): error TS2300: Duplicate identifier 'WorkerRunStatus'
src/adapters/external-worker-adapter.ts(786,37): error TS2339: Property 'baseUrlForResult' does not exist on type 'ExternalWorkerOptions'
src/adapters/external-worker-adapter.ts(789,9): error TS2416: Property 'launch' ... is not assignable to ... 'ExternalWorker'
src/adapters/external-worker-adapter.ts(931,12): error TS2304: Cannot find name 'timingSafeEqual'
src/adapters/external-worker-adapter.ts(956,37): error TS2304: Cannot find name 'CANCEL_DELIVERY_RETRIES'
src/api/service.ts(584,58): error TS2339: Property 'resultGraceMs' does not exist on type 'AgentApi'
src/api/service.ts(589,19): error TS2304: Cannot find name 'WorkerRunStatus'
... (всего 10+ ошибок)

$ npx vitest run
Test Files  3 failed | 39 passed (42)
     Tests  5 failed | 481 passed | 3 skipped (489)
```

Причина: асинхронный контракт (receipt/status/result) реализован **наполовину и не полностью закоммичен**.
Потребительская сторона закоммичена (`src/api/service.ts:543-617` — `execute()`, `pollUntilTerminal()`,
`collectResult()`), а сторона адаптеры лежит в незакоммиченных правках
(`git status`: `src/adapters/external-worker-adapter.ts`, `test/api-http-harness.ts`,
`test/external-worker-harness.ts`). В HEAD адаптер до сих пор отдаёт `LaunchResult` из `launch()`
(`git show HEAD:src/adapters/external-worker-adapter.ts:713`), тогда как `service.ts` ждёт `LaunchReceipt`.

Падающие тесты:

| Тест | Причина |
|---|---|
| `test/e2e-loop.test.ts:145` «статически: обслуживающий путь ничего не пишет на диск» | `src/api/stateless-store.ts:1` и `src/api/main.ts:44` пишут на диск (журнал приёмных записей) — см. §2.2 |
| `test/external-worker-adapter.test.ts:413` (таймаут launch) | ждёт `WORKER_LAUNCH_TIMEOUT`, получает `WORKER_LAUNCH_UNREACHABLE` |
| `test/external-worker-adapter.test.ts` (ответ вне контракта) | ждёт `WORKER_HTTP_ERROR`, получает `RESULT_URL_UNSET` |
| `test/api-service.test.ts:215` (отмена обгоняет регистрацию) | `stop_pending` ≠ `rejected` — поллер/мок рассинхронизированы |
| `test/api-service.test.ts:294` (реестр движков) | ран не доходит до `succeeded` |

Отдельно: `test/zz-dbg.test.ts` (untracked) — отладочный файл, не должен попадать в коммит.

## 1. Что соответствует контракту

| # | Пункт контракта | Статус | Где |
|---|---|---|---|
| 1 | `POST /v1/launch` возвращает квитанцию, не результат | **выполнено** (в незакоммиченных правках) | `LaunchReceipt` — `src/adapters/external-worker-adapter.ts:116-122`; `launch()` отдаёт квитанцию — `:789-845`; валидация `:361-371`. API не держит соединение: `void this.execute(record)` — `src/api/service.ts:242` |
| 2 | Дедупликация по ключу переживает рестарт API | **наполовину** | Журнал приёмных записей: `src/api/stateless-store.ts:101-135` (`append`/`replay`), включение — `src/api/main.ts:41`. Но: (а) конфиг читается не откуда надо (§2.2), (б) теста нет (§2.2), (в) после рестарта ран не восстановим (§2.1) |
| 3 | status и result — разные контракты; unknown ≠ failed | **выполнено** | `unknown` в перечне состояний — `src/api/contracts.ts:28-43`; пометка — `src/api/service.ts:652-658`; декларация — `src/api/service.ts:428` (`disconnect.outcomeUnknown: true`). Воркерная сторона: `WorkerRunStatus` — `src/adapters/external-worker-adapter.ts:34-37`, `status()` `:852-871`, `result()` с 409 → `ResultNotReadyError` `:874-899` |
| 4 | Timeout после dispatch = unknown, затем reconcile | **наполовину** | Бюджет исчерпан → `markUnknown` + бесконечный reconcile-опрос — `src/api/service.ts:607-613`. Но таймаут **до** приёма (launch) → сразу `failed` без reconcile — `src/api/service.ts:568-571` (§3.2). `cancelOrphan` из контракта не реализован вовсе |
| 5 | Два назначения repository не смешивать | **наполовину** | Ветка рана `agent-run/<runId>` генерируется API — `src/adapters/external-worker-adapter.ts:70-72`; API не мержит, отдаёт ссылку `compare/...` — `:292-296`, `src/api/service.ts:339-363`. Но мерж ветки рана в profile workspace (`publishRunBranch`, `origin/main:src/workspace/service.ts:910`) **не вызывается ниоткуда** — только тесты (§2.4) |
| 6 | Тяжёлые выходы — object storage со scoped доступом, не git | **не выполнено** | Артефакты коммитятся в git и адресуются как `https://github.com/<owner>/<repo>/blob/<commit>/<path>` — `src/adapters/external-worker-adapter.ts:279-281`. Контракт прямо предупреждает, что blob URL из private repo не гарантирует скачивания нашим клиентом. Object storage и scoped-доступа нет ни в одной ветке |
| 7 | Изоляция воркера объявляется и верифицируется отдельно от host | **наполовину** | Хост честно объявляет `isolation.mode: "none"` — `src/api/service.ts:489-496`, воркерная изоляция вынесена в заметку — `:486-488`; требование клиента передаётся воркеру — `src/adapters/external-worker-adapter.ts:354`. «Верифицируется» — только на стороне воркего (ТЗ §7.6), API проверить этого не может и не пытается |
| 8 | Живые события и архив лога — разные контракты | **выполнено** (на стороне API) | Cursor-replay событий — `src/api/service.ts:305-333`; лог — только ссылка, байты не отдаются — `src/api/server.ts:128-136` (302 на `logUrl`); `cleanup: 'completed'` — `src/adapters/external-worker-adapter.ts:569-570`. Приватность GCS и порядок teardown — на стороне воркера (вне этого репо) |

## 2. Расхождения

### 2.1. Дедупликация переживает рестарт — но ран после рестарта не восстановим (критично)

Механика на месте: `StatelessStore` дописывает приёмные записи в построчный JSON и при старте
переигрывает его (`src/api/stateless-store.ts:101-135`). Повторный submit с тем же
`Idempotency-Key` после рестарта вернёт тот же `runId`, не запуская заново
(`src/api/service.ts:148-167`). Это соответствует п. 2 контракта.

**Но восстановление запуска не происходит.** Журнал содержит только приёмные записи
(`AdmissionRecord`), а `RunProgress` (состояние рана, события, результат) не персистится —
`replay()` вызывает лишь `index()` (`src/api/stateless-store.ts:113-135`). Поллер
запускается только из `submit()` (`src/api/service.ts:242`); после рестарта для
восстановленной записи поллера нет. Следствия:

- `status()` для такого рана навсегда отдаёт `state: 'queued', sequence: 0`
  (`src/api/service.ts:257-275`) — хотя на воркере ран может идти или даже завершиться;
- `result()` вечно бросает `RESULT_NOT_READY` (`src/api/service.ts:292-303`);
- клиент не может ни прочитать ответ, ни узнать исход — единственный выход для него
  повторить submit с **новым** ключом, и тогда проверка `TASK_ATTEMPT_ACTIVE`
  (`src/api/service.ts:189-198`) не сработает (прогресс не восстановлен), будет создан
  **второй ран** с новым `runId` и новым `operationId` — ровно тот дефект, который
  контракт обязан исключать.

Тест на это свойство **отсутствует**: коммит `7c18b50` («дедупликация запуска переживает
рестарт API») не добавил ни одного теста; единственные тесты дедупа — in-memory
(`test/api-http.test.ts:97`, `test/api-service.test.ts:80`). Тест
`test/e2e-loop.test.ts:185-202` кодирует **старое** поведение («рестарт забывает ран,
клиент повторяет с новым ключом») и противоречит новому контракту.

### 2.2. Журнал приёмных записей недостижим через свой env-флаг и ломает критерий «без диска» (критично)

`AGENT_API_ADMISSION_LOG` читается так:

```ts
// src/api/main.ts:41
const admissionLogPath = admissionLogFile(config.env['AGENT_API_ADMISSION_LOG']);
```

`config.env` — это **пул переменных для воркера** (`AGENT_API_ENV`, JSON-объект,
`src/api/config.ts:107-125,168`), а не `process.env`. Чтобы включить журнал, оператору
придётся положить `AGENT_API_ADMISSION_LOG` внутрь `AGENT_API_ENV` — и тогда значение
утечёт воркеру при каждом ране с таким `envAllowlist`. Как хостовая настройка API флаг
не работает: в реальном деплое дедупликация переживает рестарт **только в памяти процесса**,
т.е. не переживает его вовсе.

Тот же журнал ломает принятый критерий «API не пишет на диск»: статическая проверка
`test/e2e-loop.test.ts:145-183` теперь падает на `src/api/stateless-store.ts:1`
(`appendFileSync`) и `src/api/main.ts:44` (`mkdirSync`). Т.е. фича дедупликации и критерий
stateless-переработки находятся в прямом противоречии, и это не зафиксировано нигде.

### 2.3. `operationId` генерируется заново при каждом submit — дедупликация воркера бессмысленна

`buildSpec` создаёт `operationId: newApiId('op')` при каждом новом запуске
(`src/api/service.ts:704`). Контракт п. 2 возлагает дедупликацию на воркер по `operationId`,
но свежесгенерированный `operationId` воркер никогда не видел — после рестарта API и повтора
с новым ключом воркер обязан запустить второй ран. Идентификатор попытки должен выводиться
из стабильного ключа (`userTaskId` + `generation`, как это уже делает control-plane —
`trained-assist-control-plane/src/runner-adapter/runner-api-adapter.ts:264-273`).

### 2.4. Мерж ветки рана в profile workspace не подключён ни к одному потоку

`publishRunBranch` (проверка ветки в remote, merge-base, CAS-мерж) реализован на main
(`origin/main:src/workspace/service.ts:910`) и имеет **ноль продакшн-вызовов** — только
тесты (`origin/main:test/workspace-service.test.ts:1045`). Stateless-путь
(`src/api/service.ts`) `WorkspaceService` не вызывает вовсе. Следствие: п. 5 контракта
(«следующий Run читает накопленное состояние») не выполняется — каждый ран клонирует
профиль от дефолтной ветки, в которой изменений предыдущих ранов нет (они лежат в
неслитых `agent-run/*`). Ссылка `mergeUrl` отдаётся клиенту, но никто её не выполняет.

### 2.5. Таймаут launch = failed без reconcile (нарушение п. 4)

Контракт п. 4: таймаут ожидания ответа воркера **не означает**, что ран не запущен —
сначала `unknown`, затем запрос `status` существующего запуска. Реализация таймаут
ожидания квитанции (10 мин по умолчанию, `src/adapters/external-worker-adapter.ts:43`)
трактует как транспортный отказ и сразу финализирует ран как `failed`
(`src/api/service.ts:568-571` → `workerTransportFailure`, `:710-762`), ни разу не спросив
`worker.status()`. Комментарий в коде («Ран не принят — никто его не выполняет»,
`src/adapters/external-worker-adapter.ts:822-824`) неверен именно для случая таймаута:
запрос мог дойти, агент мог стартовать, а ответ потеряться. Окно второго рена здесь —
ручной повтор клиента, который контракт обязан исключать.

### 2.6. Маршрут возврата результата (`resultUrl`) объявлен, но не существует

`LaunchRequest.resultUrl` заполняется (`src/adapters/external-worker-adapter.ts:98-102,353`),
адаптер умеет его выставлять (`setResultBaseUrl`, `:919-921`) и сверять токен
(`matchesToken`, `:924-932`) — но **вызывать их некому**: в `src/api/server.ts` нет маршрута
`/v1/worker/launches/{runId}/result` (единственный гейт — `segments[1] === 'runs'`,
`src/api/server.ts:77-79`), поэтому любой воркер, следующий PR #78, получит на свой
callback `ROUTE_NOT_FOUND`. Результат забирается только опросом (`pollUntilTerminal` →
`worker.result()`, `src/api/service.ts:591,623`). Два механизма доставки результата
(опрос и callback) существуют параллельно, callback — мёртвый код. Мок-воркер в тестах
(`autoDeliver`, `test/external-worker-harness.ts:111-116,185-220`) постит результат в
несуществующий маршрут — отсюда `DELIVER FAILED fetch failed` в выводе тестов.

### 2.7. Константы поллера не определены — горячий цикл

`pollUntilTerminal` использует `this.resultGraceMs` (`src/api/service.ts:584`) и
`POLL_MAX_DELAY_MS`/`POLL_BASE_DELAY_MS` (`:662`) — ни одно из этих имён не определено
(ошибки TS2304/TS2339). В рантайме это `NaN`-дедлайн (бюджет не срабатывает никогда) и
`setTimeout(..., NaN)` ≈ 1 мс — поллер молотит `status` воркера без паузы, пока ран не
станет терминальным. Плюс `store.append` вызывается как публичный, но объявлен
`private` (`src/api/stateless-store.ts:210`, вызов `src/api/service.ts:549`).

### 2.8. Control-plane не готов к новым состояниям и маршрутам

- `awaitRunnerResult` считает терминальными только `succeeded|failed|cancelled`
  (`trained-assist-control-plane/src/runner-adapter/await-runner-result.ts:89`): состояние
  `unknown` не обрабатывается — попытка доработает до `runner_timeout` (120 с) и
  завершится как таймаут, хотя контракт требует «unknown ≠ failed, следующий шаг —
  reconcile». Reconcile-пути в control-plane нет.
- `connectionLost` из `RunStatusView` API никогда не выставляется в `true`
  (в новом API поле только читается — `src/api/service.ts:284`; выставлял его удалённый
  старый раннер, `src/runner/runner.ts:873,1580`). Ветка `markConnectionLost` в
  control-plane (`await-runner-result.ts:84-87`) — мёртвый код.
- Байтовый прокси артефактов `GET /v1/artifacts/{id}` и `/v1/artifacts/{id}/meta`
  (`runner-api-adapter.ts:225-242`, живой вызов `src/index.ts:893`) завязан на маршруты,
  которых в serverless API нет — ответ `ROUTE_NOT_FOUND`, скачивание артефактов сломано.
- Форма `GET /v1/runs/{id}/artifacts` изменилась: control-plane ждёт
  `{artifacts: [{artifactId, storageKey, ...}]}` (`runner-api-adapter.ts:216-219`),
  новый API отдаёт `{artifacts: [{path, name, mime, sha256, size, url}], repo, branchUrl,
  mergeUrl, ...}` (`src/api/service.ts:339-363`). Дедуп по `storageKey || artifactId`
  превращается в ключ `"undefined"` (`await-runner-result.ts:143-144`).
- `toSubmitRequest` не передаёт `isolation` (`run-spec.ts:162-177`) → в `LaunchRequest`
  уходит `mode: 'none'` по умолчанию (`src/adapters/external-worker-adapter.ts:354`) —
  per-run unix identity запрашивается только явным требованием клиента, а клиент его
  никогда не шлёт. OS-изоляция по умолчанию молча теряется.
- Тест `test/control-plane-compat.test.ts:22` кодирует старую семантику «P06 outcome
  unknown при потере воркера → failed», противоречащую п. 3 контракта.

## 3. Критические риски

1. **Окно второго рена после рестарта API** (§2.1 + §2.3): повтор с новым ключом → новый
   `runId`/`operationId` → второй агент на воркере при живом первом. Проверка
   `TASK_ATTEMPT_ACTIVE` не работает после рестарта, потому что прогресс рана не
   персистится. Единственное, что сейчас это закрывает — дисциплина клиента
   (control-plane использует стабильный ключ, `runner-api-adapter.ts:264-273`), а не API.
2. **Окно второго рена при таймауте launch** (§2.5): ран финализируется `failed`, хотя
   агент может выполняться; повтор клиента запустит второго.
3. **Потеря результата после рестарта** (§2.1): ран, принятый до рестарта, навсегда
   застревает в `queued`; контракт требует «после рестарта API нет второго запуска,
   пользователь читает ответ и артефакт» — вторая половина не выполняется.
4. **Утечка поллеров и исчерпание лимита**: `unknown` не терминальное
   (`src/api/contracts.ts:76-80`), поллер опрашивает воркер бесконечно
   (`src/api/service.ts:607-613`), каждый такой ран вечно занимает слот из
   `maxActiveRuns = 200` (`src/api/stateless-store.ts:69-74`) → после серии мёртвых
   воркеров API отказывает всем в `WORKER_DRAINING` (`src/api/service.ts:235-239`).
5. **Горячий цикл опроса** (§2.7): с неопределёнными константами поллер бьёт в `status`
   каждые ~1 мс — само-DoS на воркере; после определения констант риск снимается, но
   сейчас это бомба замедленного действия в незакоммиченном коде.
6. **Недостижимый конфиг журнала** (§2.2): дедупликация переживает рестарт только если
   оператор положит путь в `AGENT_API_ENV` (и заодно утечёт воркеру). Фактически фича
   выключена.
7. **Сломанный потребитель** (§2.8): control-plane теряет скачивание артефактов, видит
   `unknown` как таймаут, а дедупликация артефактов ломается на новой форме ответа.

## 4. Потеря связи: что происходит на каждом разрыве

| Сценарий | Поведение | Оценка |
|---|---|---|
| API жив, `status` воркера недоступен | `status()` бросает → `unknown` → `markUnknown` → продолжаем спрашивать (`src/api/service.ts:590-606`) | соответствует п. 4 (reconcile без нового submit) |
| API жив, бюджет исчерпан | `markUnknown` + бесконечный reconcile (`:607-613`) | соответствует; но поллер живёт вечно (риск 4) |
| API жив, воркер сообщил терминал, но результата нет (409) | `markUnknown` (`:637-641`) | честно: не выдаём успех за неподтверждённый |
| API жив, **таймаут ожидания квитанции** | сразу `failed`, без reconcile (`:568-571`) | **нарушение п. 4** (§2.5) |
| **Рестарт API, ран в полёте** | запись восстановлена, прогресс нет → `queued` навсегда; поллера нет | **потеря результата** (§2.1) |
| Рестарт API + повтор с тем же ключом | тот же `runId`, без второго запуска (`:148-167`) | соответствует п. 2, но читать ответ нечего (§2.1) |
| Рестарт API + повтор с новым ключом | второй ран, новый `operationId` | **окно второго рена** (§2.1, §2.3) |
| Воркер умер навсегда | бесконечный опрос с потолком паузы; ран в `unknown` вечно | утечка поллера (риск 4) |

## 5. Persist до teardown

На стороне API среды нет — ей владеет воркер, и гарантия «branch/байты/журнал сохранены до
уничтожения среды» делегиована контракту воркера (ТЗ §7.4, §8.1: пуш ветки до ответа).
Что проверяет наш API:

- `LaunchResult` обязан нести `artifacts[]`, `repo.branch`, `repo.commit`, `logUrl`
  (валидация: `src/adapters/external-worker-adapter.ts:417-444`) — без них ран не
  финализируется. Это контрактная проверка, а не сверка с remote: API **не проверяет**, что
  `repo.commit` реально существует в репозитории юзера. Воркер, солгавший о пуше, получит
  успешный ран с мёртвыми ссылками. Единственное место, где есть настоящая сверка с
  remote, — `publishRunBranch` (`origin/main:src/workspace/service.ts:910-930`:
  `candidateRefCommit` бросает `WORKSPACE_NOT_FOUND`, если ветки нет в remote), но он не
  подключён (§2.4).
- События рана пишутся до сетевого вызова (`admissionEvents`,
  `src/adapters/external-worker-adapter.ts:482-502`) — принятый ран виден в журнале
  сразу, это выполнено.
- События приёма и финальные события нумеруются непрерывно и не теряются при вытеснении
  (`src/api/stateless-store.ts:210-231`) — выполнено.

**Вывод:** пути, где среда уничтожается без подтверждённого persist, в нашем API
отсутствуют (среды нет), но и подтверждения нет — доверие к воркеру без верификации
`repo.commit` в remote. Пока `publishRunBranch` не подключён, единственная гарантия —
контракт воркера.

## 6. Что потеряно при переходе (против старого VM-пути)

| Старое | Новое | Статус |
|---|---|---|
| `recover()` после рестарта (`origin/main:src/api/service.ts:177`) | удалён; в-flight раны теряются после рестарта | **строго хуже** (§2.1) |
| Materialize input refs / снимков в workspace рана | `INPUT_REFS_UNSUPPORTED` — отказ до запуска (`src/adapters/external-worker-adapter.ts:307-312`); `snapshot.materialize.enabled: false` (`src/api/service.ts:468-476`) | **выпилено без эквивалента**; control-plane умеет слать `inputRefs` (`runner-api-adapter.ts:188`) — они будут отклоняться |
| Export всего дерева изменений | воркер коммитит только объявленные `outputs` (ТЗ §8) | **частичная замена**: файлы вне `outputs` теряются при teardown; M3-архив всего дерева существует в `src/workspace/` (main), но в serverless-путь не подключён |
| OS-изоляция слотами на хосте (`src/isolation/`) | `isolation.mode: "none"` на хосте; воркер объявляет сам | делегировано воркеру; по умолчанию — ничего (§2.8) |
| Скачивание байтов артефактов (`/v1/artifacts/{id}`) | маршрут удалён; только ссылки на GitHub | **потеряно**: живой потребитель в control-plane сломан (§2.8) |
| `connection_lost` как состояние долгоживущего раннера | поле осталось в контракте, но никогда не выставляется | мёртвый код с обеих сторон (§2.8) |
| SSE-стриминг событий | сохранён (`src/api/server.ts:159-230`) | перенесено |
| Cursor-replay событий | сохранён (`src/api/service.ts:305-333`) | перенесено |
| Дедупликация на диске | журнал приёмных записей (с дефектами, §2.2) | перенесено с потерями |

## 7. Безопасность удаления в PR #76

PR #76 (`feat/drop-runner-spawn-path`, база `feat/async-launch-contract`) удаляет
`src/runner/`, `src/isolation/`, `src/storage/`, `src/workspace/`, `src/release/`, `src/mcp/`,
`src/faults/`, `src/adapters/engine/` — 118 файлов, ~26k строк.

**Структурно удаление аккуратно:** контрактные куски, нужные обслуживающему пути, инлайнят
прямо в `src/contracts/run-spec.ts` (`isIsolationMode`, `isRegionId`,
`isSafeRelativePath` — diff PR #76), поэтому на ветке #76 ни один файл в `src/` и `test/`
не импортирует удалённые модули (проверено `git grep` по `feat/drop-runner-spawn-path`),
`package.json` и `src/index.ts` приведены в соответствие.

**Но приёмка #76 сейчас небезопасна по трём причинам:**

1. **База #76 не компилируется.** `feat/async-launch-contract` содержит незакоммиченный
   недописанный асинхронный контракт (§0). Сначала завершить и закоммитить контракт, потом
   перебазировать #76.
2. **#76 не содержит асинхронных коммитов.** Ветка `feat/drop-runner-spawn-path` растёт от
   `ecb29af`; коммиты `b49a098…7c18b50` (receipt/status/result, `unknown`, журнал) и
   незакоммиченные правки адаптеры в неё не попали. После мержа #76 в текущем виде
   обслуживающий путь останется без асинхронного контракта.
3. **Конфликт.** PR #76 сейчас `CONFLICTING` с базой (пересечение по
   `test/e2e-loop.test.ts` с коммитом `0cf580c`).

**Топология PR — отдельная находка.** Асинхронный контракт сейчас не покрыт ни одним PR,
целевым в main: PR #78 смерджнут в `feat/serverless-api-rework` только до коммита
`ecb29af` (fast-forward); пять следующих коммитов и незакоммиченная работа живут лишь на
`feat/async-launch-contract`. PR #75 (`feat/serverless-api-rework`, база `main`, CI зелёный,
`MERGEABLE`) при мерже принесёт в main serverless-переработку **без** асинхронного
контракта — то есть без п. 1–4 контракта. Порядок приёмки должен быть: завершить контракт →
дождаться его попадания в PR #75 (или отдельным PR в main) → перебазировать и смерджить #76.

## 8. Что исправить до приёмки

1. **Завершить и закоммитить асинхронный контракт**: убрать дубль `WorkerRunStatus`
   (`src/adapters/external-worker-adapter.ts:37,125`), добавить `baseUrlForResult` в
   `ExternalWorkerOptions` (`:786`), импортировать `timingSafeEqual` (`:931`), определить
   `CANCEL_DELIVERY_RETRIES/BACKOFF_MS` (`:956-957`), `resultGraceMs` и `POLL_*`
   (`src/api/service.ts:584,662`), сделать `store.append` доступным
   (`src/api/stateless-store.ts:210`), привести тесты к контракту. Без этого ветка не
   собирается.
2. **Восстановление поллеров после рестарта** (§2.1): либо персистить `RunProgress` (или
   хотя бы факт «ран запущен, воркер X, runId») и перезапускать `execute()` для
   незавершённых записей при старте, либо честно документировать, что после рестарта
   в-flight ран не восстановим, и убрать это из критериев приёмки. Текущее состояние —
   «запись есть, поллера нет, клиент видит `queued` вечно» — худшее из возможных.
3. **Выбрать один механизм доставки результата** (§2.6): либо реализовать маршрут
   `/v1/worker/launches/{runId}/result` с проверкой `matchesToken`, либо убрать
   `resultUrl`/`setResultBaseUrl`/`matchesToken` из контракта запроса и оставить только
   опрос. Сейчас воркер получает адрес несуществующего маршрута.
4. **Таймаут launch → unknown + reconcile** (§2.5): по контракту п. 4 сначала пометить
   `unknown`, затем один раз запросить `worker.status()`, и только при `unknown_run`
   считать запуск не состоявшимся.
5. **Стабильный `operationId`** (§2.3): выводить из `(userTaskId, generation)` — иначе
   воркерная дедупликация по `operationId` не работает никогда.
6. **Починить конфиг журнала** (§2.2): читать `AGENT_API_ADMISSION_LOG` из `process.env`,
   а не из пула `AGENT_API_ENV`; зафиксировать решение «журнал = диск» против критерия
   «API не пишет на диск» (`test/e2e-loop.test.ts:145`) — сейчас критерий падает.
7. **Подключить `publishRunBranch`** (§2.4) или явно отказаться от мержа веток рана в
   profile workspace: сейчас п. 5 контракта не выполняется, а `mergeUrl` отдаётся
   клиенту как обещание.
8. **Тест на дедупликацию через рестарт** (§2.1): поднять store с `persistPath`,
   положить запись, поднять второй store с тем же путём, проверить тот же `runId` и
   отсутствие второго launch — сейчас свойство не покрыто ни одним тестом.
9. **Синхронизировать control-plane** (§2.8): обработать `unknown` (не как таймаут),
   перестать полагаться на `connectionLost`, переписать чтение `/v1/runs/{id}/artifacts`
   под новую форму, решить судьбу байтового прокси артефактов.
10. **Привести в порядок топологию PR** (§7): контракт → в main (через #75 или отдельным
    PR), затем перебазировать #76.

## 9. Что можно отложить

- **Object storage для тяжёлых выходов** (п. 6): пока артефакты — текст в git, можно
  жить; но фиксировать как известное отклонение от контракта, а не как выполнение.
- **Верификация `repo.commit` в remote на стороне API** (§5): можно отдать воркеру и
  `publishRunBranch`, когда тот подключён.
- **`cancelOrphan`** (п. 4, «лучшее усилие»): не блокирует приёмку, если reconcile
  работает.
- **Scoped-доступ к GCS-логам** (п. 8): полностью на стороне воркера.
- **Удаление библиотеки в #76**: само по себе безопасно (§7), но только после пунктов
  1–3 из §8 и перебазирования.

## 10. Итог

Контракт по механике в целом разделяем и частично реализован: квитанция, разделение
status/result, `unknown ≠ failed`, reconcile при живом API, ветка рана, честные
capabilities — всё это в коде. Но ветка **не компилируется и не проходит тесты**, ключевое
свойство «дедупликация переживает рестарт» реализовано с тремя дефектами (недостижимый
конфиг, отсутствие восстановления поллера, отсутствие теста), а два окна второго рена
(рестарт + новый ключ; таймаут launch) остаются открытыми. Удаление старого пути (#76)
структурно аккуратно, но сейчас конфликтует и не содержит асинхронного контракта.
Приёмка возможна только после пунктов §8.1–§8.6.
