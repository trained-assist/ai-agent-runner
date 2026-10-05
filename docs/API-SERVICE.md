# Serverless Agent API — деплой, конфигурация, смоук

## External-worker callback configuration

Set host-only `AGENT_API_PUBLIC_URL` to the externally reachable base URL of this API process. The entry point passes it to every external worker adapter, which appends `/v1/worker/launches/{runId}/result`. HTTP and HTTPS are accepted; credentials, query strings, and fragments are rejected. The setting is not added to the run environment pool. Without it, the existing `RESULT_URL_UNSET` preflight refusal remains.

This wiring change preserves the existing result polling. Revision `8598170` does not expose the callback POST route; workers that require callback delivery rather than a readable status/result endpoint still need that receiver implemented separately.

For an isolated sandbox process, set `AGENT_API_PORT=18878`, use a separate `AGENT_API_ADMISSION_LOG`, and retain the existing host-only key registry and worker configuration. Set `RUNNER_DEFAULT_REPO` to a valid `owner/name`, or provide an explicit repository in submit. Point both the CP Runner binding and `AGENT_API_PUBLIC_URL` at a tunnel or proxy targeting this same process on port 18878. A callback to the active service on port 8787 cannot resolve a run accepted by the isolated process. Keep callback routing available until its runs finish. Do not restart or reconfigure the active service for this experiment.

Статус документа: **04.10.2026, модель epic #74.** API — stateless-оркестратор: он не пишет
на диск, не запускает процессов и не восстанавливается после рестарта. Единственное, что он
делает, — ходит по HTTP во внешнего воркера и отдаёт клиенту то, что тот вернул.

Предыдущая версия документа описывала API с durable store `/var/lib/agent-runner`,
локальным `spawn` движков и recovery после `kill -9`. Этих вещей в сервисе больше нет.

---

## 1. Что в репо

| Модуль | Файл | Роль |
|---|---|---|
| HTTP-сервис | `dist/api/main.js` | читает env, поднимает `node:http`, всё состояние — в памяти |
| Ядро | `src/api/service.ts` | приём запроса, идемпотентность, запуск во внешний воркер, маппинг результата |
| Память процесса | `src/api/stateless-store.ts` | приёмные записи, прогресс ранов, события, лимиты и TTL |
| Адаптер воркера | `src/adapters/external-worker-adapter.ts` | `POST {worker}/v1/launch` → `LaunchResult`, отмена через `POST {worker}/v1/runs/{id}/cancel` |
| Маршруты | `src/api/server.ts` | `/healthz`, `/v1/capabilities`, `/v1/runs…` |
| Юнит | `infra/agent-runner-api.service` | systemd, `User=sandbox`, **без `ReadWritePaths` и без capabilities** |
| Деплой | `scripts/deploy-api-service.sh` | build → config dir → API-ключ → адрес воркера → юнит → health → auth → ufw |
| CLI | `scripts/runner-cli.mjs` | `submit/status/events/follow/result/cancel` против живого API |

Библиотечный код (`src/runner/`, `src/isolation/`, `src/storage/`, `src/workspace/`,
`src/release/`) остался в репозитории как модули самого Runner'а, но **обслуживающим путём
API больше не используется** и удаляется отдельной задачей.

---

## 2. Конфигурация

Обязательное:

| Переменная | Смысл |
|---|---|
| `AGENT_API_KEY_REGISTRY` | путь к JSON с `principals` (только sha256 ключей), режим `0600` |
| `EXTERNAL_WORKER_URL` | базовый URL внешнего воркера (`http(s)://…`) |
| `EXTERNAL_WORKER_TOKEN` | общий секрет; уходит в `Authorization: Bearer …` |

Принимаются также имена из ТЗ воркера — `DYNAMIC_IP_AZURE_URL` / `DYNAMIC_IP_AZURE_TOKEN`,
но `EXTERNAL_WORKER_*` приоритетнее.

Необязательное:

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `AGENT_API_HOST` / `AGENT_API_PORT` | `0.0.0.0` / `8787` | адрес прослушивания |
| `AGENT_API_PUBLIC_URL` | — | публичный base URL этого же API instance для callback внешнего воркера; только host configuration |
| `AGENT_API_ENV` | `{}` | JSON-пул значений окружения; в воркер уходят только те, что перечислил клиент в `envAllowlist` |
| `RUNNER_DEFAULT_REPO` | — | `owner/name` для клиентов, не объявивших `repository` |
| `EXTERNAL_WORKER_LAUNCH_DEADLINE_MS` | `600000` | таймаут ожидания `LaunchResult` |
| `EXTERNAL_WORKER_CANCEL_DEADLINE_MS` | `30000` | таймаут ожидания подтверждения отмены |

Переменных данных больше нет: `AGENT_API_DATA_DIR`, `ARTIFACT_SHARE_SECRET`,
`ARTIFACT_BASE_URL`, `AGENT_API_RELEASE_MANIFEST`, `AGENT_API_FAULTS` сервис не читает.

---

## 3. Эндпоинты

| Метод и путь | Что делает |
|---|---|
| `GET /healthz` | единственный маршрут без ключа: `{status, worker, engine, runs, admissions, events}` |
| `GET /v1/capabilities` | декларация возможностей (см. §5) |
| `POST /v1/runs` | приём: `Idempotency-Key` обязателен; `202` — новый receipt, `200` — дедуп |
| `GET /v1/runs/{id}/status` | состояние рана, курсор событий, `answer` агента |
| `GET /v1/runs/{id}/result` | `RunResult` после терминального состояния, иначе `409 RESULT_NOT_READY` |
| `GET /v1/runs/{id}/events` | страница событий (`?cursor=&limit=`) либо SSE на `Accept: text/event-stream` |
| `GET /v1/runs/{id}/artifacts` | ветка рана, ссылка на merge, ссылки на файлы по коммиту и `logUrl` |
| `GET /v1/runs/{id}/log` | `302` на ссылку лога в Google Storage |
| `POST /v1/runs/{id}/cancel` | пробрасывает отмену воркеру; `202` — принята, `200` — уже терминальный |

Маршрутов ниже больше нет: `/v1/runs/{id}/export`, `/v1/runs/{id}/upload`,
`/v1/runs/{id}/upload-session/{sid}`, `/v1/runs/{id}/snapshot`,
`/v1/runs/{id}/snapshot-file/{sid}`, `/v1/artifacts/{id}`, `/v1/release`,
`/v1/capabilities/invoke`. Они либо писали на диск, либо отдавали байты.

---

## 4. Жизненный цикл рана

```
POST /v1/runs  →  202 receipt           память: AdmissionRecord + события claimed/inputs_materialized
                →  POST {worker}/v1/launch   (воркер сам клонирует репозиторий и запускает агента)
                →  LaunchResult         маппинг в RunResult + RunnerEvent[]
                →  память: state terminal, logUrl, artifacts[], repo
```

События появляются двумя волнами: `claimed` и `inputs_materialized` пишутся сразу при приёме,
остальные — когда воркер ответил. Поэтому журнал не пуст, пока воркер думает, и клиент
отличает «принято» от «потеряно».

**Отмена.** Контракт воркера синхронный: `launch` — это весь ран. Если отмена приходит раньше,
чем воркер зарегистрировал ран, его `cancel` отвечает `unknown_run`; API повторяет запрос,
пока ран в полёте (`CANCEL_UNKNOWN_RUN_RETRIES` × `CANCEL_UNKNOWN_RUN_BACKOFF_MS`). Если ран
так и не появился — отказ (`409`), а не «остановлено».

**Отказ воркера.** Транспортный обрыв, HTTP-ошибка или тело вне контракта дают терминальный
`failed` с `exitReason: worker_crash` и кодом причины (`WORKER_UNREACHABLE`, `WORKER_HTTP_ERROR`,
`WORKER_PROTOCOL_INVALID`, `WORKER_LAUNCH_TIMEOUT`). Пре-флайт-отказ клиента (`input.refs`,
нет промпта) сохраняет свой код и `retryable: false`. Ран никогда не остаётся в `running`
навсегда.

## 4.1 Результат рана — ветка

Каждый ран получает **свою ветку** `agent-run/<runId>` в репозитории юзера: имя задаёт API,
воркер клонирует репозиторий, создаёт ветку, коммитит в неё объявленные `outputs` и пушит.
`GET /v1/runs/{id}/artifacts` отдаёт три уровня адреса:

| Поле | Пример | Что это |
|---|---|---|
| `artifacts[].url` | `https://github.com/owner/name/blob/abc1234/report.md` | конкретный файл на коммите |
| `branchUrl` | `https://github.com/owner/name/tree/agent-run/run_…` | весь результат рана |
| `mergeUrl` | `https://github.com/owner/name/compare/main...agent-run/run_…` | куда его смержить |

Наше API **не мержит** — у него нет кредов на push и merge чужой работы без спроса. Решение
о слиянии принимает человек или control plane, получив `mergeUrl`. Подробности — ТЗ воркера §8.1.

---

## 5. Декларация возможностей

`GET /v1/capabilities` отчитывается о том, что есть на самом деле:

- `engines: ["dynamic-ip-azure-agent-run"]` — единственный движок, и он внешний;
- `isolation.mode: "none"`, `launcher: null` — на хосте API нечего изолировать, агента
  запускает воркер на своей машине и объявляет границу в ответе;
- `artifacts.export.enabled: false`, `download: false`, `shareLink: false`,
  `upload.enabled: false`, `snapshot.enabled: false` — байт в API нет;
- `promotion.releaseEndpoint: "absent"` — контура промоушена в stateless-сервисе нет;
- `events: {cursor, replay, sse, lastEventId}` — работают, журнал в памяти.

---

## 6. Безопасность

- **Ключи.** В реестре только sha256; сверка `timingSafeEqual`. Сырой ключ лежит в
  `/etc/agent-runner/api-key` (`0600`) и печатается один раз при первом деплое.
- **Журнал.** Заголовок `Authorization` не логируется; `redactSecrets` вырезает
  `ghp_…`/`github_pat_…`/`token=…` из сообщений об ошибках и из stdout/stderr рана,
  попавшего в события.
- **Токен репозитория.** В `LaunchRequest` уходит только `repository.fullName`; клонирует
  воркер, поэтому клиентский токен не пересекает границу процесса.
- **Юнит.** `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`. Capabilities не выдаются:
  переключать Unix-идентичность больше нечего, писать некуда.
- **Firewall.** `deploy-api-service.sh` открывает порт только после успешной auth-пробы
  (анонимный `POST /v1/runs` → 401, с ключом `GET /v1/runs/<unknown>/status` → 404).

---

## 7. Деплой

```bash
sudo scripts/deploy-api-service.sh --worker-url https://worker.example --worker-token "$TOKEN"
# или с переменными окружения:
sudo EXTERNAL_WORKER_URL=https://worker.example EXTERNAL_WORKER_TOKEN="$TOKEN" scripts/deploy-api-service.sh
```

Скрипт: `npm ci` → `npm run build` → `/etc/agent-runner` → API-ключ `0600` → env-файл с
адресом и токеном воркера → юнит → `systemctl enable --restart` → `GET /healthz` →
auth-проба → ufw. Каталога данных не создаётся.

---

## 8. Смоук на живой VM

```bash
export RUNNER_API_URL=http://127.0.0.1:8787 RUNNER_API_KEY_FILE=/etc/agent-runner/api-key

curl -s $RUNNER_API_URL/healthz | jq .                # status, worker, engine
node scripts/runner-cli.mjs submit --prompt "напиши отчёт в report.md"   # 202 + receipt
node scripts/runner-cli.mjs follow <runId>            # SSE до терминального события
node scripts/runner-cli.mjs result <runId> | jq .     # outcome, outputRefs (ссылки на GitHub), logPath (GCS)
curl -s -H "Authorization: Bearer $KEY" $RUNNER_API_URL/v1/runs/<runId>/artifacts | jq .
```

Приёмка приёма воркера на dev-стенде описана в `test/e2e-loop.test.ts`: поднимается мок
воркера, и проверяется полный путь submit → launch → result → артефакты → logUrl.

---

## 9. Ограничения (честно)

- **Состояние в памяти.** Рестарт процесса = потеря ранов. Клиент обязан повторять submit с
  новым `Idempotency-Key`. Это задокументированный контракт, а не авария, но он означает, что
  retry с тем же ключом после рестарта создаст новый ран.
- **Лимиты памяти.** `maxRuns` (500), `maxEventsPerRun` (2000), TTL терминальных ранов (1 час);
  при переполнении самые старые терминальные раны выбрасываются. События сверх лимита
  учитываются в `droppedEvents`, а не молча теряются.
- **Живой прогон длиннее `AGENT_API`-процесса.** Пока воркер думает, запрос `launch` висит;
  это ограничение платформы, а не API.
- **TLS нет.** На песочнице допустимо, на проде нужен прокси или Cloudflare Worker.
- **Open question ТЗ §13.1** (CF Worker или тонкий VM) не решена: до решения API разворачивается
  как stateless-процесс на VM, и `infra/agent-runner-api.service` — временная обвязка.
- **`RUNNER_DEFAULT_REPO`** обязателен для клиентов без `repository`, иначе воркер не сможет
  клонировать репозиторий.
