# Materialize входов рана на песочной VM2 (issue #52, шаг 1)

Транскрипт пробы `scripts/isolation-probe.mjs` на настоящем Linux-хосте с привилегиями.
Шаг `materialize_inputs` доказывает **шаг 1** lifecycle: разрешённые refs/снимок
материализуются в workspace нового рана, а отказ по дайджесту, чужому владельцу и
недоступному хранилищу не оставляет в workspace ни одного байта. Остальные шаги пробы —
регрессия границы clean room (#51) и lifecycle persist→sweep (#52, шаги 2–5).

| | |
|---|---|
| Хост | VM2, Linux 6.8.0-142-generic, API-процесс от root |
| Namespace | `iso-20261004-004746` (`/var/lib/agent-runner`, `scripts/recreate-sandbox.sh`) |
| Слоты | `ta-agent-1` (uid 999), `ta-agent-2` (uid 997), лаунчер `setpriv`, `setfacl` |
| Коммит | `93beac6` |
| Движок | `fake` — свойства границы и materialize от движка не зависят; строка «настоящий OpenCode Run» остаётся открытой |
| Итог | **136/136 проверок, 12 шагов, 0 отказов** (`totals` в транскрипте: 135 checks — счёт до шага `sanitized_transcript`) |
| Когда | 2026-10-04T00:48:10Z |

## Решение владельца, которое реализовано

Байты между ранами лежат в долговечном хранилище, а `WorkspaceSnapshot` — **указатель**
на них: `artifacts: [{ path, artifactId, sha256, size }]` со ссылкой на существующий
`ArtifactStore`. Симметрично экспорту (шаги 2–3), новый локатор байтов не изобретался.

## Что доказано (шаг `materialize_inputs`)

| строка приёмки #52 | результат на хосте |
|---|---|
| разрешённый ref/снимок материализуется в workspace нового рана | ран A сохранил выход `art-ea748d27745349bbd5bf6dee` (`ran.txt`, 2 Б, `sha256 2689367b…`); снимок `snap-df1c902a7f4282d1798ac69b` закоммичен как указатель; ран B получил файл в `.inputs/snap-…/ran.txt`, байты совпали с выходом рана A |
| вход лежит **внутри границы рана** | `cat` под идентичностью рана B — `0: ok`; под чужим слотом — `Permission denied` |
| **checksum mismatch → отказ, ничего не пишется** | байты в хранилище подменены на `tampered` (та же длина): `MATERIALIZE_BYTES_MISMATCH`, `retryable: false`, движок не запускался, `.inputs` не появился |
| чужой owner/scope → отказ | второй принципал того же воркера: `MATERIALIZE_REF_FOREIGN`, `retryable: false`, поток событий `claimed, inputs_materialized, log, failed` — **спауна движка не было**; в workspace чужого рана нет ни одного байта входа |
| «следующий разрешённый Run видит snapshot прошлого и **не видит чужие данные**» | снимок → следующий рану; чужой principal отказан по владельцу (`belongs to profile "profile-fleet-client", run … belongs to "profile-p29-a"`); ран **без** ref отработал и `.inputs` не увидел — входы не достаются «по умолчанию» |
| транзиентно: не падает, уходит с причиной | недоступное хранилище даёт повторяемый отказ, воркер остаётся жив, повтор проходит (`test/input-materialize.test.ts`) |
| логи | событие `inputs_materialized` несёт `status/declared/requested/files/bytes` и счётчики по каждому ref'у; в журнале рана — `inputs.materialized runId=… refs=1 files=1 bytes=2`; каждое событие несёт `runId`/`userTaskId`/`profileId`, причина отказа — отдельной строкой |

Управляемый сбой здесь один, но он ломает именно то, что защищает приёмка: **байты в
хранилище подменены при живом указателе снимка** — манифест артефакта и снимок продолжают
объявлять исходный дайджест, поэтому отказ может прийти только сверкой по факту записи.

## Проверка отсутствия утечек

`transcript.json` не содержит значений ключей (`ak_…`, `sk-…`) — это проверяет сама проба
перед записью, и повторно проверено перед коммитом. Личных файлов и путей `$HOME` в
транскрипте нет: только пути namespace песочницы. Журналы API (`api-<port>.log`) наружу не
выкладываются: в них есть строки запуска, а значения ключей в них не должно быть — если
нужен разбор, шаг запускается с `--keep`.

```bash
sha256sum -c transcript.sha256
```

## Дефект, найденный этой пробой

Проба нашла дефект в себе самой и в маршруте: `POST /v1/runs/{id}/snapshot-file/{snapshotId}`
адресует объект **внутри** рана, а лимит сегментов в маршрутизаторе отсекал ветки с
`segments[4]` — link в снимок отвечал 404, то есть указатель на байты нельзя было создать
вовсе. Оба маршрута, адресующие объект внутри рана, разведены явно.

Второй дефект — гонка в `writeFileAtomic`: фиксированное имя `<path>.tmp` означало ENOENT
на rename, когда файл пишут два процесса, и роняло старт воркера из-за чужого рана. Имя
временного файла уникально на запись (pid + счётчик). Оба исправлены в этом же PR.

## Как воспроизвести

```bash
scripts/recreate-sandbox.sh --namespace iso-$(date -u +%Y%m%d-%H%M%S) \
  --fleet-root /var/lib/agent-runner --workers a --client-engines fake,opencode --owner root
sudo node scripts/isolation-probe.mjs --fleet-root /var/lib/agent-runner \
  --namespace iso-$(date -u +%Y%m%d-%H%M%S) --out docs/evidence/p52-materialize-vm2
```

Пробе нужны root (`useradd`/`chown`/`setfacl`) и Linux. На хосте без привилегий она честно
пишет `status: skipped` и **не** отчитывается об успехе: доказательство берётся отсюда, с
привилегированной песочной VM. В обычном CI привилегированные шаги пропускаются — см.
[`.github/workflows/isolation-probe.yml`](../../.github/workflows/isolation-probe.yml).

Транскрипты шагов 2–5 — в [`../p52-lifecycle-vm2/`](../p52-lifecycle-vm2/README.md),
границы per-run идентичности — в [`../p51-clean-room-vm2/`](../p51-clean-room-vm2/README.md).