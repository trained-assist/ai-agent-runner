# Lifecycle рана на песочной VM2 (issue #52)

Транскрипт пробы `scripts/isolation-probe.mjs` на настоящем Linux-хосте с привилегиями:
граница Agent clean room (#51) **и** полный lifecycle рана (#52): persist с подтверждением
чтением → проверенная уборка → восстановление после управляемого сбоя.

| | |
|---|---|
| Хост | VM2, Linux 6.8.0-142-generic, API-процесс от root |
| Namespace | `iso-p52-20261003-2231` (`/var/lib/agent-runner`, `scripts/recreate-sandbox.sh`) |
| Слоты | `ta-agent-1` (uid 999), `ta-agent-2` (uid 997), лаунчер `setpriv`, `setfacl` |
| Движок | `fake` — свойства OS-границы и lifecycle от движка не зависят; строка «настоящий OpenCode Run» остаётся открытой |
| Итог | **115/115 проверок, 11 шагов, 0 отказов** (`totals` в транскрипте: 114 checks — счёт до шага `sanitized_transcript`) |
| Когда | 2026-10-03T22:32:04Z |

## Что доказано

| шаг | утверждение |
|---|---|
| `two_concurrent_runs`, `refuse_when_slots_busy`, `refuse_without_boundary`, `lease_survives_worker_restart` | граница жива: два рана изолированы, занятый/сломанный слот отказывает до спавна движка, рестарт воркера дочищает аренду без повторного запуска движка (#51) |
| `cleanup_after_success` | успешный ран: `outputRefs` непустой, workspace и каталоги чистой среды удалены, слот вернулся в пул |
| `storage_failure_keeps_sole_copy` | отказ хранилища: ран `succeeded`, но `persistence: failed` с причиной; единственная копия на диске, `cleanup: pending` с причиной, аренда `blocked`; следующий ран отказан (`ISOLATION_SLOT_BUSY`); **рестарт не стирает копию, не переписывает статус и не перезапускает движок** |
| `lifecycle_persist_then_sweep` | после terminal+persist: `persistence: persisted` (`verified by read-back from durable storage`), ответ агента сохранён отдельным артефактом `answer.txt`, checkpoint `phase=complete`; каталоги рана и его run-scoped `home`/`tmp`/`mcp`/`root` **отсутствуют**; при этом результат, события и байты выхода читаются (`200: ok`) |
| `crash_during_sweep_recovers` | сбой **в момент уборки** (`AGENT_API_FAULTS=cleanup`): намерение уборки записано на диск (`cleanup_pending`), каталоги рана на месте, ран не терминален; воркер падает по-настоящему (SIGKILL) — восстановление довело уборку до конца, байты сохранены, движок не перезапущен, аренда `released`, слот вернулся в пул; повторный рестарт ничего не делает заново |

Каждый шаг несёт `runId`/`userTaskId`/`profileId`, ключи событий и причину перехода; в логах
рана видно `slotId`/`uid`/`gid`/`acl` и `envkeys` движка.

## Проверка отсутствия утечек

`transcript.json` не содержит значений ключей (`ak_…`) — это проверяет сама проба перед
записью, и повторно проверено перед коммитом. Личных файлов и путей `$HOME` в транскрипте
нет: только пути namespace песочницы. Журналы API (`api-<port>.log`) наружу не
выкладываются: в них есть строки запуска, а значения ключей в них не должно быть — если
нужен разбор, шаг запускается с `--keep`.

```bash
sha256sum -c transcript.sha256
```

## Дефекты, найденные этой пробой

Проба — не формальность: на VM2 она нашла три дефекта, которых не видно в тестах на одном
процессе, и все три исправлены до этого снимка (PR #60 и его продолжение):

1. отказ уборки одного рана ронял `recover()` целиком, и API не поднимался;
2. повторный экспорт после снятия локальной копии переписывал подтверждённый артефакт в
   `missing`, теряя ссылку на байты в долговечном хранилище;
3. после рестарта воркера уборка не освобождала аренду идентичности: `cleanup: completed`
   при висящем слоте.

## Как воспроизвести

```bash
scripts/recreate-sandbox.sh --namespace iso-$(date -u +%Y%m%d) \
  --fleet-root /var/lib/agent-runner --workers a --client-engines fake,opencode --owner root
sudo node scripts/isolation-probe.mjs --fleet-root /var/lib/agent-runner \
  --namespace iso-$(date -u +%Y%m%d) --out docs/evidence/p52-lifecycle-vm2
```

Пробе нужны root (`useradd`/`chown`/`setfacl`) и Linux. На хосте без привилегий она честно
пишет `status: skipped` и **не** отчитывается об успехе: доказательство берётся отсюда, с
привилегированной песочной VM. В обычном CI привилегированные шаги пропускаются — см.
[`.github/workflows/isolation-probe.yml`](../../.github/workflows/isolation-probe.yml).
