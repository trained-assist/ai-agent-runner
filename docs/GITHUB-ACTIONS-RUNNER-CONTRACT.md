# Контракт: подключение раннера на GitHub Actions

**Статус:** проект, 04.10.2026. Реализация — отдельной задачей.

**Короткий ответ:** раннер на GitHub Actions подключается **тем же контрактом**, что и
Azure-воркер (`LaunchRequest` / `LaunchResult`, issue #73). Наш API не знает и не должен
знать, где живёт воркер. Единственная новая деталь — **получатель (receiver)**: тонкий
HTTP-сервис перед воркером, потому что в CI нет входящих портов.

---

## 1. Почему не «workflow как воркер напрямую»

Наш API вызывает `POST {worker}/v1/launch` и **ждёт ответ в том же соединении** — контракт
синхронный, весь ран проходит в одном HTTP-запросе. Для воркера на долгоживущей VM это
естественно. Для GitHub Actions — нет, и причины измерены, а не предположены
(`docs/GITHUB-ACTIONS-CAPABILITY.md`, раздел «Чего НЕТ / что НЕЛЬЗЯ в CI»):

| Ограничение | Замер | Следствие для контракта |
|---|---|---|
| **Входящие порты недоступны** | нет туннеля, нет idle-ожидания внутри рана | workflow не может принимать запросы от нашего API |
| Job имеет таймаут | `timeout-minutes: 30` (capability/stress), `20` (isolation) | ран дольше лимита job'ы обрывается |
| Потолок памяти ≈ 15 GiB | аллокация до ~18 GB → exit 143 | тяжёлые агенты не влезают |
| Reboot невозможен | `systemctl reboot` убивает раннер вместе с job | проверять только на песочной VM |
| Нет KVM | `/dev/kvm` отсутствует | изоляция — только на уровне процессов |

Из первого пункта следует главное: **workflow умеет только исходящие вызовы** (так он
разговаривает с GitHub). Значит связь «наш API → workflow» должна идти через посредника,
который принимает запрос и сам дёргает workflow.

---

## 2. Архитектура

```
Клиент
  │  POST /v1/runs  { engine: "github-actions-agent-run", repository: { fullName }, … }
  ▼
Наш API (stateless, без диска)
  │  POST {receiver}/v1/launch  { LaunchRequest }        ← держит соединение до конца рана
  ▼
Получатель (receiver) — долгоживущий сервис, НЕ CI
  │  POST /repos/{owner}/{repo}/actions/workflows/agent-run.yml/dispatches
  │  { ref: "agent-run/<runId>", inputs: { launchRequest } }
  ▼
GitHub Actions workflow (эфемерный runner)
  │  1. checkout repository.fullName в ветку agent-run/<runId>
  │  2. opencode run "<prompt>" в cwd
  │  3. коммит outputs в ветку, пуш
  │  4. лог сессии → Google Storage
  │  5. POST {receiver}/v1/launch/{runId}/result  { LaunchResult }   ← исходящий вызов
  ▼
Получатель отвечает на висящий запрос нашего API
  ▼
Наш API → клиенту: RunResult + ссылки на ветку и merge
```

**Почему receiver, а не асинхронный launch.** Можно было бы сделать `launch` асинхронным
(`202 {runId}` + polling) и обойтись без долгоживущей машины — тогда receiver мог бы быть
Cloudflare Worker'ом. Но это меняет контракт для **всех** воркеров ради одного и ломает
единый порт: наш API перестаёт знать, синхронный воркер перед ним или асинхронный. Синхронный
контракт проще проверять, у него один таймаут и один код ошибок. Поэтому контракт остаётся
синхронным, а асинхронность живёт внутри receiver'а.

---

## 3. Что меняется в контракте (issue #73)

**Ничего.** Это и есть ответ на вопрос «как подрубить»: тот же `LaunchRequest`, тот же
`LaunchResult`, тот же `POST {worker}/v1/launch`. Меняется только **имя движка** и то, кто
стоит за `EXTERNAL_WORKER_URL`.

| Поле | Значение для GH Actions |
|---|---|
| `engine.name` | `github-actions-agent-run` |
| `engine.adapterVersion` | `1` |
| `repository.fullName` | `owner/name` — как обычно |
| `repository.branch` | `agent-run/<runId>` — как обычно, генерирует API |
| `limits.timeoutMs` | ≤ таймаут job'ы минус запас на старт и финализацию (см. §5) |

`LaunchResult` возвращается ровно по тому же контракту: `artifacts[]`, `repo: {fullName,
branch, commit, baseRef}`, `logUrl`. Наш API строит из них ссылки на файл, на ветку и на
merge — клиенту неважно, где отработал ран.

---

## 4. Требования к получателю (receiver)

Получатель — единственный новый компонент, и он **не в CI**: ему нужно держать входящее
соединение столько, сколько идёт ран.

1. **Реализует тот же контракт**, что и любой воркер: `POST /v1/launch` → `LaunchResult`,
   `POST /v1/runs/{runId}/cancel` → `{status: "cancelled" | "rejected" | "unknown_run"}`.
2. **Держит соединение открытым** до получения `LaunchResult` от workflow. Таймаут — тот же,
   что у нашего API (`EXTERNAL_WORKER_LAUNCH_DEADLINE_MS`), чтобы клиент видел один и тот же
   отказ независимо от того, где отработал ран.
3. **Диспетчерит workflow** через GitHub API:
   `POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches` с `ref` = ветка рана и
   `inputs.launchRequest` = тело запроса.
4. **Принимает результат** от workflow: `POST /v1/launch/{runId}/result` с `LaunchResult`.
   Это исходящий вызов из CI, поэтому работает без входящих портов.
5. **Отмена**: по `POST /v1/runs/{runId}/cancel` — либо убить запущенный workflow
   (`POST /repos/…/actions/runs/{runId}/cancel`), либо вернуть `rejected`, если ран уже
   закончился.
6. **Stateless**: состояние висящего запроса живёт в памяти процесса. Рестарт receiver'а =
   потеря рана, как и рестарт нашего API. Это тот же задокументированный контракт, что и у
   stateless API.

**Где живёт receiver:** та же VM, что и наш API, либо отдельная долгоживущая машина.
Cloudflare Worker не подходит: он не может держать соединение десятки минут.

---

## 5. Требования к workflow `agent-run.yml`

1. **Триггер:** `workflow_dispatch` с входом `launchRequest` (JSON-строка или объект).
2. **Клон:** `repository.fullName` в `cwd`, ветка `repository.branch` уже создана нашим API
   как имя — workflow делает `git checkout <branch>` (ветку создаёт GitHub из `ref` при
   dispatch).
3. **Агент:** `opencode run "<prompt>"`, `cwd` = рабочий каталог. Замер: opencode в CI
   работает, `pong` за 4–17 с, конфиг `llm-ladder` + модель `free` обязателен.
4. **Выходы:** коммитит объявленные `outputs` в ветку рана и пушит её. Не коммитит в ветку
   по умолчанию.
5. **Лог:** загружает лог сессии в Google Storage, получает `logUrl`.
6. **Результат:** `POST {receiver}/v1/launch/{runId}/result` с `LaunchResult` по контракту.
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

Добавление второго движка — это **одна запись в конфиге**, без правок кода:

```json
AGENT_API_WORKERS=[
  {"engine":"dynamic-ip-azure-agent-run","baseUrl":"https://azure-worker.example","token":"…","acceptDeadlineMs":30000},
  {"engine":"github-actions-agent-run","baseUrl":"https://receiver.example","token":"…"}
]
```

Всё остальное — маршруты, идемпотентность, события, артефакты, ветка рана — не меняется.

### Приоритетная цепочка движков (issue #100)

```bash
AGENT_API_ENGINE_CHAIN=azure-dynamic-ip-agent-run,eu-vm-agent-run,rf-vm-agent-run
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
   раннерах). Раны длиннее остаются за Azure-воркером.
2. **Память ≈ 15 GiB.** Тяжёлые агенты не влезают.
3. **Нет изоляции уровня ОС.** В CI нет root, нет KVM, нет входящих портов. Граница — только
   процесс и отдельный checkout. Для чувствительных задач остаётся Azure.
4. **Нужна ещё одна машина** под receiver (или он живёт на той же VM, что и API).
5. **Креды на push** у воркера — свои (deploy key / GitHub App), как и для Azure-воркера.
   Клиентский `repository.token` по-прежнему наружу не уходит: воркер берёт токен публикации
   из `LaunchRequest.publicationToken`, который приходит в claim-ответе, а не в `inputs`
   диспатча (см. [ai-agent-runner#6](https://github.com/vovalikessmoothy-png/opencode-gha-runner/pull/6)).

---

## 8. Приёмка

- [x] `POST /v1/runs` с `engine: "github-actions-agent-run"` принимается, `capabilities().engines`
      содержит оба движка — реестр движков реализован и покрыт тестом.
- [ ] Receiver отдаёт `LaunchResult` по контракту, наш API возвращает ссылки на файл,
      ветку и merge.
- [ ] Ветка `agent-run/<runId>` создана, `outputs` закоммичены в неё, ветка запушена.
- [ ] Ран длиннее `limits.timeoutMs` завершается честным отказом, а не обрывом job'ы.
- [ ] Отмена доходит до workflow и даёт `outcome: cancelled`.
- [ ] Лог сессии в GCS, `logUrl` возвращается.
- [ ] Рестарт receiver'а теряет ран — и это задокументировано как контракт, а не авария.
- [ ] Память job'ы ниже 15 GiB на типовом ран'е.

## 9. Связанные документы

| Документ | Смысл |
|---|---|
| `docs/TZ-EXTERNAL-OPENCODE-WORKER.md` | ТЗ воркера: контракт, ветка рана, артефакты, лог |
| `docs/GITHUB-ACTIONS-CAPABILITY.md` | Замеры лимитов CI: что можно, что нельзя, тайминги |
| `docs/API-SERVICE.md` | Деплой и конфигурация нашего API |
| Issue [#73](https://github.com/trained-assist/ai-agent-runner/issues/73) | Канонический контракт `LaunchRequest`/`LaunchResult` |
