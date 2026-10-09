> **Статус (epic #74).** Fleet/placement-политика не входит в stateless API (см. `docs/API-SERVICE.md`,
> раздел «Ограничения»). Документ описывает доставленную функциональность библиотеки
> `src/release/`; проба `scripts/p30-fleet-probe.mjs` и workflow `p30-fleet-probe.yml` удалены.
>
> Исключение — приоритетная цепочка движков (issue #100): порядок проб по конфигу
> `AGENT_API_ENGINE_CHAIN`, переход только при отсутствии квитанции. Это не placement-политика:
> регионы, провайдеры и резидентность она не проверяет, а лишь выбирает исполнителя, который
> ответил квитанцией первым.
# Multi-worker/region contract (P30, этап I10)

> **Legacy planning document.** Its France → Russia → GHA routing chain is not the current
> sandbox runtime. Current Runner API dispatch is pinned to the France VM worker with no GHA
> fallback; see [CLOUDFLARE-RUNNER-API.md](CLOUDFLARE-RUNNER-API.md).

Карточка [#69](https://github.com/trained-assist/trained-agent-architecture/issues/69),
эпик [E7](https://github.com/trained-assist/trained-agent-architecture/issues/23),
этап [SANDBOX · I10](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md#i10--promotion-совместимость-rueu),
[ARCHITECTURE §8](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md#8-регионы-credentials-и-стоимость)
(«Router выбирает worker, Runner повторно проверяет region/policy compatibility»).

Идея: при нескольких воркерах решение «кто вообще может выполнить этот запрос» принимается до
запуска и записывается в политику размещения. Политика — не код: она лежит в конфиге
воркера, валидируется fail-closed и публикуется наружу через `/v1/release`, поэтому
«почему воркер отказал» читается без доступа к состоянию флота.

## Модули

| Модуль | Ответ на вопрос |
|---|---|
| `src/release/placement.ts` | Что этот воркер имеет право запускать: движок × регион, explicit profile, провайдер модели, credential scopes, резидентность данных, `regionConstraints` рана. `screenWorkers` — отбор воркеров флота для control plane |
| `src/release/admission.ts` | Порядок отказов: откат → placement → платный профиль → когорта → владение. Отказ по размещению — отдельный вид журнала (`placement_refused`) и отдельные коды 403/409 |
| `src/runner/runner.ts` | Повторная проверка: движок вне `host.allowedEngines` отклоняется в preflight с `REGION_FORBIDDEN`, даже если вызывающий его пропустил |
| `src/release/dispatch-owner.ts` | Перехват по явному сигналу оставляет запись без попытки; первый claim нового владельца принимает это поколение (иначе fencing сдвигался бы на поколение без рана) |
| `scripts/fixtures/p30-sandbox-placement-policy.json` | Песочная политика: `authority: sandbox_probe`, резидентность не решена, Claude/Codex вне RU |

API: блок `placement` в `GET /v1/release` и в `/v1/capabilities`, логи `placement_admitted` /
`placement_refused` с регионом, провайдером и причинами.

## Порядок проверок и почему он такой

1. **Откат релиза** — пока откатан, новые задачи не принимаются вообще (P29).
2. **Placement** — регион/провайдер/credentials/резидентность воркера. Проверяется **до**
   платного флага намеренно: отказ «платно» маскировал бы нарушение региональной политики, и
   включение paid-профилей позже молча запустило бы Claude/Codex в RU. В пробе это видно
   прямо: `OpenCode/zen` в EU проходит регион и упирается в `PAID_PROFILE_DISABLED`.
3. **Платный профиль** — выключен по умолчанию (P29).
4. **Когорта** — только её principal'ы (P29).
5. **Владение задачей** — claim в общем реестре (P29).

## Политика размещения

```jsonc
{
  "schemaVersion": 1,
  "policyId": "p30-sandbox-placement",
  "authority": "sandbox_probe",            // sandbox_probe | owner_decision
  "decisionRef": "…",                      // обязателен при authority: owner_decision
  "engines": {
    "opencode": {
      "allowedRegions": ["sandbox-ru", "sandbox-eu"],
      "explicitProfileRef": "sandbox-free-profile",
      "providers": {
        "free-ladder": { "allowedRegions": ["sandbox-ru", "sandbox-eu"] },
        "zen": { "allowedRegions": ["sandbox-eu"] }
      }
    },
    "claude": { "allowedRegions": ["sandbox-eu"], "explicitProfileRef": null },
    "codex": { "allowedRegions": ["sandbox-eu"], "explicitProfileRef": null }
  },
  "credentialScopes": {
    "llm:call": { "regions": ["sandbox-eu"] }
  },
  "dataResidency": { "decided": false, "decisionRef": null, "regions": [] }
}
```

- **Fail-closed**: движок, провайдер или scope, которых нет в политике, не разрешены нигде
  (`REGION_ENGINE_UNDECLARED`, `PROVIDER_UNDECLARED`, `CREDENTIAL_SCOPE_UNDECLARED`).
- **Explicit profile**: движок в регионе без `explicitProfileRef` не запускается
  (`REGION_EXPLICIT_PROFILE_REQUIRED`). Это и есть «Claude/Codex вне RU только с разрешённым
  explicit profile»: профиль включается решением владельца, а не кодом.
- **Провайдер**: проверяется только когда модель объявлена — без модели нечего сопоставлять,
  и отказ здесь заблокировал бы все запросы без `modelSettings.model`.
- **Резидентность данных утверждается отдельно**: `decided: false` → 409
  `DATA_RESIDENCY_UNDECIDED` с `ownerDecisionRequired: true`. Симуляция песочницы не может
  объявить резидентность решённой: `decided: true` требует `authority: owner_decision` и
  ссылки на решение. Политика вычислений и политика хранения — разные решения владельца.

## Прогон

```bash
npm ci && npm run build
scripts/recreate-sandbox.sh --namespace p30-$(date -u +%Y%m%d) \
  --regions sandbox-ru,sandbox-eu \
  --placement scripts/fixtures/p30-sandbox-placement-policy.json \
  --client-engines fake,opencode,claude,codex --owner sandbox
node scripts/p30-fleet-probe.mjs --fleet-root /var/lib/agent-runner-fleet --namespace p30-…
```

`recreate-sandbox.sh` создаёт два воркера одной VM в разных регионах: раздельные data/config
корни, свои ключи, закреплённые манифесты (кандидат/предыдущий), общий реестр владения,
одинаковая политика размещения в config каждого воркера. Без `--regions`/`--placement`
поведение прежнее — проба P29.

`p30-fleet-probe.mjs` поднимает два настоящих процесса `dist/api/main.js` и проходит 9 шагов:

1. `sandbox_fresh` — namespace создан заново, политика одинакова на обоих воркерах,
   регионы различны, значений секретов в provisioning нет;
2. `ports_free` — порты свободны до старта;
3. `workers_started` — закреплённые релизы, разные регионы/workerId/порты, paid off,
   политика опубликована в `/v1/release` и `/v1/capabilities`;
4. `placement_matrix` — матрица размещения на уровне политики: 9 сценариев
   (движок × регион × провайдер × credentials × резидентность) плюс `screenWorkers`;
5. `placement_http` — отказы на уровне сервиса до записи рана: Claude/Codex в RU, Claude в EU
   без профиля, `OpenCode/zen` в RU, credential scope вне региона, резидентность без решения;
   положительный путь с `placement_admitted`; drill с явным профилем (политика переключается
   в конфиге, регион открывается, дальше отказывает paid-флаг, политика возвращается);
6. `drain_before_failover` — задача принята до drain, воркер в drain не берёт новые задачи
   (503 `WORKER_DRAINING`), принятая до drain продолжает исполняться у прежнего владельца,
   второй воркер в это время принимает новые задачи;
7. `failover_no_double_execution` — управляемый сбой: SIGKILL процесса воркера и его движка,
   `recover()` записывает ран потерянным (`WORKER_CRASH`, без скрытого rerun), записи
   прежнего владельца исключены до перехода, перехват только по явному сигналу (поколение +1,
   прежний fenced с причиной в журнале), новый владелец получает ровно один успешный результат,
   поздняя попытка зомби-владельца отклонена (409), у прежнего владельца ровно один ран;
8. `logs` — журнал содержит release/config/cohort/placement/drain/failover/fenced, `seq`
   без дыр при двух писателях, каждая строка лога несёт releaseId/workerId/region, строки
   приёма — userTaskId/runId/ownerGeneration;
9. `no_secrets` и `open_decisions` — значения ключей и share-секретов в транскрипте нет;
   резидентность остаётся открытым решением владельца, прод и настоящие RU/EU воркеры не
   трогались, shell-доступ к RU VM (AC-31) по-прежнему отсутствует.

Проба останавливается на первом несоответствии (exit 1) и всегда гасит своих воркеров.

## Границы доказанного

- **Настоящее**: API, Runner, placement-политика, реестр владения, журнал переходов — реальные
  процессы на одной машине; движок `fake` (free-only).
- **Эмуляция**: два региона — это две логические зоны одной машины (VM2); сетевой partition
  эмулируется отсутствием сигнала в реестре (`partition_is_not_failover`); настоящие RU/EU
  workers и прод не использовались.
- **Не доказано здесь**: доступность сохранённых данных с нового воркера и потеря volume —
  корни `dataDir` у воркеров раздельны по построению; эти проверки требуют настоящих RU/EU
  воркеров и отдельного решения владельца (AC-31).

## Что покрыто тестами

- [x] Политика размещения: валидация fail-closed, матрица регион × провайдер × credentials ×
      резидентность, `screenWorkers`, `allowedEnginesForRegion` — `test/placement-policy.test.ts`
- [x] Внешний контракт поверх HTTP на двух воркерах в разных регионах: отказы размещения до
      записи рана, явный профиль в политике, повторная проверка Runner'ом — `test/placement-api.test.ts`
- [x] Failover без двойного исполнения на двух воркерах: partition ≠ failover, явный сигнал,
      fenced прежнего владельца, ровно один успешный результат — `test/placement-api.test.ts`
- [x] Проба на песочной VM2: 67/67, транскрипт `docs/evidence/p30-fleet-vm2/`
- [x] Проба в CI на каждом PR: `.github/workflows/p30-fleet-probe.yml`
