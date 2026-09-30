# Agent Runner — draft архитектуры

Статус: proposal v0.1 · 30.09.2026. Это проект границы компонента, а не описание уже развёрнутого отдельного сервиса.

## 1. Зачем отдельный репозиторий

Agent Runner выносит инфраструктуру исполнения из ядра: подготовку среды, запуск движка, управление процессами, сохранение результата и очистку. Core остаётся владельцем задачи, пользовательского сценария и решения о её завершённости. Runner можно версионировать и проверять отдельно от Telegram, web и бизнес-логики.

Описание «передать job на VM, запустить скрипт с нужными правами и получить результат» верно как общая схема. Разделяем два действия: control plane выбирает worker, а host-local Runner исполняет запуск. Произвольный скрипт с привилегиями не является публичным контрактом. Runner использует установленный adapter движка и разрешённый RunSpec.

Общие определения и контракты остаются в [архитектурном notebook](https://github.com/trained-assist/trained-agent-architecture). Здесь уточняем их исполнение.

## 2. Сущности и область

| Сущность | Значение |
|---|---|
| Job | Определённая работа; идентификатор сохраняется между попытками |
| ai-agent-job | Агентский цикл с разрешёнными инструментами и самостоятельными действиями |
| Agent run / Run | Одна попытка исполнения Job; повтор получает новый runId |
| Agent engine | Claude Code, Codex, OpenCode или другой поддержанный движок |
| Agent clean room | Граница доступа для конкретного исполнения |
| Agent Runner | Компонент жизненного цикла Run |
| Аренда ресурса исполнения | Временное выделение ёмкости хоста; это не работающий процесс |

Runner обслуживает **ai-agent-job**. **llm-recipe-job** получает подготовленный input и возвращает output, без shell, browsing, tools и самостоятельного чтения пользовательских данных. **deterministic-job** исполняет заранее определённый код обычным worker с явными правами. Недоверенный код требует собственной подходящей изоляции; название типа Job само по себе прав не даёт.

Термины Job и Run согласованы с подходом OpenLineage. Agent clean room — наше имя среды, не название фреймворка. Sandbox в engineering-документах означает среду разработки и проверки.

## 3. Границы ответственности

| Компонент | Отвечает за |
|---|---|
| Core / control plane | Durable task state, admission, план, acceptance, расписание, GTD, политика retry и отмены |
| Router / dispatcher | Выбор доступного worker по региону, движку, политике и ёмкости |
| Agent Runner | Проверку RunSpec, локальную аренду, clean room, engine process tree, heartbeat, журнал событий, результат и очистку |
| Profile / artifact storage | Постоянные данные, версии, артефакты и правила фиксации изменений |
| Credential broker | Хранение секретов, выдачу ограниченных bindings, обновление и отзыв |
| Tool broker / domain tools | Авторизацию и выполнение действий в сторонних сервисах |
| LLM gateway / ledger | Проверку бюджета в своей точке контроля, usage/cost accounting |
| Channel gateways | Telegram/web и другие каналы, rendering и подтверждение доставки |

Runner не хранит вторую самостоятельную очередь бизнес-задач и не решает, достигнута ли цель пользователя. Он хранит локальные записи Run, необходимые для восстановления фактических процессов и передачи событий. Core остаётся единственным владельцем логического состояния задачи.

Первый вариант может быть библиотекой с локальным adapter на VM. Удалённый authenticated worker API добавляем при необходимости нескольких workers. SSH и пересылка shell-скриптов не обязательны.

## 4. Целевой жизненный цикл

1. Принять и проверить RunSpec, полномочия владельца и совместимость worker.
2. Зарезервировать ресурсы; записать durable receipt до запуска.
3. Материализовать разрешённый snapshot пользовательских текстовых данных и ссылок на артефакты. Для разового API-запуска использовать временный input без постоянного профиля.
4. Подготовить clean room, минимальную environment, credential/tool bindings и engine adapter.
5. Запустить engine, публиковать последовательные события и heartbeat, следить за лимитами.
6. Зафиксировать outcome процесса и manifest результата; сохранить данные по storage contract.
7. Завершить дочерние процессы, отозвать bindings и доступы, удалить временные данные, освободить аренду.
8. Сделать результат доступным control plane для acceptance и доставки в канал/API.

Очистка не должна уничтожать единственную копию результата до подтверждённого сохранения. При сбое export сохраняется восстанавливаемый journal/manifest; срок удержания и место хранения требуют решения. API destination должен быть заранее разрешён host policy, а не произвольным URL из ответа модели.

Успешный exit code не означает успешное сохранение, выполнение пользовательской цели или доставку сообщения. Эти состояния учитываются отдельно.

## 5. Контракты

Согласуем с [C04/C05 и соседними контрактами платформы](https://github.com/trained-assist/trained-agent-architecture/blob/main/contracts/README.md). Имена ниже логические; transport и точная схема пока не выбраны.

| Операция | Семантика |
|---|---|
| startRun(RunSpec, operationId) | Durable receipt с runId; повтор совместимого operationId возвращает тот же запуск, другой payload — conflict |
| cancelRun(runId, ownerGeneration) | Запрос остановки; подтверждение stopped приходит после остановки process tree |
| getRun(runId) | Фактическое состояние, heartbeat, outcome, refs, persistence и cleanup status |
| events(runId, afterSequence) | Повторяемый поток событий для восстановления после разрыва связи |
| capabilities / health | Регион, движки, isolation modes, лимиты, свободная ёмкость, readiness |
| reconcile | Сопоставление локальных записей с живыми процессами и незавершённым сохранением/очисткой |

### RunSpec — минимальные группы полей

- Версия контракта, jobId, runId, operationId, task/session correlation, ownerGeneration.
- engine и версия adapter, разрешённые настройки модели.
- Input snapshot refs и версии; profileRef опционален; host-resolved workspace bindings.
- Isolation policy, region constraints, resource limits, deadline.
- Credential и tool binding refs с областями доступа и сроком действия.
- Budget/cost correlation refs; result destination и retention policy.

RunSpec разрешает доверенный control plane. Runner проверяет его по своей политике. Секреты не включаются в журналы или сериализованный публичный spec. Путь, engine command и права не выбираются моделью как доверенные параметры.

### События и результат

Envelope содержит schemaVersion, eventId, runId, jobId, ownerGeneration, sequence и timestamp. Поддерживаем durable outbox/replay и дедупликацию потребителя. Heartbeat не заменяет durable outcome.

Result manifest содержит outcome, exit reason/code, output refs, session/trace refs, input/output versions, usage refs и раздельные persistence/cleanup statuses. Чувствительный stdout требует redaction и retention policy.

Для OpenLineage проектируем события START, RUNNING и один terminal COMPLETE / FAIL / ABORT; OTHER — только по согласованной семантике. После terminal не дописываем обычные lifecycle events того же Run; операционные события доставки/очистки учитываем отдельно. Retry создаёт новый Run. SDK и custom facets пока не выбраны.

## 6. Изоляция: что есть и чего ещё нет

Основа аудита — core [trained-assist](https://github.com/trained-assist/trained-assist-agent) на revision **c83e6931d61ddb205779ee670e4c4c59b26580eb**. Пути ниже относятся к изученному core; развёрнутые настройки VM отдельно не проверены.

| Механизм в текущем core | Ограничение |
|---|---|
| Node.js + Linux primitives; src/agent-isolation.js | Собственная реализация, отдельного container framework не обнаружено |
| Пул непривилегированных Unix users, sudo -n -u, lock files | Изоляция T0 опциональна; локальные leases не являются межмашинным fencing |
| setfacl gates и ACL journal | Постоянный профиль и .agent-home сохраняются; полный ephemeral snapshot lifecycle не доказан |
| Минимальный env, host-owned token refresh | Требуется отдельная проверка каждого engine и credential adapter |
| Release убивает процессы пользователя и отзывает доступы | Нужны recovery-проверки после crash и безопасного повторного использования UID |
| MCP через Unix socket bridge и run token | MCP servers работают как service user: bridge сам по себе не ограничивает их filesystem-права |
| iptables/ip6tables owner rules | Блокируются metadata и выбранные local TCP направления; это не полный egress allowlist |

В **src/runner/engine-isolation.js** Codex явно исключён из run-as; cwd вне профиля также обходит run-as. В этих ветках остаются env allowlist/MCP bridge. Их нельзя документировать как уже обеспеченный Agent clean room.

Другие ограничения: hidepid не является установленной общей границей; per-run CPU/memory limits не подтверждены; Codex auth writeback использует last-writer-wins; профильный HOME постоянный. Git worktree отделяет изменения кода, но не заменяет OS security boundary.

### Целевые требования

- Доступ только к разрешённому input, workspace, session state и tool bindings.
- Изоляция соседних пользователей и запусков, host credentials и control plane.
- Явные filesystem/network/process/resource policies для каждого движка.
- Запрет привилегированного fallback при невозможности выполнить isolation policy.
- Ограничение прав host-side tools, даже когда инструмент запускается другим UID.
- Отзыв доступа после остановки, отсутствие процессов и секретов перед повторной арендой.

Технологический выбор открыт: сохранить OS users/ACL как baseline либо добавить namespaces/cgroups/контейнеры или иную границу. Выбираем по проверяемым свойствам, а не названию clean room.

## 7. Надёжность и ownership

Три уровня не смешиваем:

1. **Execution supervision** в Runner: жив ли процесс, heartbeat, exit, cleanup и восстановление локального журнала.
2. **Task completion / GTD** в control plane: достигнута ли цель, нужна ли новая попытка или запуск по расписанию.
3. **Playbook conformance** вне Runner: выполнены ли шаги процесса, например тестирование после релиза и создание epic.

Runner после рестарта восстанавливает известные процессы или фиксирует потерю исполнения. Он не запускает новый бизнес-Run по собственной GTD-политике.

Логическая аренда и ownerGeneration должны защищать от поздних событий прежнего владельца. При потере связи control plane сначала reconcile, затем принимает решение о новом Run. Lease expiry само по себе не гарантирует, что старый процесс остановлен. Для внешних изменений нужны idempotency keys и reconciliation неизвестного outcome; универсальное exactly-once обещание не даём.

Отмена задачи отключает дальнейшие retries/GTD для этой работы в control plane. Локальный cancel Runner останавливает process tree. Транспортная ошибка не означает stopped.

Serialisation учитывает conversation/session writer keys, а не обязательную глобальную блокировку всего профиля: разные допустимые сессии могут идти параллельно. Storage commit должен обнаруживать конфликты версий. Существующий SQLite execution-owner-lock решает локальное владение одним data root, но не координирует независимые VM.

## 8. Регионы, credentials и стоимость

Целевая политика: Claude Code и Codex запускаются вне российской зоны; OpenCode допускается в обеих зонах с учётом ограничений конкретной модели, tools и данных. Router выбирает worker, Runner повторно проверяет region/policy compatibility. Совпадение engine name недостаточно.

Постоянные общие, частные и заменяемые credentials остаются в broker. Runner получает минимальные bindings на Run; engine не получает весь credstore. Обновление токенов выполняет host-side adapter. Playground credential и пользовательская замена разрешаются до запуска с понятной provenance.

Сохраняем engine session logs, normalized run events и связи с LLM accounting. Ledger/gateway получает jobId/runId и usage/cost correlation. Неизвестная стоимость — unknown, а не ноль. При отсутствии бюджета возвращаем структурированный отказ; channel gateway формирует пользовательское сообщение.

Факт существования LLM Ledger сообщён владельцем. Конкретный полный путь accounting нужно подтвердить: изученный llm-ladder не доказывает покрытие всех engine calls и streaming usage. Разные engine traces также пока не имеют единого подтверждённого retention/export контракта.

## 9. Выделение из core

1. Согласовать RunSpec, события и ownership; подготовить fake adapter.
2. Выделить библиотеку Runner и подключить core через versioned adapter без импортов внутренних модулей core.
3. Перенести engine/process/изоляцию; проверить каждый движок, включая Codex и внешние cwd.
4. Проверить snapshot, result persistence, cleanup и recovery на отдельной engineering VM с синтетическими данными.
5. Добавить worker API и межмашинные leases/fencing при переходе к нескольким workers.
6. Удалить legacy path после rollout evidence и совместимой rollback-процедуры.

Не копировать core целиком и не создавать второй scheduler. Связь с другими потенциальными runtime-репозиториями уточнить перед переносом кода, чтобы не поддерживать две реализации одного компонента.

### Проверки до первого production rollout

- [ ] Duplicate start до/после crash возвращает один запуск.
- [ ] Cancel останавливает engine и дочерние процессы; повтор cancel безопасен.
- [ ] Worker restart восстанавливает запись либо фиксирует потерю без скрытого rerun.
- [ ] Поздние события старого ownerGeneration не меняют текущую задачу.
- [ ] Cross-user filesystem/tool/credential probes блокируются для каждого engine.
- [ ] Isolation failure не запускает движок с более широкими правами.
- [ ] Сбой export не теряет результат; повтор commit не дублирует изменения.
- [ ] Cleanup crash восстанавливается; переиспользование ресурса не открывает прежние данные.
- [ ] Отсутствие бюджета, credentials и запрещённый регион дают структурированные outcomes.
- [ ] Streaming usage, engine logs и events связаны с Run и доступны после restart.

Для Sandbox Driven Development нужны воспроизводимые рецепты развертывания тестовой VM, storage, tool broker и fake LLM/ledger. Сначала проверяем lifecycle без платных моделей, затем отдельно реальные engine integrations.

## 10. Открытые решения

- [ ] Формат schemas, версия API и место публикации contract package.
- [ ] Библиотека, IPC или HTTP для первого этапа; модель аутентификации workers.
- [ ] Isolation baseline и обязательные capabilities каждого engine.
- [ ] Per-run или per-profile HOME; resume без утечки между runs.
- [ ] Разрешённые cwd и ограничение filesystem-доступа MCP servers.
- [ ] CPU/memory/process/network limits и enforcement.
- [ ] Distributed lease store, fencing и поведение при partition.
- [ ] Snapshot/commit semantics, параллельные session writers и conflict resolution.
- [ ] Result retention и гарантии export для one-shot API.
- [ ] Credential rotation/writeback, отзыв и срок жизни bindings.
- [ ] Полное покрытие LLM usage, бюджетов и session log export.
- [ ] Граница между этим Runner и существующими serverless wrappers.

Каждый epic должен ссылаться на конкретный контракт/требование и указывать: что меняется, как проверяется, какие пробелы остаются. Draft улучшаем по фактам реализации и проверок.
