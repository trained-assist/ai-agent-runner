# Контракт: подключение раннера на GitHub Actions

**Статус:** реализовано в `opencode-gha-runner` и проверено успешным workflow run
[`37859213470`](https://github.com/vovalikessmoothy-png/opencode-gha-runner/actions/runs/37859213470)
(8 октября 2026). Новый API engine label — `azure-cloud`; старые labels остаются совместимыми.

**Короткий ответ:** GHA gateway принимает тот же `LaunchRequest` и возвращает тот же
`LaunchResult`, что и остальные внешние workers. Он размещён как Cloudflare Worker; GitHub
Actions выполняет только эфемерную job. API выбирает этот путь явным engine name
`azure-cloud`.

---

## 1. Почему не «workflow как воркер напрямую»

Job не имеет входящего порта. Cloudflare gateway принимает запуск, сохраняет квитанцию и
short-lived claim/report токены, затем сам вызывает GitHub API. Job забирает run specification
исходящим claim-запросом. Это позволяет API и job общаться через короткие запросы без
долгого открытого HTTP-соединения:

| Ограничение | Замер | Следствие для контракта |
|---|---|---|
| **Входящие порты недоступны** | нет туннеля, нет idle-ожидания внутри рана | workflow не может принимать запросы от нашего API |
| Job имеет таймаут | `timeout-minutes: 30` (capability/stress), `20` (isolation) | ран дольше лимита job'ы обрывается |
| Потолок памяти ≈ 15 GiB | аллокация до ~18 GB → exit 143 | тяжёлые агенты не влезают |
| Reboot невозможен | `systemctl reboot` убивает раннер вместе с job | проверять только на песочной VM |
| Нет KVM | `/dev/kvm` отсутствует | изоляция — только на уровне процессов |

Остальные измеренные ограничения CI приведены здесь для выбора подходящих тестовых задач;
они не требуют VM-hosted receiver.

---

## 2. Архитектура

```
Клиент
  │  POST /v1/runs  { engine: "azure-cloud", repository: { fullName }, … }
  ▼
Наш API (stateless, без диска)
  │  POST {gateway}/v1/launch  { LaunchRequest }         ← возвращает receipt сразу
  ▼
Cloudflare Worker gateway + KV
  │  POST /repos/{owner}/{repo}/actions/workflows/agent-run.yml/dispatches
  │  { ref, inputs: { run_id, claim_token } }
  ▼
GitHub Actions workflow (эфемерный runner)
  │  исходящий claim → полный run spec + llmKey (одноразово)
  │  1. checkout repository.fullName в ветку agent-run/<runId>
  │  2. opencode run "<prompt>" в cwd
  │  3. коммит outputs в ветку, пуш
  │  4. лог сессии → Google Storage
  │  5. POST gateway report с LaunchResult            ← исходящий вызов
  ▼
Gateway пересылает результат в API callback; API также может poll status/result
  ▼
Наш API → клиенту: RunResult + ссылки на ветку и merge
```

Gateway is a Cloudflare Worker. The API contract is asynchronous: `POST /v1/launch` returns
an acceptance receipt; the API polls status/result and accepts the result callback. No
long-lived receiver process is required.

---

## 3. Что меняется в контракте (issue #73)

Контракт использует те же `LaunchRequest` и `LaunchResult`, что и другие внешние workers.
Для GHA меняются engine name и адрес worker gateway.

| Поле | Значение для GH Actions |
|---|---|
| `engine.name` | `azure-cloud` (legacy names remain accepted) |
| `engine.adapterVersion` | `1` |
| `repository.fullName` | `owner/name` — как обычно |
| `repository.branch` | `agent-run/<runId>` — как обычно, генерирует API |
| `limits.timeoutMs` | ≤ таймаут job'ы минус запас на старт и финализацию (см. §5) |

`LaunchResult` возвращается ровно по тому же контракту: `artifacts[]`, `repo: {fullName,
branch, commit, baseRef}`, `logUrl`. Наш API строит из них ссылки на файл, на ветку и на
merge — клиенту неважно, где отработал ран.

---

## 4. Gateway contract

Gateway implements the same asynchronous worker endpoints: `POST /v1/launch` returns a
receipt; `GET /v1/runs/{runId}/status` and `/result` expose progress and output; cancel is
forwarded to the corresponding GitHub Actions run. The workflow receives only `run_id` and
one-time `claim_token` as dispatch inputs. The model key, repository publication token, prompt,
and remaining run specification are delivered after claim, never in workflow metadata.

The gateway stores run state in Cloudflare KV and sends the result callback to the API. API
polling of status/result is the recovery path when callback delivery fails. There is no extra
VM, France dependency, or task-workspace dependency on `gha-env-config`.

---

## 5. Требования к workflow `agent-run.yml`

1. **Триггер:** `workflow_dispatch` только с входами `run_id` и одноразовым `claim_token`.
2. **Клон:** `repository.fullName` в `cwd`, ветка `repository.branch` уже создана нашим API
   как имя — workflow делает `git checkout <branch>` (ветку создаёт GitHub из `ref` при
   dispatch).
3. **Агент:** `opencode run "<prompt>"`, `cwd` = рабочий каталог. Замер: opencode в CI
   работает, `pong` за 4–17 с, конфиг `llm-ladder` + модель `free` обязателен.
4. **Выходы:** коммитит объявленные `outputs` в ветку рана и пушит её. Не коммитит в ветку
   по умолчанию.
5. **Лог:** загружает лог сессии в Google Storage, получает `logUrl`.
6. **Результат:** отправляет `LaunchResult` на gateway report endpoint; gateway сохраняет
   результат и передаёт его в API callback.
7. **Таймаут job'ы:** `timeout-minutes` должен быть ≥ `limits.timeoutMs` + запас на checkout,
   старт opencode и финализацию. Практический потолок — 30 минут для стандартных раннеров.
8. **Память:** держать потребление ниже ~15 GiB, иначе job умирает с exit 143 без внятной
   ошибки.

---

## 6. Что изменилось в нашем API — уже сделано

Наш API уже умеет несколько движков, подключать ничего не нужно:

```ts
new AgentApi({ workers: [azureWorker, ghActionsWorker] });
```

- `submit` выбирает воркер по `request.engine.name`; неизвестный движок → `ENGINE_NOT_ALLOWED`
  с перечислением доступных. Заявка без `engine` идёт по приоритетной цепочке (см. ниже).
- `capabilities().engines` — отсортированный список имён воркеров;
  `capabilities().engineSelection.chain` — цепочка в порядке проб.
- `GET /healthz` возвращает `workers: [{engine, baseUrl}]` и `engineChain`.
- Отмена уходит в воркер **своего** движка, а не в первый попавшийся; при цепочке — в тот,
  который принял ран.
- Пустой реестр — отказ на старте: API без способа запустить агента не поднимается.

Конфиг (переменные окружения):

| Переменная | Формат |
|---|---|
| `AGENT_API_WORKERS` | JSON-список `[{engine, baseUrl, token, acceptDeadlineMs?}]` — несколько движков |
| `AGENT_API_ENGINE_CHAIN` | приоритетная цепочка через запятую, в порядке проб; не задана — ран идёт на названный клиентом движок |
| `EXTERNAL_WORKER_URL` / `EXTERNAL_WORKER_TOKEN` | одиночный воркер; имя движка — `EXTERNAL_WORKER_ENGINE` либо `dynamic-ip-azure-agent-run` по умолчанию |
| `EXTERNAL_WORKER_LAUNCH_DEADLINE_MS` / `..._CANCEL_DEADLINE_MS` | таймауты, применяются ко всем воркерам |
| `EXTERNAL_WORKER_ACCEPT_DEADLINE_MS` | бюджет ожидания квитанции на движок (по умолчанию 30 000) |

Прямой sandbox-вызов GHA добавляет worker gateway под `azure-cloud`. Используйте sandbox
API key, ограниченный `engines: ["azure-cloud"]`; оставьте production/queue engine chain
без изменений. `baseUrl` — gateway URL, а token — его `WORKER_TOKEN`, сохранённый в secret
store (не в vars или запросе):

```json
AGENT_API_WORKERS=[
  {"engine":"azure-cloud","baseUrl":"https://opencode-gha-runner-gateway.skillset-apply.workers.dev","token":"<gateway WORKER_TOKEN>","acceptDeadlineMs":30000}
]
```

Поскольку клиент явно передаёт `engine.name = "azure-cloud"`, Agent API идёт напрямую в
этот gateway и не пробует France/Russia VM. GHA job получает `llmKey` только после
одноразового claim; prompt и ключ модели не попадают в `workflow_dispatch` inputs.

Всё остальное — маршруты, идемпотентность, события, артефакты, ветка рана — не меняется.

### Необязательная цепочка fallback (issue #100)

Эта цепочка включается только отдельной sandbox-конфигурацией после проверки fallback; она
не требуется для прямого теста `azure-cloud`.

```bash
AGENT_API_ENGINE_CHAIN=eu-vm-agent-run,rf-vm-agent-run,azure-cloud
```

Ран без `engine` в заявке пробует движки по порядку цепочки. Следующий берётся только если
предыдущий **не принял** ран (`WORKER_LAUNCH_UNREACHABLE`, `WORKER_HTTP_ERROR`,
`WORKER_PROTOCOL_INVALID`): квитанция получена — перехода нет, ран уже идёт. Перед переходом
цепочка спрашивает текущий движок, знает ли он ран (контракт, п. 4): знает — ран принимается
без квитанции и опрашивается там; не знает — переход; спросить не удалось — ран остаётся
`unknown`, второго запуска нет. `operationId` при переходе не меняется, поэтому дедупликация
воркера возвращает тот же `runId`. Ни один движок не принял — ран закрывается
`ENGINE_FLEET_EXHAUSTED` с перечнем попыток. Заявка с явным `engine.name` цепочкой не
пользуется. Подробности — `docs/EXTERNAL-WORKER-CONTRACT.md`, раздел «Приоритетная цепочка
движков».

---

## 7. Ограничения, которые надо принять заранее

1. **Длинные раны в CI невозможны.** Потолок — таймаут job'ы (до 30 минут на стандартных
   раннерах). Раны длиннее остаются за France VM worker.
2. **Память ≈ 15 GiB.** Тяжёлые агенты не влезают.
3. **Нет изоляции уровня ОС.** В CI нет root, нет KVM, нет входящих портов. Граница — только
   процесс и отдельный checkout. Для задач, которым нужна VM isolation, остаётся France VM.
4. **GHA — менее изолированная и ограниченная среда**: обычный hosted runner, лимит job и
   process-level isolation. Использовать для тестов и подходящих задач.
5. **Креды на push** у воркера — свои (deploy key / GitHub App), как и для Azure-воркера.
   Клиентский `repository.token` по-прежнему наружу не уходит: воркер берёт токен публикации
   из `LaunchRequest.publicationToken`, который приходит в claim-ответе, а не в `inputs`
   диспатча (см. [ai-agent-runner#6](https://github.com/vovalikessmoothy-png/opencode-gha-runner/pull/6)).

---

## 8. Приёмка

- [x] Engine API допускает отдельную регистрацию и явный вызов `azure-cloud`; unit-тесты
      проверяют прямой выбор и приоритет GHA в sandbox fleet.
- [x] Успешный live GHA workflow run: [37859213470](https://github.com/vovalikessmoothy-png/opencode-gha-runner/actions/runs/37859213470).
- [ ] Свежий end-to-end submit через Agent API `azure-cloud` возвращает результат, ссылки на
      выход и ветку. Нужна sandbox-конфигурация с gateway `WORKER_TOKEN`.
- [ ] Ветка `agent-run/<runId>` создана, `outputs` закоммичены в неё, ветка запушена.
- [ ] Ран длиннее `limits.timeoutMs` завершается честным отказом, а не обрывом job'ы.
- [ ] Отмена доходит до workflow и даёт `outcome: cancelled`.
- [ ] Лог сессии в GCS, `logUrl` возвращается.
- [x] Gateway размещён как Cloudflare Worker и хранит состояние в KV; дополнительный VM receiver не нужен.
- [ ] Память job'ы ниже 15 GiB на типовом ран'е.

## 9. Связанные документы

| Документ | Смысл |
|---|---|
| `docs/TZ-EXTERNAL-OPENCODE-WORKER.md` | ТЗ воркера: контракт, ветка рана, артефакты, лог |
| `docs/GITHUB-ACTIONS-CAPABILITY.md` | Замеры лимитов CI: что можно, что нельзя, тайминги |
| `docs/API-SERVICE.md` | Деплой и конфигурация нашего API |
| Issue [#73](https://github.com/trained-assist/ai-agent-runner/issues/73) | Канонический контракт `LaunchRequest`/`LaunchResult` |
