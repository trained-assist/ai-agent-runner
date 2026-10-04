# Постоянный пользовательский workspace: модуль и hooks интегратора

Модуль `src/workspace/` реализует контракт восьми методов из
[AGENT-RUNNER-DATA-PERSISTENCE-IMPLEMENTATION.md](https://github.com/trained-assist/trained-agent-architecture/blob/docs/profile-workspace-contract-20261004/AGENT-RUNNER-DATA-PERSISTENCE-IMPLEMENTATION.md)
(раздел «Постоянный пользовательский workspace», PR
[#131](https://github.com/trained-assist/trained-agent-architecture/pull/131)).

Модуль **не** меняет lifecycle Runner, общий `RunSpec`, workflow, dispatch и deployment.
Он добавляет только постоянное состояние пользователя: provisioning репозитория профиля,
версию состояния, публикацию изменений и разрешение конфликтов. Настоящий цикл
`profile → repository → загрузка версии → Run → сохранение → следующий Run` появляется,
когда интегратор подключит пять hooks ниже.

## Что уже было и что здесь нового

| Механизм | Где | Статус |
|---|---|---|
| Materialize входов рана из снимка | `src/storage/input-materializer.ts`, PR #69 | готов, **не переделывается**: модуль отдаёт ему манифест |
| Коммитированный снимок workspace | `src/storage/workspace-snapshot.ts` | готов, модуль заполняет его `snapshotId`/`artifactId` через интегратора |
| Экспорт артефактов рана | `src/storage/export.ts` | готов, остаётся отдельной операцией |
| Провижининг репозитория профиля | legacy `scripts/profile-repo.mjs` | reference: схема имени и идемпотентный `ensure` |
| Постоянное состояние профиля | `src/workspace/` | **этот PR**: 8 методов, порты, журнал, 100 тестов |

Снимок отдельного рана (`snapshotId`) — указатель на байты рана. Репозиторий профиля —
накопительное состояние с версией (commit SHA) и compare-and-swap публикацией. Одно
без другого не работает: снимок без репозитория не переживает следующий раунд
сопровождения, репозиторий без снимка не попадает в clean room агента.

## Инварианты

1. **Версия состояния = git commit SHA**; пустое состояние = `EMPTY_TREE`
   (`4b825dc…`). Идентификатор рана и commit SHA — разные вещи: один коммит может быть
   опубликован из повторной попытки того же рана.
2. **Host определяет профиль и права.** `tenantId`/`profileId` приходят из
   авторизованной identity; агент не выбирает binding. Чужой профиль недостижим по
   построению (`WORKSPACE_NOT_FOUND` / `WORKSPACE_FORBIDDEN`).
3. **Организационный credential не попадает к агенту.** Git работает в bare-зеркале
   модуля, токен передаётся в git-процесс через `GIT_ASKPASS` и переменную окружения
   (в argv его нет), в workspace рана не появляется ни `.git`, ни remote.
4. **Публикация — compare-and-swap по ожидаемой голове.** Force push не используется и
   нечем: `git push` без `--force` отказывает при не-fast-forward, порт переводит отказ в
   `head_changed`, а решение пересчитывает merge. Число попыток ограничено
   (`mergeAttempts`, по умолчанию 3) — бесконечного retry нет.
5. **Три статуса разделены.** `engine status` (исполнился ли ран) модуля не касается;
   `publication status` — его собственный; `cleanup status` выводится из публикации, но
   действие уборки остаётся у хоста.
6. **Неопубликованные данные не удаляются.** Пока публикация не `published`, запрет
   уборки сохраняет единственную копию: ref кандидата в remote, ref'ы артефактов и пути,
   которые журнал пометил как unrecoverable. Отказ хранилища — единственный случай, где
   «продолжать нельзя, удалять нельзя»: метод бросает `WORKSPACE_STORAGE_UNAVAILABLE` с
   `detail.publicationId`, запись остаётся читаемой, повтор того же `operationId`
   разрешён.
7. **Неизвестный исход push — это сверка, а не повтор движка.** `get_workspace_publication`
   читает remote: голова == наш коммит или коммит предок головы → `published`; кандидат
   найден в remote → публикация доводится тем же CAS; иначе остаётся `pending` с
   `outcomeUnknown`.
8. **Resolver не создаёт цикл.** Счётчик попыток разрешения живёт в durable-журнале;
   исчерпание лимита переводит конфликт в `awaiting_user_input`, а не запускает новый
   раунд. Модуль не строит agent runtime: кандидат от resolver'а приходит снаружи
   (`external_candidate` + `evidence` + `resolverRunId`).

## Тяжёлые артефакты

Текст и структура папок — в git. Файл крупнее `textMaxBytes` (по умолчанию 1 MiB) не
попадает в дерево: байты уходят в object storage с проверкой `sha256` + `size`, а в
репозиторий пишется реестр `.trained-assist/artifacts.json` (`path → key, sha256, size,
mime`). Ключ content-addressed
(`profiles/<profileId>/workspace/<publicationId>/<sha256>`), поэтому повтор после
timeout/crash не создаёт второй объект.

Манифест не ссылается на неподтверждённые байты: недоступный или подменённый объект
попадает в `warnings` снимка, а не в его `manifest`.

## Hooks, которые должен подключить интегратор

Минимальный набор — пять точек. Ни одна из них не требует изменения `RunSpec`.

### H1. Реестр сервиса (composition root)

```ts
import { WorkspaceService, WorkspaceJournal, createLocalGitPort } from './workspace/index.js';

const workspace = new WorkspaceService({
  git: createLocalGitPort({ rootDir: join(stateDir, 'workspace-mirrors'), resolveCredential: broker.resolveGit }),
  objects: blobStore,               // существующий BlobStore runner'а (put/get/head)
  bindings: bindingStore,           // host-owned: tenant/profile → repository
  admin: repositoryAdmin,           // host-owned: create private repo (org credential здесь)
  journal: new WorkspaceJournal(join(stateDir, 'workspace')),  // init() при старте
});
```

### Где живёт организационный credential

Организационный токен **не** попадает ни в `RunSpec`, ни в события, ни в окружение
движка: он читается хостом через резолвер и уходит только в заголовок `Authorization`
запроса к GitHub API (и в `GIT_ASKPASS` для git-транспорта). В этой системе резолвер —
секрет Cloudflare Worker `trained-assist-control-plane`:

| Секрет | Значение |
|---|---|
| `PROFILES_ARTIFACTS_GITHUB_TOKEN` | токен с `Contents:R/W` на org `profiles-artifacts` (создание приватных репозиториев профилей) |

`tokenRef` для вызова — строка-ссылка, например `github:profiles-artifacts`; резолвер
сопоставляет её с секретом и возвращает значение только в процесс хоста. В журнале и в
логах пишется только `tokenRef`, никогда значение.

> Сейчас в секрете лежит личный OAuth-токен владельца с широкими правами. Для боевого
> контура его нужно заменить на fine-grained PAT с `Contents:R/W` на `profiles-artifacts`
> (и на право удаления репозитория, если понадобится откат) — имя секрета менять не нужно.


### Ветка рана и адреса (согласовано с внешним воркером)

Каждый ран публикует свою ветку `agent-run/<runId>` (host-синхронизация — `profile-sync/<id>`).
В публикации (`WorkspacePublication`) ветка лежит в поле `branch`; коммит ветки — в
`candidateCommit`, коммит основной ветки после merge — в `committedRevision`.

Три уровня адреса считаются хелперами `src/workspace/branches.ts` (без знания внутренностей):

```ts
import { branchUrl, mergeUrl, artifactUrl } from './workspace/index.js';

branchUrl(binding.repository, publication.branch);                       // весь результат рана
mergeUrl(binding.repository, publication.branch, binding.branch);        // куда мержить
artifactUrl(binding.repository, publication.committedRevision, path);    // конкретный файл
```

Основная ветка профиля обновляется **из ветки рана**: fast-forward, если она не двигалась,
иначе merge-коммит с двумя родителями. Внешний воркер (PR #75) в чужой репозиторий не мержит
— отдаёт клиенту merge-URL; здесь публикуется наше состояние профиля, поэтому merge остаётся.

Уборка веток рана после merge — отдельным явным вызовом (`deleteRef`); по умолчанию ветки
остаются как история того, что сделал каждый ран.

### H2. Политика экспорта

По умолчанию включён deny-list (`DEFAULT_EXPORT_POLICY`): credentials, git, входы рана,
runtime движка и логи исключены; неизвестный пользовательский файл публикуется. Для
импорта legacy-профилей соберите `compileCleanListRules()` из
`config/profile-clean-list.yaml` и передайте в `policy.rules` — совместимость схем
проверена тестом. `policyId` пишется в каждую публикацию (`exportPolicyId`), поэтому
смена политики видна по записям.

### H3. До старта движка: `prepare_profile_workspace`

```ts
const prepared = await workspace.prepareProfileWorkspace({
  operationId: `prep:${runId}:${attempt}`, tenantId, profileId,
  revision: request.profileRevision ?? null,        // null → актуальная голова
  credentialTokenRef: 'github:profiles-artifacts',
});
// prepared.baseRevision → в RunSpec рана (новое необязательное поле) и в событие
// prepared.manifest → залить байты в artifact store рана и записать снимок:
//   for (const entry of prepared.manifest) {
//     const bytes = entry.artifact ? await blobStore.get(entry.artifact.key)
//                                 : await workspace.readProfileBlob(profileId, prepared.baseRevision, entry.path);
//     const artifactId = await artifactStore.put(runId, profileId, entry.path, bytes);
//     snapshotStore.recordArtifact(snapshotId, { path: entry.path, artifactId, sha256: entry.sha256, size: entry.size, name, mime: entry.mime });
//   }
//   snapshotStore.commit(snapshotId) → snapshotId в input.refs[].snapshotId (Runner #69)
```

Новое необязательное поле `RunSpec.profileWorkspace = { bindingId, baseRevision,
workspaceSnapshotId, exportPolicyId }` — **предложение интегратору**: без него
`baseRevision` неоткуда взять в `publish_run_changes`. Альтернатива без изменения
`RunSpec`: хранить `(runId → baseRevision)` в control plane и передавать в publish.
Модуль работает в обоих вариантах.

Агент при этом не выбирает binding и не видит git: он получает только материализованные
файлы.

### H4. После engine exit: `publish_run_changes`

```ts
const publication = await workspace.publishRunChanges({
  operationId: `pub:${runId}`, tenantId, profileId, runId, ownerGeneration,
  workspacePath: runCwd, baseRevision: run.profileWorkspace.baseRevision,
  paths: request.workspacePaths, credentialTokenRef: 'github:profiles-artifacts',
});
// статус публикации — отдельное событие: publication.published | publication.conflict |
// publication.pending | publication.awaiting_user_input | publication.failed
```

Вызов идемпотентен по `operationId`: повтор финализации не создаёт второй коммит и не
публикует дважды. Отказ хранилища приходит исключением — финализатор может повторить
тот же `operationId` позже.

Архивирование и уборка — **отдельные** операции после публикации:

```ts
if (publication.status === 'published') { /* cleanup по политике хоста */ }
else { /* evaluateWorkspaceCleanup → cleanupAllowed: false, retained: [...] */ }
```

### H5. Статус и конфликты (API/UI)

```ts
const status = await workspace.getWorkspacePublication({ publicationId, tenantId });  // + reconcile
const cleanup = workspace.evaluateWorkspaceCleanup({ publicationId });
// conflictId из status → resolve_workspace_conflict → publish_workspace_resolution
```

`resolve_workspace_conflict` готовит кандидата, `publish_workspace_resolution`
публикует его **только** при `expectedHeadRevision`, совпадающем с текущей головой; если
голова успела измениться, кандидат не публикуется, а возвращается новый конфликт.
Запуск resolver-агента (если он нужен) — зона интегратора: модуль ждёт готовое дерево
кандидата и evidence.

### Живая проверка (уже выполнена)

`scripts/workspace-live-probe.mjs` прогоняет восемь методов на настоящем GitHub в org
`profiles-artifacts`: создаёт приватный одноразовый репозиторий, проходит полный цикл и
удаляет репозиторий и состояние в конце. Прогон 04.10.2026: **11/11 шагов** (ensure,
идемпотентный ensure, publish, prepare с хэшами, тяжёлый артефакт 3 МБ по ref, два рана с
автоматическим merge, same-file конфликт с чтением кандидата, stale candidate,
durable-статус после «рестарта», отказ чужому tenant). Транзиентные сбои сети
(`Connection reset by peer`) повторяются с backoff — классификатор отличает их от
финальных ошибок (401/403, «not found», «does not appear to be a git repository»).

```bash
npm run build
WORKSPACE_LIVE_OWNER=profiles-artifacts \
WORKSPACE_LIVE_TOKEN_REF=github:profiles-artifacts \
WORKSPACE_LIVE_TOKEN=<token> \
node scripts/workspace-live-probe.mjs          # --keep оставляет репозиторий и state
```
  policy: compiledExportPolicy,     // см. H2
});
```

`journal.init()` при старте воркера: durable-записи переживают рестарт, битый журнал
останавливает старт, а не сбрасывается молча.

## Чего модуль не делает

- Не запускает и не перезапускает движок; при потере связи не создаёт второй ран.
- Не архивирует и не удаляет: только выдаёт решение `cleanupAllowed` с перечнем
  удерживаемого.
- Не создаёт agent runtime для resolver'а и не реализует MCP/GTD.
- Не знает про control plane, Task Store и intake envelope: связь задачи с публикацией
  хранит интегратор (по `publicationId` и `operationId`).
- Не работает с живыми профилями и production-репозиториями: приёмка — на копиях и
  synthetic-профилях.

## Приёмка модуля

`npx vitest run test/workspace-*.test.ts` — 100 тестов, без сети и без внешних
сервисов: bare-репозитории на диске, object storage и binding-хранилище в памяти.
Покрыты: идемпотентный ensure, отказ adopt'а чужого репозитория, возобновление batch
после сбоя, импорт с сохранением хэшей и без credential'ов, `publish → prepare` на
другом каталоге, тяжёлый артефакт по ref, подменённый артефакт как warning, изоляция
профиля, pull не затирает локальные изменения, слияние непересекающихся правок,
same-file/edit-delete/rename конфликты, устаревший кандидат, crash и unknown push,
rejected push, storage failure с удержанием sole copy, лимит попыток разрешения.

Живая проверка (disposable private repo + synthetic profile) — отдельная задача
интегратора; модуль для неё готов, но сам в сеть не ходит.
