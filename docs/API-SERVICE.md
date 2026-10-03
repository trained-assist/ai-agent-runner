# Serverless Agent API на песочной VM — деплой, безопасность, смоук

Деплой постоянного сервиса + CLI для runner#7 (dogfooding, шаг 1).
Факты ниже собраны на живой VM `vm2` (Hostland, `169.58.15.230`, Ubuntu 24.04, node v20.20.2)
**2026-10-01**, ветка `feat/api-service-on-sandbox-vm`.

## Что в репо

| Файл | Роль |
|---|---|
| `src/api/main.ts` | Точка входа сервиса (новый файл; существующие `src/api/**` не менялись). Env-конфиг, обязательный key registry, data dir `0700` и запрет `/tmp`, один HTTP-порт для `/healthz` + `/v1/runs/*` + `/v1/artifacts/*`, graceful shutdown на SIGTERM |
| `tsconfig.build.json`, `npm run build` / `npm start` | Сборка `tsc → dist/`, запуск `node dist/api/main.js` |
| `infra/agent-runner-api.service` | systemd-юнит (`@NODE@` подставляет deploy-скрипт) |
| `scripts/deploy-api-service.sh` | Деплой на VM: build → dirs → ключ → юнит → enable+start → health → auth-check → ufw |
| `scripts/runner-cli.mjs` | CLI: `submit/status/events/follow/result/cancel` против URL + ключа |

## Деплой

На VM из чекаута репо (git-операции — от пользователя `sandbox`, у root git ругается на dubious ownership):

```bash
runuser -u sandbox -- git -C /opt/sb/ai-agent-runner fetch origin
runuser -u sandbox -- git -C /opt/sb/ai-agent-runner checkout <ветка>
bash /opt/sb/ai-agent-runner/scripts/deploy-api-service.sh
```

Скрипт идемпотентен: при повторном запуске `npm ci` пропускается (если `node_modules` полный),
существующий API-ключ переиспользуется (**не печатается снова**), правило ufw не дублируется,
`ARTIFACT_SHARE_SECRET`/`ARTIFACT_BASE_URL` сохраняются, посторонние `KEY=value` в env-файле не затираются.
Опции: `--port`, `--rotate-key`, `--no-ufw`, `--help`.

## Конфигурация сервиса

`/etc/agent-runner/agent-runner-api.env` (mode `0600`, владелец `sandbox`):

| Переменная | Назначение |
|---|---|
| `AGENT_API_HOST` | слушать `0.0.0.0` |
| `AGENT_API_PORT` | `8787` (по умолчанию в коде — `DEFAULT_API_PORT`) |
| `AGENT_API_DATA_DIR` | durable store: `/var/lib/agent-runner` (создаётся deploy-скриптом, `0700`) |
| `AGENT_API_KEY_REGISTRY` | путь к key registry (`{principals:[{keyHash,principalId,profileId,scopes}]}`) |
| `AGENT_API_REGION`, `AGENT_API_ENVIRONMENT` | host-info в runner |
| `ARTIFACT_SHARE_SECRET` | HMAC-секрет share-токенов (генерируется при первом деплое) |
| `ARTIFACT_BASE_URL` | база для ссылок на артефакты: `http://169.58.15.230:8787` |
| `AGENT_API_ISOLATION_SLOTS`, `AGENT_API_ISOLATION_TOOL_PATHS` | граница Agent clean room (#51): пул Unix-слотов ран'а (`ta-agent-1,ta-agent-2`) и общие read-only каталоги бинарей. Пустой слот — движок под service UID, и capabilities объявляют это честно |
| `AGENT_API_ENGINE_CONFIG_DIR` | каталог хостовых шаблонов конфигурации движка: один read-only файл `<engine>.json` на движок. Копия кладётся в run-scoped `XDG_CONFIG_HOME` (владелец — слот, `0600`) и уезжает со sweep. Нужен потому, что своя HOME рана убирает у движка конфиг пользователя сервиса: без provider/model `opencode` уходит на платный профиль по умолчанию. Секретов в шаблонах нет — ключи приходят в env рана по `envAllowlist` |
| `AGENT_API_COHORT_ID`, `AGENT_API_COHORT_MODE`, `AGENT_API_COHORT_PRINCIPALS` | когорта P29: по умолчанию (`off`) **не обслуживает никого** — каждый `POST /v1/runs` получает `COHORT_NOT_ENABLED`. Одиночная установка обязана объявить allowlist с principal'ами, иначе она принимает ноль задач |
| `AGENT_API_FAKE_SCENARIO` | опционально: сценарий fake-движка (`success` по умолчанию, `timeout`, `nonzero-exit`, …) — для проверки аварийных путей; правится вручную в env-файле + `systemctl restart` |
| `AGENT_API_FAULTS` | опционально: управляемые точки сбоя для приёмки lifecycle (#52) — `cleanup` (сбой в момент уборки), `export`, `finalization`, … через запятую, `точка:count` задаёт число срабатываний (без `count` — один раз). Неизвестная точка валит старт: молча проигнорированная точка означала бы пробу, которая «прошла», ни разу не упав. В обычном сервисе переменная пуста |

Старт падает сразу и явно, если: не задан `AGENT_API_KEY_REGISTRY`, файла ключей нет или в нём 0 ключей,
data dir попал во временный каталог или имеет права шире `0700`.

### Capability юнита и граница clean room

Юнит даёт процессу ровно четыре capability: `CAP_SETUID`, `CAP_SETGID` (переключение
идентичности рана лаунчером) и `CAP_CHOWN`, `CAP_FOWNER` (каталоги среды создаются под
служебным uid и затем отдаются слоту). `CAP_DAC_OVERRIDE` в наборе нет намеренно: без него
создание каталога внутри уже отданного слота каталога было бы единственным способом
поднять границу, то есть цей границы стал бы обходом прав доступа. Если capability не
выданы, `capabilities.osIsolation` сообщает `configured_but_refusing_runs` → ран
отказывается, а не идёт под service UID.

## Безопасность

- **API без ключа не работает.** Анонимный запрос → `401 UNAUTHENTICATED` на всех маршрутах, кроме `GET /healthz`.
  `src/api/server.ts` аутентифицирует до разбора маршрута и тела.
- **Ключ генерируется при деплое** (`ak_` + 48 hex, тот же формат, что `generateApiKey()`), живёт только в
  `/etc/agent-runner/api-key` (mode `0600`, владелец `sandbox`) и **один раз** печатается в лог первого деплоя.
  В репо/доки/коммит ключ не попадает. Key registry (`/etc/agent-runner/key-registry.json`, `0600`) содержит
  только sha256. Отпечатать ключ заново: `sudo scripts/deploy-api-service.sh --rotate-key`.
- **Файлы:** `/etc/agent-runner` — `0755` (dir), `api-key`/`key-registry.json`/`agent-runner-api.env` — `0600 sandbox`;
  `/var/lib/agent-runner` — `0700 sandbox`; workspace рана — `0700`, артефакты рана — `0600` (`UMask=0077` в юните).
- **ufw:** правило `8787/tcp ALLOW Anywhere # agent-runner-api` ставится deploy-скриптом **только после**
  успешной проверки auth (аноним `401` + с ключом `404`); иначе скрипт падает и порт закрыт.
  `22/tcp` не трогается. Порт открыт миру — это осознанный выбор песочницы, внешний доступ даёт только ключ;
  **TLS на песочнице нет** (HTTP), для продакшена нужен терминирующий прокси/HTTPS.
- `GET /healthz` без auth отдаёт только `{status, ready, droppedLogCount, activeRuns, runs}` — без путей и секретов.
- Лог в journald — JSON-строки: method/path/status/durationMs/principalId, путь **без query-string** (share-токен в логи не попадает).

## CLI — `scripts/runner-cli.mjs`

```bash
export RUNNER_API_URL=http://127.0.0.1:8787
export RUNNER_API_KEY_FILE=/etc/agent-runner/api-key   # или RUNNER_API_KEY / --key

node scripts/runner-cli.mjs submit  --prompt "hi" --engine fake --timeout-ms 30000
node scripts/runner-cli.mjs submit  --file spec.json --idempotency-key <key>
node scripts/runner-cli.mjs status  <runId>
node scripts/runner-cli.mjs events  <runId> [--cursor N] [--limit N]
node scripts/runner-cli.mjs follow  <runId> [--timeout-ms N]   # SSE до терминального состояния, resume по cursor
node scripts/runner-cli.mjs result  <runId>
node scripts/runner-cli.mjs cancel  <runId> [--owner-generation N] [--reason text]
```

Подключение: `--url/--key/--key-file` либо env `RUNNER_API_URL/RUNNER_API_KEY/RUNNER_API_KEY_FILE`
(флаги важнее env). На stdout — JSON (у `follow` — NDJSON по событию), диагностика на stderr.
Exit codes: `0` успех · `1` ошибка API/сети · `2` ошибка использования · `3` `RESULT_NOT_READY`.

## Эндпоинты

| Метод | Путь | Auth |
|---|---|---|
| GET | `/healthz` | не нужен |
| GET | `/v1/capabilities` | Bearer (любой валидный ключ) — декларация возможностей |
| POST | `/v1/runs` (нужен `Idempotency-Key`) | Bearer + `runs:write` |
| GET | `/v1/runs/{id}/status`, `/events` (SSE при `Accept: text/event-stream`), `/result` | Bearer + `runs:read` |
| GET | `/v1/runs/{id}/artifacts` | Bearer + `runs:read` (манифесты только своего `profileId`) |
| POST | `/v1/runs/{id}/cancel` | Bearer + `runs:write` |
| GET | `/v1/artifacts/{id}[?t=share-token]`, `…/meta`, алиас `/artifact/{id}` | share-токен **или** Bearer + `runs:read` + совпадение `profileId` |

### Декларация возможностей (`GET /v1/capabilities`)

Приёмник (control plane) читает её вместо догадок о том, что умеет Runner — требование
`SERVERLESS-AGENT-API.md` («resume/checkpoint возможности не объявляются универсальными»):

```jsonc
{
  "schemaVersion": 1,
  "contract": { "name": "ai-agent-runner/serverless-agent-api", "version": 1 },
  "idempotency": { "header": "Idempotency-Key", "repeatWithSameKey": "same_receipt", "newAttemptRequires": "new_idempotency_key" },
  "states": ["queued", "starting", "running", "awaiting_user", "finalizing", "succeeded", "failed", "cancelled"],
  "events": { "cursor": true, "replay": true, "sse": true, "lastEventId": true },
  "disconnect": { "connectionLostIsNotFailed": true, "autoRerunOnDisconnect": false, "outcomeUnknown": true },
  "interaction": {
    "awaitingUserInput": "unsupported",     // ожидание ведёт control plane, не Runner
    "engineResume": "unsupported",          // --resume движка не поддержан
    "continuation": {                        // продолжение = НОВАЯ ПОПЫТКА, не повтор всей задачи
      "policy": "new_run_same_user_task",
      "userTaskIdStable": true,
      "conversationIdStable": true,
      "savedDataRefs": ["run_result", "run_events", "run_artifacts"]
    }
  },
  "artifacts": { "listPerRun": true, "download": true, "shareLink": true, "ingestEndpoint": "absent", "ingestNote": "…" },
  "cancel": { "requestedReceipt": true, "terminalConfirmation": true },
  "engines": ["fake", "opencode"]
}
```

Дополнительно, что видно из ответов и важно для приёмника:

- `status` возвращает `conversationId` — приёмник проверяет инвариант продолжения
  «новая попытка = новый `runId`, тот же `userTaskId` и тот же `conversationId`, `ownerGeneration` +1»
  (`test/api-contract-readiness.test.ts`);
- одна активная попытка на задачу: `submit` с новым ключом при активной попытке → `409 TASK_ATTEMPT_ACTIVE`
  (никаких параллельных ран одной задачи);
- `GET /v1/runs/{id}/artifacts` — ссылки на артефакты рана для шага 4 «результат и ссылки на артефакты»;
  манифесты фильтруются по `profileId` принципала, переживают restart процесса.

### Что считается выходом рана (issue #52, шаг 2)

Источников ровно два, третьего нет:

1. **Объявленные клиентом выходы** — `outputs` в `POST /v1/runs` (`spec.outputs`).
   Путь проверяется на выход из workspace в момент экспорта.
2. **Финальный манифест агента** — файл `.agent/final-manifest.json` в workspace рана:

   ```jsonc
   { "outputs": [{ "path": "report.md", "mime": "text/markdown" }], "answerFile": "answer.md" }
   ```

   Манифест читается после выхода движка. Дефект (не JSON, путь с `..`, дубль пути,
   больше 64 КБ) — это отказ манифеста **с причиной в журнале рана**, а не падение рана:
   объявленные клиентом выходы при этом сохраняются. При конфликте по пути выигрывает
   объявление клиента.

**Сканирование «вслепую» запрещено**: файлы, которые агент не объявил ни в манифесте, ни
клиент в `outputs`, в хранилище не попадают — ни из workspace, ни из HOME, ни из
конфигов и секретов.

**Текст ответа** сохраняется всегда, отдельным артефактом `answer.txt`
(`GET /v1/runs/{id}/artifacts`): источник — `answerFile` из манифеста, а если его нет —
хвост stdout движка. Текст продублирован в обязательном `checkpoint.json` рана
(`runs/<runId>/checkpoint.json`), поэтому он переживает sweep чистой среды даже на хосте
без object storage. В журнал рана попадают только источник и размер, не содержимое.

## Смоук на живой VM — факты прогона

### 1. Юнит и порт

```
$ systemctl is-enabled agent-runner-api   → enabled
$ systemctl is-active  agent-runner-api   → active
$ ps -o user,pid,args -p <MainPID>        → sandbox … /usr/local/bin/node /opt/sb/ai-agent-runner/dist/api/main.js
$ ss -lntp | grep 8787                    → LISTEN 0.0.0.0:8787  users:(("node",pid=…))
$ ufw status | grep 8787                  → 8787/tcp ALLOW Anywhere # agent-runner-api  (+ v6)
```

Стартовая строка журнала после финального рестарта (одним JSON, дословно):

```json
{"ts":"2026-10-01T07:31:10.614Z","event":"api_listening","host":"0.0.0.0","port":8787,"dataDir":"/var/lib/agent-runner","keyRegistry":"/etc/agent-runner/key-registry.json","keys":1,"engines":["fake","opencode"],"fakeScenario":"success","health":"/healthz","recovery":{"scanned":4,"resumedQueued":0,"orphaned":0,"lost":0,"terminal":4,"healed":0},"startedAt":"2026-10-01T07:31:10.614Z"}
```

### 2. Health

```
$ curl -s http://127.0.0.1:8787/healthz            # health-check первого деплоя, ранов ещё нет
{"status":"ok","ready":true,"droppedLogCount":0,"activeRuns":0,"runs":0}
$ curl -s -o /dev/null -w '%{http_code}' http://169.58.15.230:8787/healthz   # с машины оператора, через ufw
200
```

### 3. Auth-пробы (до и после открытия порта)

```
POST /v1/runs анонимно                        → 401
GET  /v1/runs/{id}/status анонимно            → 401
GET  /v1/runs/{id}/status с неверным ключом   → 401
GET  /v1/runs/run_deploy_probe/status с ключом → 404 (аутентифицирован, ран не найден — эта проверка стоит до ufw)
GET  /v1/artifacts/{id}/meta анонимно (снаружи)→ 401
```

### 4. Полный цикл рана через CLI

```
$ node scripts/runner-cli.mjs submit --prompt "sandbox smoke run" --idempotency-key smoke-vm-1
{"requestId":"req_bb7d712a-…","userTaskId":"task_24b97ec4-…","runId":"run_0fdd061d-14c3-42ea-b182-9393ff3564fa","deduplicated":false}

$ node scripts/runner-cli.mjs events run_0fdd061d… --limit 20 | jq
{"count":8,"hasMore":false,"cursor":8,"state":"succeeded",
 "types":["claimed","materialized","started","log","log","exit","finalizing","succeeded"]}

$ node scripts/runner-cli.mjs result run_0fdd061d…
{"outcome":"succeeded","exitReason":"completed","exitCode":0,"persistence":"persisted",
 "logPath":"runs/run_0fdd061d-14c3-42ea-b182-9393ff3564fa/events.jsonl"}
```

Повтор того же `--idempotency-key` → `{"runId":"…","deduplicated":true}` — второй ран не создаётся.

### 5. Перезапуск = данные живут

```
$ systemctl restart agent-runner-api
journalctl -u agent-runner-api -o cat:
{"ts":"2026-10-01T07:28:30.160Z","event":"recovered","scanned":1,"resumedQueued":0,"orphaned":0,"lost":0,"finalizingResumed":0,"terminal":1,"healed":0}
$ node scripts/runner-cli.mjs status  run_0fdd061d… → {"state":"succeeded","sequence":8}
$ node scripts/runner-cli.mjs result  run_0fdd061d… → {"outcome":"succeeded",…}
$ node scripts/runner-cli.mjs submit … --idempotency-key smoke-vm-2   → run_47656b48-… → succeeded
```

То есть admissions/result/events переживают рестарт за счёт `/var/lib/agent-runner`.

### 6. Артефакт: local-fs storage → ссылка → скачивание

Fake-движок положил `ran.txt` в workspace рана; артефакт положен в store той же storage-кодой,
которой пользуется сервис (ingest-эндпоинта в P04–P06 нет — это slice D2, поэтому put выполняется
операторским кодом из `dist/`). Команды ниже сокращены (`…`), вывод и суммы — дословно:

```
$ sha256sum /var/lib/agent-runner/workspaces/run_0fdd061d…/ran.txt
2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df   (mode 0600)

$ node --input-type=module -e "…ArtifactStore.put({runId, userTaskId, profileId:'profile-sandbox', name:'ran.txt', mime:'text/plain', bytes})"
{"artifactId":"art-535ece258f5024655f7b4bd5","runId":"run_0fdd061d-…","size":2,
 "sha256":"2689367b…","storageKey":"runs/run_0fdd061d-…/artifacts/art-535ece258f5024655f7b4bd5"}

$ curl -H "Authorization: Bearer $KEY" …/v1/artifacts/art-535ece258f5024655f7b4bd5/meta   → 200 manifest
$ curl -H "Authorization: Bearer $KEY" …/v1/artifacts/art-535ece258f5024655f7b4bd5       → 200
  x-artifact-sha256: 2689367b…, content-disposition: attachment; filename="ran.txt"
  sha256 скачанного файла == sha256 workspace, cmp — byte-for-byte OK

$ node --input-type=module -e "…ShareTokenIssuer({secret: ARTIFACT_SHARE_SECRET}).issue(id) → artifactSharePath(ARTIFACT_BASE_URL,…)"
http://169.58.15.230:8787/v1/artifacts/art-535ece258f5024655f7b4bd5?t=<token>
$ curl "$LINK"            → 200, x-artifact-sha256: 2689367b…, byte-for-byte OK (без ключа, только токен)

пробники: аноним meta → 401 · аноним download → 401 · неверный ключ → 401 · мусорный share-токен → 401
```

Дерево данных после смоука:

```
/var/lib/agent-runner/                 700 sandbox
├── api/admissions.json                600 sandbox
├── blobs/runs/<runId>/artifacts/<artId>          700 dirs / 600 file
├── runs/<runId>/                                700 sandbox
│   ├── state.json, result.json, events.jsonl    600 sandbox (пишет сервис, UMask=0077)
│   └── artifacts/<artId>.json                   600 sandbox
└── workspaces/<runId>/                          700 sandbox
```

Put артефакта в смоуке делался out-of-band-процессом (umask `022`) — права на файлы/каталоги blobs
после прогона выровнены под политику `0600/0700`. При записи из сервиса `UMask=0077` даёт `0600` сам;
вне `/var/lib/agent-runner` (`0700`) эти файлы всё равно недоступны третьим лицам.

### 7. Живой `follow` (SSE) + `cancel`

С `AGENT_API_FAKE_SCENARIO=timeout` (после прогона строка удалена и сервис перезапущен —
в логе снова `"fakeScenario":"success"`):

```
$ node scripts/runner-cli.mjs follow run_b2a63098-2e14-4e6d-a6d0-cf5c3c5bff3f > /tmp/f.ndjson &
$ node scripts/runner-cli.mjs cancel run_b2a63098… --reason "live follow demo"
{"runId":"run_b2a63098…","status":"stopped","state":"cancelled"}

$ wc -l < /tmp/f.ndjson   → 8
snapshot state=running seq=4 → claimed → materialized → started → log → exit → finalizing → cancelled
$ node scripts/runner-cli.mjs result run_b2a63098…
{"outcome":"cancelled","exitReason":"cancelled"}
```

`follow` переподключается с `last-event-id` при обрыве и завершается на терминальном событии/снапшоте;
на уже завершённом ране печатает один снапшот и выходит с кодом 0.

## Ограничения (честно)

- **TLS нет** — трафик HTTP, порт открыт миру; на песочнице это допустимо, на проде нужен прокси.
- **Ingest артефактов вне API**: `POST /v1/artifacts` нет (slice D2), поэтому put в смоуке выполняется
  операторским кодом; выдача share-ссылки — тоже на стороне оператора (`ShareTokenIssuer` + `ARTIFACT_BASE_URL`),
  эндпоинта выдачи ссылки в API нет.
- Смоук идёт на `fake`-движке; `opencode` в сервисе зарегистрирован и бинарь на VM есть
  (`/usr/local/bin/opencode`), но opencode-ран в этом прогоне не запускался.
- Смоук закрывает transport (runner#7): admission → события → результат → артефакт → ссылка/скачивание.
