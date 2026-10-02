# Сквозной сценарий шага 7 (M1) — control plane ↔ Runner

Сценарий из [эпика M1 #109](https://github.com/trained-assist/trained-agent-architecture/issues/109), шаг 7
(«Sandbox Web и сквозная приёмка») со стороны Runner: пять реплик одной conversation, уточнение
пользователя, рестарт исполнителя посередине, продолжение с сохранённым контекстом, терминальный
результат и артефакт, доступный после восстановления.

Драйвер: `scripts/m1-step7-conversation-e2e.mjs`. Он играет роль control plane: держит `conversationId`,
историю ходов, **ожидание ответа пользователя** и решает, когда отправить попытку. Runner ничего не знает
про разговор — он исполняет одну попытку за раз.

## На чём стоит сценарий (декларация, а не догадки)

Всё берётся из `GET /v1/capabilities`:

| Декларация | Как используется в сценарии |
|---|---|
| `interaction.engineResume = unsupported` | продолжение = **новая попытка**, а не `--resume` движка |
| `interaction.awaitingUserInput = unsupported` | ожидание ответа ведёт control plane (`awaitingInputId` в его сторе), живой процесс ран не держится |
| `interaction.continuation.policy = new_run_same_user_task` | новая попытка: новый `runId`, тот же `userTaskId` и `conversationId`, `ownerGeneration + 1` |
| `interaction.continuation.savedDataRefs` | сохранённый контекст = `run_result` + `run_events` + `run_artifacts` предыдущих попыток |
| `disconnect.autoRerunOnDisconnect = false` | рестарт посреди попытки **не** запускает второй ран; продолжение — только явным новым `Idempotency-Key` |
| `idempotency.repeatWithSameKey = same_receipt` | «потерянный HTTP-ответ» воспроизводится и проверяется: повтор submit = тот же `runId` |

## Подключение control plane (секреты только через env, в репо ничего)

```bash
# на песочной VM (или где развёрнут Runner API)
export RUNNER_API_URL=http://127.0.0.1:8787
export RUNNER_API_KEY_FILE=/etc/agent-runner/api-key     # 0600, ключ в SM не дублируется
# альтернатива: export RUNNER_API_KEY=ak_...             # не писать в файлы репозитория

# сценарий целиком: рестарт сервиса посреди попытки хода 3
node scripts/m1-step7-conversation-e2e.mjs \
  --restart-mode service --repo-dir /opt/sb/ai-agent-runner \
  --report /var/lib/agent-runner/step7-report.json
```

Из Web adapter (control plane) те же вызовы идут по HTTP: `POST /v1/runs` (+`Idempotency-Key`),
`GET /v1/runs/{id}/{status,events,result,artifacts}`, `GET /v1/capabilities`, `POST /v1/runs/{id}/cancel`.

## Управляемый сбой (controlled failure)

| `--restart-mode` | Что рвётся | Как восстанавливается |
|---|---|---|
| `service` | `systemctl restart agent-runner-api` посреди попытки хода 3 (нужен root на VM) | сценарий ждёт `/healthz`, затем терминал попытки, полный replay событий и dedup |
| `vm` | `systemctl reboot` — сценарий печатает команду продолжения и выходит `75` | `node <script> --resume --journal <path> --report <path>` после загрузки |
| `none` | без сброса (для CI/быстрой проверки) | проверяется инвариант попытки и awaiting input |

Попытку хода 3 сценарий удерживает в полёте через `AGENT_API_FAKE_SCENARIO=timeout` (движок не завершается
сам), затем возвращает `success` перед явной попыткой-продолжением.

## Что проверяется (все checks — PASS/FAIL в отчёте)

1. декларация capabilities совпала с ожиданиями сценария;
2. ходы 1–2: приём, терминал; потерянный ответ → повтор submit = тот же `runId` (идемпотентность шага 2);
3. открыто ожидание ответа пользователя (`awaitingInputId`, живой процесс не держится);
4. ход 3: ответ → попытка в полёте → управляемый сбой → после восстановления ран терминален, replay
   событий полный (один `claimed`), повтор submit = тот же `runId`;
5. **явная новая попытка продолжения**: новый `runId`, тот же `userTaskId`/`conversationId`, успех,
   сохранённые данные (refs предыдущих попыток, refs артефактов) переданы в prompt; ожидание закрыто
   ровно один раз;
6. ходы 4–5: диалог продолжается после восстановления, терминальный успех;
7. артефакт: out-of-band ingest (в репо нет `POST /v1/artifacts`, slice D2) → виден в
   `GET /v1/runs/{id}/artifacts` после восстановления, байты совпадают с манифестом, повторное чтение
   идемпотентно, share-ссылка отдаёт байты без ключа (токен в отчёт не пишется);
8. пять реплик одной conversation; в каждом ходе — ключи событий и причина перехода
   (`profileId`/`userTaskId`/`runId`/`ownerGeneration`/reason), как требует эпик к логам.

Отчёт: `--report <path>` (JSON, все credentials вычищены), прогресс-журнал для resume: `--journal <path>`.

## Регрессия

`test/m1-step7-scenario.test.ts` гоняет сценарий против живого HTTP-контракта в режиме
`--restart-mode none --no-artifact` (без systemd и без `dist/`) и фиксирует инварианты: пять ходов одной
conversation, awaiting input израсходован один раз, продолжение = новый `runId` с тем же
`userTaskId`/`conversationId`, ключи событий в каждом ходе, credentials отсутствуют в отчёте и stdout.
Отдельно покрыта resume-ветка: `--resume` без записи `begin` отклоняется (exit 2), а по журналу
завершённого прогона восстанавливает `conversationId` (а значит и idempotency-ключи).

Управляемый сбой и артефакт проверяются на песочной VM (root + `--repo-dir` с `dist/`).

## Прогоны на песочной VM (02.10.2026, main)

| Режим | Результат | Отчёт |
|---|---|---|
| `--restart-mode service` (рестарт `agent-runner-api` посреди попытки хода 3) | **PASS 23/23** | `/var/lib/agent-runner/step7-report-04.json` |
| `--restart-mode vm` (полный `systemctl reboot` + `--resume` после загрузки) | **PASS 21/21** | `/var/lib/agent-runner/step7-report-07.json` |

Прогон `vm`: рестарт VM посреди попытки `run_193be778…` → после загрузки ран терминален
(`failed`/`WORKER_CRASH`), replay событий полный (`claimed→materialized→started→log→exit→finalizing→failed`,
`claimed` ровно один), повтор submit = тот же `runId` (`deduplicated: true`); продолжение — **новая
попытка** `run_4762fa19…` (тот же `userTaskId`/`conversationId`, `ownerGeneration+1`, `succeeded`);
ожидание `await-3c114c5d` закрыто ровно один раз этой попыткой; артефакт `art-7a48d97c…`
(sha256 `2689367b…`) виден в `GET /v1/runs/{id}/artifacts` после восстановления, байты совпадают с
манифестом, share-ссылка отдаёт байты без ключа. Сырой API-ключ: 0 вхождений в отчёте, журнале и
journalctl; share-токен в отчёт не пишется.

**Что сценарий выловил на живой VM (и почему важно гонять его, а не только тест):** за итерацию были
найдены и исправлены четыре дефекта сценария, которые юнит-тест в режиме `none` не заходил —
`ReferenceError` в ветке сброса, конфликт ключей при перезапуске, смена fake-сценария без рестарта
сервиса, проба дедупа с другим payload и потеря идентичности прогона при `--resume`. Три из них
закрыты регрессиями в CI. Продуктовый код при этом не менялся: все четыре раза поведение API было
корректным.

