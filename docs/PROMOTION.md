# Promotion и fleet acceptance (P29, этап I10)

Карточка [#68](https://github.com/trained-assist/trained-agent-architecture/issues/68),
эпик [E7](https://github.com/trained-assist/trained-agent-architecture/issues/23),
этап [SANDBOX · I10](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md#i10--promotion-совместимость-rueu),
правило 8 [ENGINEERING-APPROACH](https://github.com/trained-assist/trained-agent-architecture/blob/main/ENGINEERING-APPROACH.md)
(«test bindings/data не становятся production»).

Идея: промоушен здесь — не «выкатили и посмотрели», а **проверяемый переход с файлом состояния
на входе**. Один и тот же код обслуживает новую машину с кандидатным релизом и машину с
предыдущим; переключение между ними — две операции с записью причины в durable-журнал:
`rollback` (новые приёмы стопятся, обслуживает предыдущий релиз) и `resume` (снова кандидат).

## Модули

| Модуль | Ответ на вопрос |
|---|---|
| `src/release/manifest.ts` | Что именно запущено: `sourceCommit`, `configVersion`, host-манифест (workerId/region/environment/roles/roots/endpoint), env-манифест **только по именам binding'ов**, retention TTL. Валидация отказывает на «мягких» манифестах |
| `src/release/cohort.ts` | Кто в когорте: `off` / `allowlist` / `percentage`. Бакет детерминированный — одно решение на любом воркере и после рестарта |
| `src/release/promotion.ts` | Durable-журнал переходов, контроллер отката/возврата и `checkPromotionBoundary` — правило «эксперимент нельзя выдать за прод» |
| `src/release/dispatch-owner.ts` | Одна задача — один владелец. Общий для воркеров одной VM файл под file-lock; partition ≠ failover; прежний владелец после перехвата fenced |
| `src/release/retention.ts` | Retention-здоровье: что под очистку и какие нетерминальные раны защищены |
| `src/release/admission.ts` | Порядок отказов: откат → платный профиль → когорта → владение |

API: `GET /v1/release` (релиз, когорта, откат, retention, fleet — требует `auth` и `runs:read`),
блок `promotion` в `GET /v1/capabilities`, admission-логи с полями release/cohort.

Отказы видны и без чтения логов: `503 PROMOTION_PAUSED`, `403 COHORT_NOT_ENABLED`,
`403 PAID_PROFILE_DISABLED`, `409 TASK_OWNED_BY_OTHER_WORKER` — каждый без побочных записей.

## Прогон

```bash
npm ci && npm run build
scripts/recreate-sandbox.sh --namespace p29-$(date -u +%Y%m%d) --fleet-root "$PWD/.p29-fleet" --owner "$(id -un)"
node scripts/promotion-probe.mjs --fleet-root "$PWD/.p29-fleet" --namespace p29-… --out docs/evidence/p29-promotion
```

`recreate-sandbox.sh` создаёт **новый** namespace эксперимента: раздельные data/config корни
на воркер, свежие ключи (собственные, клиентский control plane и принципал вне когорты),
локальный fixture-репозиторий вместо сети, закреплённые манифесты (A = кандидат `r2`,
B = предыдущий `r1`, он же «прежний владелец» после отката), общий реестр владения.
Существующий namespace не переиспользуется, а откладывается в сторону: «чистое» здесь означает
«пустое», а не «снесённое». Всё, включая временный каталог фикстуры, остаётся внутри
fleet-root — `/tmp` проба не трогает.

`promotion-probe.mjs` поднимает два настоящих процесса `dist/api/main.js` и проходит 12 шагов:

1. `sandbox_fresh` — namespace создан заново, ключи воркеров различны, в provisioning-манифесте
   нет значений секретов;
2. `ports_free` — порты воркеров свободны до старта (иначе «воркер не поднялся» неотличимо
   от чужого сервиса на порту);
3. `workers_started` — релиз закреплён, `paidProfilesAllowed: false`, у новой машины выключены
   роли расписания и доставки;
4. `api_smoke` — приём → события → результат, цепочка событий без пропусков, повтор с тем же
   `Idempotency-Key` возвращает тот же receipt;
5. `channel_smoke` — Web и Telegram: `message id ↔ userTaskId ↔ requestId ↔ runId`;
6. `admission_controls` — управляемый отказ: принципал вне когорты и платный профиль, оба
   refused **до** запуска и с причиной в журнале;
7. `fleet_ownership` — второй воркер получает 409 вместо второй копии; молчание сети не
   failover; после явного `release` прежнего владельца новый владелец берёт задачу с
   поколением +1, прежний fenced;
8. `rollback_drill` — откат прогоном: принятая до отката задача **остаётся живой у прежнего
   владельца** и доигрывает там же, новые приёмы когорты дают 503, ранее принятые данные и
   реплей читаются при откате; затем `resume` возвращает кандидата;
9. `retention_and_config` — retention-здоровье, живые раны защищены, в `/v1/release` нет
   значения ключа;
10. `clean_promotion` — те же песочные артефакты нельзя объявить production (расходятся
    workerId/корни/endpoint/ключи), артефакты не вышли за пределы namespace;
11. `logs` — в каждой строке лога сервиса `releaseId`/`workerId`/`region`, `seq` журнала
    монотонный, виды переходов на месте;
12. `no_secrets` — значения ключей и share-секретов в транскрипте нет.

Проба останавливается на первом несоответствии (exit 1) и всегда гасит своих воркеров.

## Границы доказанного

- **Настоящее**: API, Runner, promotion-контур, реестр владения — реальные процессы на одной
  машине; движок `fake` (free-only).
- **Эмуляция**: каналы Web/Telegram — адаптеры ingress/egress внутри пробы (в external
  message id → `userTaskId` → результат с `runId`), живой бот и Web-UI не подменяются и не
  проверялись; платные модели не запускались — их отказ и есть проверка «paid off».
- **Сравнение с живым продом** недоступно с песочной VM: вместо него проверяется отказ
  объявить песочницу продом и изоляция ключей/корней. Прод не трогается.

## Что покрыто тестами

- [x] Манифест: pinned `sourceCommit`/`configVersion`, обязательный binding по имени без
  значения, `paid` только с `approvedBy` — `test/promotion-release.test.ts`
- [x] Когорта: детерминированный бакет, одно решение после рестарта — `test/promotion-release.test.ts`
- [x] Журнал: причины переходов, `seq` без дыр при двух писателях (сервис + операторский
  откат), повреждённая строка — `test/promotion-release.test.ts`
- [x] Граница промоушена: общий ключ, вложенные корни, общий endpoint, две машины-доставщика —
  `test/promotion-release.test.ts`
- [x] Владение: partition ≠ failover, fenced прежнего владельца, drain — `test/promotion-release.test.ts`
- [x] Retention ускоренным clock'ом — `test/promotion-release.test.ts`
- [x] Внешний контракт: auth и область `/v1/release`, отказы 403/503/409 без побочных записей,
  откат прогоном, два воркера на одной VM — `test/promotion-api.test.ts`
- [x] Проба на песочной VM2: 59/59, транскрипт `docs/evidence/p29-promotion-vm2/`
