# Запуск Runner в GitHub Actions — итоги эксперимента и требования

Итоги замеров 01–04.10.2026. Эксперимент не потерян: он живёт в двух workflow-файлах и в
логах реальных прогонов, а не в отдельной заметке — поэтому его искали не там. Здесь —
сводка, чтобы не повторять замеры.

## Где доказательство

| Что | Где |
|---|---|
| Что доступно в CI (факты, Playwright, opencode, e2e-цикл) | `.github/workflows/capability-probe.yml` (PR [#8](https://github.com/trained-assist/ai-agent-runner/pull/8), merge `fe2c781`) |
| Замеры лимитов и таймингов запуска Runner в CI | `.github/workflows/stress-probe.yml` + `scripts/stress-probe.mjs` |
| Почему привилегированная проба не гоняется в CI | `.github/workflows/isolation-probe.yml` |
| План «джоба сама опрашивает очередь задач» | issue [#10](https://github.com/trained-assist/ai-agent-runner/issues/10) (open) |
| Продуктовый деплой на VM (не CI) | `infra/agent-runner-api.service`, [docs/API-SERVICE.md](API-SERVICE.md) |

Ключевые прогоны (репозиторий `trained-assist/ai-agent-runner`):

- `capability-probe` run **37201444441** — 04.10.2026, **1m39s**, success (полный цикл).
- `stress-probe` run **36837417019** — 01.10.2026, **2m27s**, failure (убила memory-фаза).
- Все `stress-probe` прогоны — `failure` по одной причине: аллокация памяти роняет джобу.

## Хост GitHub Actions (замеренные факты)

```
cpus: 4
Mem: 15Gi  (Swap: 3.0Gi)
/dev/root 145G, 59G used
sudo: passwordless          ← штатное свойство CI-хоста
docker: Docker version 28.0.4
kvm: no
systemd: systemd 255
os: Ubuntu 24.04.5 LTS
```

## Что МОЖНО гонять в CI

| Возможность | Статус | Замер |
|---|---|---|
| `npm ci` + typecheck + unit (495 тестов) | ✅ | 33 s |
| Playwright (chromium) — установка и живой клик | ✅ | 27 s, `playwright click title = clicked` |
| opencode headless без конфига | ✅ (exit=0, `pong`) | 17 s, v1.18.34 |
| opencode через `llm-ladder` (free) | ✅ | 4 s, `OK (pong)` |
| E2E acceptance loop (fake engines, без reboot) | ✅ 7/7 шагов | 7 s |
| Docker | ✅ установлен, но ни один workflow его не использует | — |
| MCP-серверы | ⚠️ ограничений в CI не задокументировано; покрыт только через `npm test` (`test/mcp-lifecycle.test.ts`) | — |

E2E-шаги внутри CI (run 37201444441):

```
step-1-submit-idempotency     469 ms
step-2-events-stream-replay  1775 ms
step-3-fault-injection      2443 ms
step-4-recovery-restart      507 ms
step-5-security-probes        464 ms
step-6-artifact               341 ms
step-7-credential-scopes      563 ms
```

## Чего НЕТ / что НЕЛЬЗЯ в CI

1. **Reboot невозможен** — `systemctl reboot` убивает раннер вместе с job. Валидация
   reboot-пути — только на песочной VM.
2. **Входящие порты недоступны** — нет туннеля, нет idle-ожидания внутри рана (решение
   владельца: это жжёт computation time). Джоба либо опрашивает очередь, либо поднимает
   эфемерный API и завершается.
3. **Привилегированная OS-проба не гоняется в CI** — требует root (`useradd`/`chown`/
   `setfacl`). Обычный CI-раннер не может ни доказать, ни честно опровергнуть границу,
   поэтому workflow только `workflow_dispatch`, сам детектит возможности и на
   непривилегированном хосте пишет транскрипт со `status: skipped`. Зелёный шаг
   «изоляция проверена» в CI был бы доказательством от случайно выданных привилегий.
4. **Нет KVM** — `/dev/kvm` отсутствует.
5. **Потолок памяти ≈ 15 GiB** — аллокация до ~18 GB убивает джобу:
   `##[error]Process completed with exit code 143.` +
   `##[error]The runner has received a shutdown signal.`
   Внутри гостя OOM-строки нет — процесс раннера получает SIGTERM.
6. **Таймауты**: job `timeout-minutes: 30` (capability/stress), `20` (isolation),
   `15` (promotion/p30-fleet). Сигнатура таймаута шага:
   `##[error]The action '… timeout-minutes=1 (спим 5 минут)' has timed out after 1 minutes.`
   → `outcome=failure`, `conclusion=success` (шаг помечен `continue-on-error`).
7. **Passwordless sudo — норма для CI-хоста**, поэтому sudo-проба идёт в режиме
   `--sudo-policy report`, а не `deny`. На продуктовых хостах оставляйте `deny`.
8. **Секреты не должны попадать в транскрипты/артефакты** — проверка `grep 'ak_…'` → exit 1.

## Замеры времени запуска Runner в CI

`stress-probe` run 36837417019 (timeline-фаза, реальный API + ран):

```
job start → npm ci done          6710 ms
npm ci → dist built              1861 ms
dist build → API listening         56 ms
listening → healthz                36 ms
healthz → submit 202                16 ms
submit → running (начало рана)       8 ms
submit → succeeded                  40 ms
succeeded → result готов             2 ms
submit → result готов              42 ms
job start → result готов         8721 ms
```

Другие прогоны, `job start → result готов`: **7853 / 9432 / 9762 / 10048 ms**.
`job start → npm ci done` в другом прогоне: **7216 ms**.

Recovery-фаза (смерть сервера → данные читаются):

```
kill → process dead        8 ms
kill → server up          110 ms
kill → status readable    116 ms
kill → events replay      118 ms
```

opencode free под нагрузкой (4 параллельных + 1 длинный):

```
parallel-1..4   7719 / 7824 / 7840 / 7844 ms
long-report     6665 ms
```

Другие прогоны: **5458/5572/5602/7335 ms** и **9453/9456/9498/9674/8267 ms**.
Rate-limit/429 не пойман ни разу.

Длительности джоб:

| Workflow | Диапазон | Исход |
|---|---|---|
| `capability-probe` | 1m29s – 2m23s | success |
| `stress-probe` | 50s – 3m25s | failure (memory-фаза) |
| `CI` | 30s – 1m21s | success |
| `promotion-probe` | 21–29s | success |
| `p30-fleet-probe` | 29–37s | success |
| `isolation-probe` | 38s (skip) / 20m18–20m20s (cancel) | failure / cancelled |

## Что нужно для запуска (минимальный набор)

1. **GitHub-hosted runner `ubuntu-latest`** — self-hosted раннер не нужен и нигде не
   настроен (проверено по всем refs). 4 CPU / 15 GiB / 145 GB.
2. **Node 20** — `actions/setup-node@v4` с `node-version: 20`.
3. **Секрет `LLM_LADDER_TOKEN`** — уже в секретах репозитория.
4. **`npm ci --no-audit --no-fund`** — ~6.7 s от старта джобы.
5. **opencode** — `npm install -g opencode-ai` + свой `opencode.json` с провайдером
   `llm-ladder` и моделью `free`, запуск с флагом `-m ladder/free`. Замер: opencode
   1.18.34 отвечает даже без конфига (exit=0, `pong`) — но для задач проекта нужен именно
   `llm-ladder`, иначе уйдёт в дефолтный провайдер.
6. **Playwright** — `npm install --no-save playwright` + `npx playwright install --with-deps chromium`.
7. **E2E-цикл** — `./scripts/e2e-loop.sh --sudo-policy report`.
8. **Конфиг движка для настоящих ран** — read-only шаблон в `AGENT_API_ENGINE_CONFIG_DIR`;
   хост кладёт provider/model, ключ сюда не попадает (см. `src/isolation/engine-config.ts`).
9. **Секреты только в `secrets`**, не в логах и артефактах.

## Когда имеет смысл запускать в CI

**Да** — девелоперские задачи, которые укладываются в лимиты:

- тесты / typecheck / unit (уже в `ci.yml`);
- e2e-цикл как гейт PR;
- браузерные задачи через Playwright;
- headless-задачи через opencode на `llm-ladder` free;
- короткие ран-задачи с fake-движком.

**Нет** — то, что упирается в ограничения:

- валидация reboot-пути (только песочная VM);
- доказательство OS-границы (только привилегированная VM);
- задачи, требующие входящих соединений / туннеля / долгого idle;
- задачи с памятью выше ~15 GiB;
- долгоживущие сервисы — джоба должна завершаться, а не висеть.

## Схема pull-job (issue #10, не реализована)

Вместо туннеля и ожидания внутри рана — **джоба сама опрашивает очередь задач**:

```
[repository_dispatch / workflow_dispatch / issues: labeled task-pending]
        │
        ▼
fetch-task: взять ОДНУ задачу (claim, без двойного исполнения)
        │ нет задач → exit 0 (секунды, 0 вреда)
        ▼
поднять Serverless API как child (src/api, durable store на время job)
        │ submit → events → result
        ▼
исполнить (fake engine по умолчанию; opencode через llm-ladder по требованию)
        │
        ▼
артефакт → storage (GCS, share-by-link) → ссылка в задачу/отчёт
```

Очередь v1 — issues с лейблом `task-pending` в этом репо. Claim: добавить `task-running`
(+assignee). Приёмка: пустая очередь → джоба завершается **< 30 s** без запуска API.

Файл `.github/workflows/agent-task-poll.yml` пока не создан.
