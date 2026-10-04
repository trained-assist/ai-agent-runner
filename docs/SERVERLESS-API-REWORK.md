# ТЗ: Serverless-переработка API (без диска, эфемерная VM)

**Цель:** API работает как serverless-оркестратор. После рана VM можно убить. Артефакты —
в GitHub-репозиторий юзера, логи — в Google Storage. Никакого состояния на диске.

**Принцип:** API не хранит состояние, не запускает процессы, не держит диск. Он принимает
запрос, вызывает внешний воркер (эфемерную VM), возвращает результат клиенту.

---

## 1. Текущее состояние → целевое

| Сейчас | Цель |
|---|---|
| Диск `/var/lib/agent-runner` (admissions, events, results) | Нет диска. In-memory или KV |
| `spawn` opencode/fake в процессе API | HTTP-вызов внешнего воркера |
| Артефакты на диске (local-fs) | Артефакты в GitHub-репозитории юзера |
| Логи на диске (`events.jsonl`) | Логи в GCS,  API возвращает ссылку |
| Recovery после рестарта | Нет recovery (stateless) |
| Идемпотентность на диске | Идемпотентность в KV или у воркера |
| systemd `Restart=always` | Эфемерная VM, убивается после рана |

## 2. Целевая архитектура

```
Клиент
  │  POST /v1/runs  { engine: "dynamic-ip-azure-agent-run", … }
  ▼
Serverless API (CF Worker или тонкий VM-сервис)
  │  stateless, без диска, без spawn
  │  POST {worker}/v1/launch  { LaunchRequest }
  ▼
Внешний воркер (эфемерная VM / GitHub Actions)
  │  запускает агента
  │  лог сессии → Google Storage
  │  → { LaunchResult: exitCode, stdout, stderr, answer, logUrl }
  ▼
API маппит LaunchResult → RunResult → возвращает клиенту
  │  WorkspaceService.publishRunChanges → артефакты в GitHub
  ▼
VM можно убить
```

## 3. Что удаляем

| Модуль | Файл | Почему удаляем |
|---|---|---|
| Durable store | `src/api/store.ts` | Диск не нужен, stateless |
| Recovery | `src/api/service.ts` (`recover()`) | Нечего восстанавливать |
| Disk artifact store | `src/storage/local-fs.ts` | Артефакты в GitHub |
| Disk blob store | `src/storage/blob-store.ts` (local-fs) | Байты в GitHub/GCS |
| Process spawn | `src/runner/` (spawn движков) | Воркер запускает агента |
| Engine adapters (fake/opencode) | `src/adapters/engine/` | Внешний воркер |
| Isolation (setpriv/runuser) | `src/isolation/` | Воркер изолирует сам |
| systemd unit | `infra/agent-runner-api.service` | Эфемерная VM |

## 4. Что оставляем (переписываем)

| Модуль | Файл | Что меняем |
|---|---|---|
| HTTP-сервер | `src/api/server.ts` | Маршруты те же, но stateless |
| Auth | `src/api/auth.ts` | Ключи в env/Secrets, не на диске |
| Submit contract | `src/api/contracts.ts` | Тот же `SubmitRequest` |
| RunSpec | `src/contracts/run-spec.ts` | Тот же контракт (воркеру) |
| RunResult | `src/contracts/result.ts` | Тот же контракт (маппинг из LaunchResult) |
| RunnerEvent | `src/contracts/events.ts` | Тот же контракт (маппинг) |
| Capabilities | `src/api/contracts.ts` (`ApiCapabilities`) | Обновить: `isolation.mode: "none"`, `engines: ["dynamic-ip-azure-agent-run"]` |

## 5. Что добавляем

| Модуль | Файл | Задача |
|---|---|---|
| External worker adapter | `src/adapters/external-worker-adapter.ts` | HTTP-вызов воркера, маппинг LaunchResult → RunResult |
| Stateless store | `src/api/stateless-store.ts` | In-memory receipts (или KV) |
| GCS log link | `src/adapters/external-worker-adapter.ts` | Приём `logUrl` от воркера |

## 6. Артефакты → GitHub (уже реализовано)

**Модуль `src/workspace/` (PR #131) уже публикует артефакты рана в приватный GitHub-репозиторий профиля.** Воркер артефакты не пушит.

Что уже есть:
- `WorkspaceService.publishRunChanges` — публикация изменений рана в GitHub (git mirror, CAS, compare-and-swap, разрешение конфликтов).
- `src/workspace/git/github-admin.ts` — создание приватных репозиториев профилей через GitHub API.
- `src/workspace/git/local-git.ts` — локальное git-зеркало (clone, commit, push, merge).
- Артефактный индекс, export policy, journal публикаций.
- Тесты: `test/workspace-service.test.ts`, `test/workspace-github-admin.test.ts`, `test/workspace-policy.test.ts`.

**Что делает serverless-переработка:**
- Подключает `publishRunChanges` в поток рана (после завершения движка → публикация в GitHub).
- Убирает локальный disk artifact store (`src/storage/local-fs.ts`) — байты не храним.
- `GET /v1/runs/{id}/artifacts` → ссылки на GitHub (path + repo + commit) из результата публикации.
- Воркер возвращает только `exitCode`, `stdout`, `stderr`, `answer` — артефакты и логи обрабатывает API через `WorkspaceService` и GCS.

## 7. Логи → Google Storage

**Контракт:** воркер загружает лог сессии в GCS, возвращает `logUrl`:

```json
{ "logUrl": "https://storage.googleapis.com/<bucket>/runs/<runId>/session.log" }
```

**API:**
- Не хранит лог на диске.
- Возвращает клиенту `logUrl`.
- `GET /v1/runs/{id}/events` → либо пробрасывает стрим из GCS, либо отдаёт ссылку.

## 8. Идемпотентность без диска

**Проблема:** `Idempotency-Key` → повторный submit возвращает тот же receipt. Без диска
это можно хранить в:
- **In-memory** (Map) — но теряется при рестарте. Приемлемо: клиент повторит submit.
- **KV** (Cloudflare KV / GCS) — переживает рестарт. Лучший вариант для CF.

**Решение:** in-memory Map + опциональный KV. При рестарте клиент повторяет submit с
новым ключом (наш API отвечает `409 TASK_ATTEMPT_ACTIVE` или создаёт новую попытку).

## 9. SSE стриминг

**Вариант А (рекомендуется):** воркер стримит события, API пробрасывает клиенту.

```
Клиент ← SSE ← API ← SSE ← воркер
```

**Вариант Б:** клиент опрашивает воркер напрямую (API отдаёт `workerUrl`).

**Вариант В:** события не стримятся, клиент опрашивает `GET /v1/runs/{id}/result` (polling).

**ТЗ:** реализовать Вариант А (стриминг через API). Если CF — проверить лимиты на длинные
стримы. Вариант В — как fallback.

## 10. Auth без диска

- API-ключи в env/Secrets (не на диске).
- Key registry — в конфиге или KV.
- Воркер авторизуется общим секретом (`WORKER_TOKEN`).

## 11. Шаги реализации (Epic)

### Шаг 1: Stateless core
- Удалить `src/api/store.ts` (durable store).
- Удалить `recover()` из `src/api/service.ts`.
- Добавить `src/api/stateless-store.ts` (in-memory receipts).
- Обновить `src/api/server.ts` — убрать зависимость от диска.

### Шаг 2: External worker adapter
- Создать `src/adapters/external-worker-adapter.ts`.
- Реализовать `POST {worker}/v1/launch` → `LaunchResult`.
- Маппинг `LaunchResult` → `RunResult` + `RunnerEvent`.
- Конфиг: `EXTERNAL_WORKER_URL`, `EXTERNAL_WORKER_TOKEN`.

### Шаг 3: Убрать spawn и движки
- Удалить `src/runner/` (spawn движков).
- Удалить `src/adapters/engine/` (fake, opencode).
- Движок `dynamic-ip-azure-agent-run` → только через внешний воркер.

### Шаг 4: Артефакты → GitHub (подключить существующий модуль)
- Подключить `WorkspaceService.publishRunChanges` в поток рана (после движка → публикация в GitHub).
- Удалить `src/storage/local-fs.ts` (disk artifact store) — байты не храним.
- `GET /v1/runs/{id}/artifacts` → ссылки на GitHub (из результата публикации).
- Воркер не пушит артефакты — это делает API через `WorkspaceService`.

### Шаг 5: Логи → GCS
- Лог сессии загружается воркером в GCS.
- API возвращает `logUrl` из `LaunchResult`.
- `GET /v1/runs/{id}/events` → стрим из GCS или ссылка.

### Шаг 6: Идемпотентность
- In-memory Map для receipts.
- При рестарте — клиент повторяет submit (документировать).

### Шаг 7: Capabilities
- Обновить `ApiCapabilities`: `isolation.mode: "none"`, `engines: ["dynamic-ip-azure-agent-run"]`.
- `artifacts.export.enabled: false` (артефакты в GitHub, не в API).

### Шаг 8: Тестирование
- Обновить `test/e2e-loop.test.ts` — stateless модель.
- Мок внешнего воркера.
- Тест: submit → worker → result → artifacts (GitHub links) → logUrl (GCS).

### Шаг 9: Деплой
- API → Cloudflare Worker (или тонкий VM-сервис без диска).
- Воркер → эфемерная VM / GitHub Actions.
- VM убивается после рана.

## 12. Приёмка

- [ ] API не пишет на диск (кроме временных файлов).
- [ ] API не запускает процессы (только HTTP-вызов воркера).
- [ ] Артефакты возвращаются как ссылки на GitHub (из `WorkspaceService.publishRunChanges`).
- [ ] Логи возвращаются как ссылка на GCS (не содержимое).
- [ ] Идемпотентность работает (in-memory или KV).
- [ ] SSE стриминг работает (или polling fallback).
- [ ] После рана VM можно убить (нет состояния).
- [ ] `GET /v1/capabilities` отчитывается честно: `isolation.mode: "none"`, `engines: ["dynamic-ip-azure-agent-run"]`.
- [ ] E2E-тест проходит на stateless модели.

## 13. Открытые вопросы

1. **CF Worker или тонкий VM?** — CF лучше (serverless), но длинные SSE-стримы надо
   тестировать. VM проще, но не "serverless".
2. **Идемпотентность: in-memory или KV?** — KV переживает рестарт, но добавляет
   зависимость. In-memory проще, но теряется при рестарте.
3. **Кто убивает VM?** — воркер сам (после возврата результата) или API (после получения
   LaunchResult).
4. **GitHub Actions или VM для воркера?** — GH Actions проще (эфемерно), но может не
   хватить ресурсов для opencode. VM гибче, но надо убивать.

## 14. Связанные документы

| Документ | Смысл |
|---|---|
| `docs/TZ-EXTERNAL-OPENCODE-WORKER.md` | ТЗ внешнего воркера (контракт LaunchRequest/LaunchResult) |
| `src/workspace/service.ts` | `WorkspaceService` — публикация артефактов в GitHub (уже реализовано) |
| `src/workspace/git/github-admin.ts` | Создание приватных репозиториев профилей |
| `src/workspace/git/local-git.ts` | Локальное git-зеркало |
| `docs/GITHUB-ACTIONS-CAPABILITY.md` | Лимиты CI (если воркер на GH Actions) |
| `docs/API-SERVICE.md` | Текущий деплой на VM (что заменяем) |
| Issue [#73](https://github.com/trained-assist/ai-agent-runner/issues/73) | Контракт API для внешней сессии |
