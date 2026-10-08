# Serverless Agent API — деплой, конфигурация, смоук

Статус документа: **05.10.2026, асинхронный контракт запуска (эпик #74, контракт #73).**
В базовом режиме API обслуживает ран без локального workspace. Режим постоянного профиля
включается отдельными bindings: журнал и зеркала хранятся на устойчивом диске API,
канонические данные — в приватном Git и GCS. API не запускает процесс агента. Он стоит
между клиентом и внешним воркером: `POST {worker}/v1/launch` даёт квитанцию сразу, дальше
наш поллер сам читает `status` и `result`.

Одно исключение: **журнал приёмных записей** (`AGENT_API_ADMISSION_LOG`, §2 и §7). Его
требует контракт воркера (п. 2) — дедупликация по `Idempotency-Key` обязана переживать
рестарт API. Без него API работает, но после рестарта не помнит ни о принятых задачах, ни о
ранах, которые воркер уже выполняет.

Предыдущая версия документа описывала API с durable store `/var/lib/agent-runner`, локальным
`spawn` движков и recovery после `kill -9`. Этих вещей в сервисе больше нет.

---

## 1. Что в репо

| Модуль | Файл | Роль |
|---|---|---|
| HTTP-сервис | `dist/api/main.js` | читает env, поднимает `node:http`, состояние ранов — в памяти |
| Ядро | `src/api/service.ts` | приём запроса, идемпотентность, launch → квитанция, поллер `status`/`result`, маппинг результата |
| Память процесса | `src/api/stateless-store.ts` | приёмные записи, прогресс ранов, события, лимиты и TTL; по журналу — восстановление после рестарта |
| Адаптер воркера | `src/adapters/external-worker-adapter.ts` | `POST {worker}/v1/launch` → `LaunchReceipt`, опрос `GET {worker}/v1/runs/{id}/status`, выдача `GET .../result`, отмена `POST {worker}/v1/runs/{id}/cancel` |
| Маршруты | `src/api/server.ts` | `/healthz`, `/v1/capabilities`, `/v1/runs…` |
| Юнит | `infra/agent-runner-api.service` | systemd, `User=sandbox`, `ProtectSystem=full` + `ReadWritePaths` только на каталог журнала |
| Деплой | `scripts/deploy-api-service.sh` | build → config dir → API-ключ → адрес воркера → журнал → юнит → health → auth → ufw |
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
| `EXTERNAL_WORKER_URL` | базовый URL внешнего воркера (`http(s)://…`) — одиночный воркер |
| `EXTERNAL_WORKER_TOKEN` | общий секрет; уходит в `Authorization: Bearer …` |

Либо реестр движков вместо одиночного воркера:

| Переменная | Смысл |
|---|---|
| `AGENT_API_WORKERS` | JSON-список `[{engine, baseUrl, token}]`; `submit` выбирает воркер по `request.engine.name`, неизвестное имя → `ENGINE_NOT_ALLOWED`. Переопределяет `EXTERNAL_WORKER_*` |

Принимаются также имена из ТЗ воркера — `DYNAMIC_IP_AZURE_URL` / `DYNAMIC_IP_AZURE_TOKEN`,
но `EXTERNAL_WORKER_*` приоритетнее.

Необязательное:

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `AGENT_API_HOST` / `AGENT_API_PORT` | `0.0.0.0` / `8787` | адрес прослушивания |
| `EXTERNAL_WORKER_ENGINE` | `azure-dynamic-ip-agent-run` | имя движка для одиночного воркера: им API отвечает в `/healthz` и `/v1/capabilities` |
| `AGENT_API_ENV` | `{}` | JSON-пул значений окружения; в воркер уходят только те, что перечислил клиент в `envAllowlist` |
| `AGENT_API_WORKERS` | — | JSON-список `[{engine, baseUrl, token, acceptDeadlineMs?}]` — несколько движков |
| `AGENT_API_ENGINE_CHAIN` | — | приоритетная цепочка движков через запятую, в порядке проб (issue #100) |
| `EXTERNAL_WORKER_ACCEPT_DEADLINE_MS` | `30000` | бюджет ожидания квитанции на движок; не ответил — цепочка берёт следующий |
| `RUNNER_DEFAULT_REPO` | — | `owner/name` для клиентов, не объявивших `repository` |
| `AGENT_API_ADMISSION_LOG` | — (выключено) | путь журнала приёмных записей; в режиме профиля обязателен, пишет также подготовленную версию, намерение запуска и терминальный результат |
| `AGENT_API_PROFILE_WORKSPACE_ROOT` | — (выключено) | включает постоянный профиль для каждого Run; устойчивый каталог журнала и bare-зеркал Git |
| `AGENT_API_PROFILE_OWNER` | — | организация приватных репозиториев профиля; обязательна при включении профиля |
| `AGENT_API_PROFILE_GITHUB_TOKEN` | — | хостовый токен GitHub для ensure/fetch/publish; не попадает в агентское окружение или журнал |
| `AGENT_API_PROFILE_DELEGATION_SECRET` | — (выключено) | HMAC secret для короткоживущей host-to-API `(principal, tenantId, profileId, expiry)` capability; обязателен для CP delegated profiles, хранится только в API и CP secret stores |
| `AGENT_API_PROFILE_OBJECT_BACKEND` | `gcs` | хранилище тяжёлых файлов; `local-fs` только для локального fixture, GCS использует `GCS_BUCKET` и ADC |
| `GCP_PROJECT` / `GOOGLE_CLOUD_PROJECT` | — | ID проекта GCS; задавайте явно при Workload Identity Federation, чтобы чтение метаданных объекта не запрашивало доступ к Cloud Resource Manager |
| `AGENT_API_PUBLIC_URL` | `http://<host>:<port>` | публичная база API: воркер возвращает результат на `POST {resultUrl}`. Можно задать префикс reverse proxy (например, `https://runner.example/profile-api`); proxy должен передавать callback-маршруты `/v1/worker/launches/{runId}/result` и `/profile-changes` в API без изменения пути. Без URL запуск падает с `RESULT_URL_UNSET` |
| `EXTERNAL_WORKER_LAUNCH_DEADLINE_MS` | `600000` | таймаут опроса `status`/`result`; заодно бюджет приёма, если у движка не задан `acceptDeadlineMs` |
| `EXTERNAL_WORKER_CANCEL_DEADLINE_MS` | `30000` | таймаут ожидания подтверждения отмены |
| `EXTERNAL_WORKER_RECONCILE_DEADLINE_MS` | `5000` | бюджет проверки «знает ли воркер этот ран» перед переходом к следующему движку (#100); мёртвый движок не должен вешать проверку на таймаут запуска |

Журнал приёмных записей пишется построчным JSON рядом с ключом API и адресом воркера, а сам
путь приходит из `process.env`, а не из `AGENT_API_ENV`: `AGENT_API_ENV` уходит воркеру в
каждом ране по `envAllowlist`, и путь журнала не должен попасть в процесс агента. Если журнал
недоступен, обычный режим пишет `console.warn` (`persist failed`), а режим профиля отказывает
в приёме или переходе состояния: подготовка и публикация профиля требуют durable журнал.

В режиме профиля ключ API должен содержать доверенный `tenantId` и `profileId`. Клиентский
`repository` отклоняется: binding выбирает хост. Перед launch API вызывает
`prepareProfileWorkspace`, материализует только export manifest в архив `tar.gz`,
загружает его в приватный GCS и передаёт воркеру подписанную ссылку с SHA-256 и размером.
Архив включает также проверенные байты больших объектов; воркеру не нужен общий доступ
к GCS для чтения профиля.

Доверенный Control Plane может переключить profile для конкретного запроса только при
настроенном `AGENT_API_PROFILE_DELEGATION_SECRET`: он прикладывает короткоживущую HMAC
capability, связавшую API-key principal, неизменяемый tenant из API-key registry,
делегированный `profileId` и expiry. API проверяет подпись, tenant equality, срок и форму
до приёма Run. Capability не разрешает выбирать owner или `repository.fullName`; owner
выводится из host-only tenant route, а repository — из profile workspace binding.
Без secret запрос с delegated headers отказывает; обычная не-delegated profile авторизация
не меняется. Secret не записывается в admission journal и не передаётся воркеру.

Воркер не получает GitHub token и не клонирует/пушит репозиторий профиля. Он загружает
изменённые байты через `POST /v1/worker/launches/{runId}/profile-changes?path=...` с
одноразовой write-only Bearer capability конкретного run и заголовком
`x-content-sha256`. API проверяет run/profile binding, безопасный путь, export policy,
срок действия и checksum, затем принимает итоговый allowlisted `profileChanges` manifest.
Эта capability может только положить файл в staging своего run: она не читает профиль,
не выбирает репозиторий и не вызывает GitHub. API-side `WorkspaceService` восстанавливает
закреплённую базовую ревизию, применяет изменения/удаления и публикует canonical merge
имеющимся хостовым `AGENT_API_PROFILE_GITHUB_TOKEN`. Статус публикации и конфликты остаются
явными; конфликт блокирует следующий Run профиля. Большие изменённые файлы проходят ту же
export policy и сохраняются как object-store artifacts с ref/checksum; байты доступны через
авторизованный `GET /v1/runs/{runId}/artifacts?path=...`.

Export policy остаётся границей для PII/секретов: исключённые credential/runtime-state пути
не материализуются и не публикуются. Остальные файлы профиля, привязанного к principal,
доступны в рамках его запуска. Snapshot URL истекает через два часа; saveback capability —
через сутки. Capability хранится на API как hash, а подписанный URL и bearer не записываются
в admission journal. API принимает файлы до 100 MB каждый и не более 256 MB на run.

Для включения режима профиля API нужны `AGENT_API_PROFILE_WORKSPACE_ROOT` на постоянном
томе, `AGENT_API_ADMISSION_LOG` на том же постоянном томе, `AGENT_API_PROFILE_OWNER`,
`AGENT_API_PROFILE_GITHUB_TOKEN`, `AGENT_API_PROFILE_OBJECT_BACKEND=gcs`, `GCS_BUCKET`
и `GCP_PROJECT` (либо `GOOGLE_CLOUD_PROJECT`) при WIF.
Для внешнего Runner profile snapshot storage должен поддерживать signed HTTPS download
URL; production-конфигурация — GCS. `local-fs` остаётся только для локальных операций
WorkspaceService и не может обслужить внешний snapshot.
Ключи в `AGENT_API_KEY_REGISTRY` должны задавать `tenantId` и `profileId`. France VM и
GHA worker используют один snapshot/saveback-контракт: обе среды получают подписанный
snapshot и run-scoped capability, загружают изменения в API, а публикацию в Git выполняет
только API. Ни VM, ни GHA не нужны GitHub credentials или GCS Workload Identity. Воркеры
выбираются по обычной цепочке France → Russia → GHA; VM старой версии обязана вернуть
`501 WORKER_PROFILE_WORKSPACE_UNSUPPORTED` до admission, после чего API может безопасно
перейти к следующему движку. После admission переключения нет. Перед включением France
первым слотом нужно обновить VM до сборки с `supportsProfileSaveback()` и проверить live
snapshot → изменение/удаление → API publication → следующий snapshot.

Переменных данных больше нет: `AGENT_API_DATA_DIR`, `ARTIFACT_SHARE_SECRET`,
`ARTIFACT_BASE_URL`, `AGENT_API_RELEASE_MANIFEST`, `AGENT_API_FAULTS` сервис не читает.

---

## 3. Эндпоинты

| Метод и путь | Что делает |
|---|---|
| `GET /healthz` | единственный маршрут без ключа: `{status, workers: [{engine, baseUrl}], runs, admissions, events}` |
| `GET /v1/capabilities` | декларация возможностей (см. §5) |
| `POST /v1/runs` | приём: `Idempotency-Key` обязателен; `202` — новый receipt, `200` — дедуп |
| `GET /v1/runs/{id}/status` | состояние рана, курсор событий, `answer` агента |
| `GET /v1/runs/{id}/result` | `RunResult` после терминального состояния, иначе `409 RESULT_NOT_READY` |
| `GET /v1/runs/{id}/events` | страница событий (`?cursor=&limit=`) либо SSE на `Accept: text/event-stream` |
| `GET /v1/runs/{id}/artifacts` | ветка рана, ссылка на merge, ссылки на файлы по коммиту и `logUrl` |
| `GET /v1/runs/{id}/log` | `302` на ссылку лога в Google Storage |
| `POST /v1/runs/{id}/cancel` | пробрасывает отмену воркеру; `202` — принята, `200` — уже терминальный |

Для `eu-vm-agent-run` и `rf-vm-agent-run` центральный `/events` также зеркалит stdout/stderr
из replayable worker SSE, пока агент работает. Worker cursor переживает разрыв соединения,
а API cursor (`Last-Event-ID` или `?cursor=`) позволяет клиенту продолжить свой поток. При
настроенном `AGENT_API_ADMISSION_LOG` worker source cursor и следующий API event ID сохраняются
в том же журнале, поэтому перезапуск API продолжает tail с последней принятой строки. Перед
финализацией API повторно читает terminal tail с этого cursor: stdout/stderr, пришедшие на
границе завершения, не теряются. Уже зеркалированные строки сверяются с полным результатом,
чтобы не добавлять их повторно. У воркеров без этого VM endpoint stdout/stderr остаются
доступны в финальных событиях.

Маршрутов ниже больше нет: `/v1/runs/{id}/export`, `/v1/runs/{id}/upload`,
`/v1/runs/{id}/upload-session/{sid}`, `/v1/runs/{id}/snapshot`,
`/v1/runs/{id}/snapshot-file/{sid}`, `/v1/artifacts/{id}`, `/v1/release`,
`/v1/capabilities/invoke`. Они либо писали на диск, либо отдавали байты.

---

## 4. Жизненный цикл рана

```
POST /v1/runs   → 202 receipt              память: AdmissionRecord + события claimed/inputs_materialized
               →  POST {worker}/v1/launch  по приоритетной цепочке движков (§5): воркер клонирует
                                          репозиторий и запускает агента
               →  LaunchReceipt             {runId, operationId, status: accepted, statusUrl, resultUrl}
               →  журнал: строка dispatched  рано: отметка пишется ДО старта поллера
               →  GET {worker}/v1/runs/{id}/status   поллер нашего API, пауза 500 мс × 2^n, потолок 10 с
               →  GET {worker}/v1/runs/{id}/result    после терминального статуса (409 → ещё рано)
               →  память: state terminal, logUrl, artifacts[], repo
```

Длинного запроса, который надо обрывать, в API нет: `launch` — короткий HTTP-обмен квитанцией,
всё остальное — наш собственный опрос. Отсюда и смысл его таймаута: воркер не принял задачу.

**События.** `claimed` и `inputs_materialized` пишутся при приёме, до сетевого вызова; остальные
события приходят с результатом от воркера. Поэтому журнал не пуст, пока воркер думает, и клиент
отличает «принято» от «потеряно».

**Бюджет и `unknown`.** Поллер живёт `limits.timeoutMs + 60 с` (`resultGraceMs`). Это не
дедлайн рана, а граница нашего терпения: по её исчерпанию ран переходит в `unknown`, а опрос
продолжается — воркер помнит `operationId`, поэтому повторный запуск невозможен, а результат
всё ещё можно забрать. Так же ран уходит в `unknown`, если воркер сам ответил `unknown` или если
`status` вернул «терминальный», а `result` ответил 409 (`result_missing`). `unknown` — не `failed`:
задача не потеряна и авто-rerun не происходит.

**Отмена.** Гонки «отмена раньше регистрации рана» больше нет: квитанция приходит только после
того, как воркер принял и зарегистрировал ран, поэтому отмена всегда уходит в уже известный
ран. Внутренние повторы доставки общие для любого HTTP-обрыва (3 попытки, 40 мс). Ответы
воркера: `cancelled` → `stop_pending`, `unknown_run` → `rejected` («воркер не зарегистрировал
ран, отмена не доставлена»), `rejected` → `rejected` с причиной. Stale `ownerGeneration` →
`409 STALE_OWNER_GENERATION`.

**Отказ воркера.** Отказ на границе воркера ран обязан получить, но «запрос не дошёл» и
«не доказано, что дошёл» — разные вещи. Поэтому ошибка `launch` делится на два класса:

- **Отказ на нашей стороне** (пре-флайт: нет промпта, `input.refs` без workspace, для
  движка не настроен воркер) — проверять нечего: ран финализируется сразу, и цепочка не
  тратит на него бюджеты следующих движков.
- **Неопределённый отказ** (таймаут, обрыв, HTTP-ошибка, тело вне контракта) — запрос мог
  дойти, а ответ потеряться. Ран переходит в `unknown`, и сервис спрашивает воркер о ране,
  прежде чем что-то решить (см. ниже).

Коды причины:

| Код | Когда | `retryable` |
|---|---|---|
| `WORKER_NOT_CONFIGURED` | для этого движка не настроен адрес воркера | `false` |
| `WORKER_LAUNCH_UNREACHABLE` | таймаут или обрыв `POST /v1/launch` | `true` |
| `WORKER_HTTP_ERROR` | воркер ответил не-2xx на launch | `true` |
| `WORKER_PROTOCOL_INVALID` | тело ответа вне контракта | `true` |
| `WORKER_UNREACHABLE` | прочие транспортные отказы, в том числе при обрыве опроса или выдачи результата | `true` |
| `ENGINE_FLEET_EXHAUSTED` | ни один движок цепочки не принял ран; в `details` перечислены все попытки с кодами | `true` |

Пре-флайт-отказ клиента (`input.refs`, нет промпта) сохраняет свой код и `retryable: false`.
Отдельного кода для таймаута запуска в сервисе нет: таймаут — это
`WORKER_LAUNCH_UNREACHABLE`.

**Потерянная квитанция ≠ отказ рана.** Таймаут или обрыв `launch` не доказывает, что ран не
начался: запрос мог дойти, воркер мог зарегистрировать и запустить агента, а ответ
потеряться по дороге. Порядок по контракту (п. 4):

1. Ран переходит в `unknown` — не в `failed`.
2. Сервис один раз спрашивает `GET {worker}/v1/runs/{id}/status` по уже отправленному
   `runId`. Новый `launch` не отправляется никогда: воркер помнит запуски по `operationId`.
3. Воркер видит ран — отметка `dispatched` пишется в журнал, поллер доводит ран до
   терминала, результат забирается штатно.
4. Воркер не видит ран — терминальный `failed` с исходным кодом отказа. В цепочке это
   разрешение перейти к следующему исполнителю, а не отказ (см. ниже).
5. Спросить не удалось — ран остаётся `unknown`, клиент решает сам.

Цепочка движков (§5) использует тот же вопрос как разрешение на переход: следующий
исполнитель вызывается только если текущий подтвердил, что ран ему не известен. `runId` и
`operationId` при переходе не меняются, поэтому дедупликация воркера работает и после
перехода; текущая попытка видна клиенту сразу, а не молча подменяет исполнителя под ногами
у того, кто опрашивает статус.

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

- `engines` — отсортированный список имён воркеров из конфига (`AGENT_API_WORKERS` или
  `EXTERNAL_WORKER_ENGINE`), а не один захардкоженный движок;
- `engineSelection.chain` — приоритетная цепочка движков в порядке проб
  (`AGENT_API_ENGINE_CHAIN`, issue #100); пустая — цепочка не объявлена;
- `engineSelection.engineOptional: true` — клиент может не называть движок, тогда работает
  цепочка; названный движок — ровно один кандидат, без переходов;
- `engineSelection.retryOnlyWhenUnaccepted: true` — следующий исполнитель пробуется только
  когда текущий подтвердил, что ран ему не известен;
- `engineSelection.relaunchAfterReceipt: false` — повторный `launch` после потери квитанции
  не отправляется никогда;
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
  переключать Unix-идентичность больше нечего. Единственный путь на запись — каталог журнала
  (`StateDirectory=agent-runner` + `ReadWritePaths=/var/lib/agent-runner`); всё остальное
  процесс писать не может.
- **Firewall.** `deploy-api-service.sh` открывает порт только после успешной auth-пробы
  (анонимный `POST /v1/runs` → 401, с ключом `GET /v1/runs/<unknown>/status` → 404).

---

## 7. Деплой

```bash
sudo scripts/deploy-api-service.sh --worker-url https://worker.example --worker-token "$TOKEN" \
  --admission-log /var/lib/agent-runner/admissions.jsonl
# или с переменными окружения:
sudo EXTERNAL_WORKER_URL=https://worker.example EXTERNAL_WORKER_TOKEN="$TOKEN" \
  AGENT_API_ADMISSION_LOG=/var/lib/agent-runner/admissions.jsonl scripts/deploy-api-service.sh
```

Скрипт: `npm ci` → `npm run build` → `/etc/agent-runner` → API-ключ `0600` → env-файл с
адресом и токеном воркера → каталог журнала `0700` на сервисного пользователя → юнит →
`systemctl enable --restart` → `GET /healthz` → auth-проба → ufw.

Журнал — единственное, что сервис пишет на диск, и его требует контракт воркера (п. 2).
Без `--admission-log` скрипт печатает предупреждение: дедупликация по `Idempotency-Key` и
опрос уже принятых ранов не переживут рестарт. Путь журнала по умолчанию —
`/var/lib/agent-runner/admissions.jsonl` (`JOURNAL_DIR`), и именно этот каталог юнит разрешает
на запись; другой путь нужно добавить в `ReadWritePaths` в `infra/agent-runner-api.service`,
иначе журнал не откроется и процесс будет деградировать молча (§2).

---

## 8. Смоук на живой VM

```bash
export RUNNER_API_URL=http://127.0.0.1:8787 RUNNER_API_KEY_FILE=/etc/agent-runner/api-key

curl -s $RUNNER_API_URL/healthz | jq .                # status, workers: [{engine, baseUrl}], runs, admissions, events
node scripts/runner-cli.mjs submit --prompt "напиши отчёт в report.md"   # 202 + receipt
node scripts/runner-cli.mjs follow <runId>            # SSE до терминального события
node scripts/runner-cli.mjs result <runId> | jq .     # outcome, outputRefs (ссылки на GitHub), logPath (GCS)
curl -s -H "Authorization: Bearer $KEY" $RUNNER_API_URL/v1/runs/<runId>/artifacts | jq .
```

Приёмка приёма воркера на dev-стенде описана в `test/e2e-loop.test.ts`: поднимается мок
воркера, и проверяется полный путь submit → launch → result → артефакты → logUrl.

---

## 9. Ограничения (честно)

- **Состояние в памяти, кроме журнала.** Без `AGENT_API_ADMISSION_LOG` рестарт процесса =
  потеря ранов: клиент повторяет submit с новым `Idempotency-Key`, а раны, уже принятые
  воркером, теряют опрос и результат. С журналом дедупликация по ключу переживает рестарт, а
  раны, отмеченные `dispatched`, снова под опросом при старте. Это задокументированный
  контракт, а не авария, но он требует настройки из §7.
- **Лимиты памяти.** `maxRuns` (500), `maxEventsPerRun` (2000), TTL терминальных ранов (1 час);
  при переполнении самые старые терминальные раны выбрасываются. События сверх лимита
  учитываются в `droppedEvents`, а не молча теряются.
- **Потерянная квитанция видна только в логе API.** Перевод рана в `unknown` при потере ответа
  на `launch` пишется в журнал процесса, но не в события рана: клиент, читающий только
  `/events`, не увидит причину. Это оставшаяся часть **#92** (п. 2 приёмки); код готов на
  ветке `fix/92-reconcile-launch-timeout` (PR #123 закрыт как дубликат).
- **TLS нет.** На песочнице допустимо, на проде нужен прокси или Cloudflare Worker.
- **Open question ТЗ §13.1** (CF Worker или тонкий VM) не решена: до решения API разворачивается
  как stateless-процесс на VM, и `infra/agent-runner-api.service` — временная обвязка.
- **`RUNNER_DEFAULT_REPO`** обязателен для клиентов без `repository`, иначе воркер не сможет
  клонировать репозиторий.
