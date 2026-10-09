# Agent Runner: границы и обязательства

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

## Сущности

Job описывает работу; Run — конкретное выполнение; Agent Runner — host/runtime, управляющий выполнением; external worker — выбранный исполнитель; Agent clean room — изолированная временная среда конкретного Run. Tenant/profile, conversation/userTaskId, jobId, runId, operationId, worker и ownerGeneration не взаимозаменяемы.

## Ownership

Control plane владеет durable задачей, маршрутом, ожиданиями и доставкой. Runner API принимает описание запуска, фиксирует admission и управляет связью с исполнителем. Worker владеет процессом движка и исполнением в выделенной среде. WorkspaceService владеет provisioning/binding, versioned canonical publication и конфликтами. Один coordinator вызывает публикацию, не два независимых merge engine.

## Lifecycle

1. Host проверяет principal/scope, tenant/profile/repository binding, placement, engine policy и resource admission.
2. Prepare фиксирует baseRevision и manifest до dispatch; materialize проверяет пути, ownership, размеры и checksum.
3. Async launch возвращает receipt; события/status/result связаны с тем же Run и generation. Потеря соединения даёт unknown/reconcile, а не новый запуск.
4. Worker сохраняет разрешённый candidate/output; host сверяет remote commit/ref или manifest, не доверяя одному URL.
5. WorkspaceService продвигает candidate через существующий CAS/conflict flow. Publication повторяется с тем же operationId; canonical committedRevision становится доступным следующему Run.
6. Engine outcome, publication и cleanup независимы. Cleanup разрешается после durable сохранения и проверки восстановления.

## Контракты

Wire schemas и runtime validation — `src/contracts/`; external transport — [EXTERNAL-WORKER-CONTRACT](docs/EXTERNAL-WORKER-CONTRACT.md); API operator config — [API-SERVICE](docs/API-SERVICE.md). `RunSpec`/callback не заменяют аутентификацию principal. Секреты хранятся у host/broker, в движок попадает только явный allowlist и scoped credential.

## Изоляция и процессы

Каждый Run не читает чужой profile, процессы и credentials. Уровень isolation объявляется capability/контрактом; неподдерживаемый режим отвергается, а не понижается молча. Отмена охватывает дерево процессов и не допускает stale результата. Права на профиль существуют только в пределах доверенной выдачи. Shared env, глобальный Git login и общий credential helper не являются допустимым resolver.

## Durable состояние

Stateless HTTP не означает отсутствия durable admission, binding, publication journal или recovery. Cache и зеркало Git могут быть временными; единственная копия canonical state/candidate/metadata не может находиться на исчезающем диске. Crash после remote CAS до записи committedRevision требует reconcile. Unknown внешняя мутация не повторяется вслепую.

Неуспешный/отменённый Run сохраняет проверенный partial candidate по host policy; это не разрешает автоматический canonical merge всех частичных файлов. Pending/conflict удерживает durable candidate и refs; resolver использует существующий conflict flow с ограниченными попытками и Awaiting user input.

## Регионы и ресурсы

Placement задаёт Runner API, не Control Plane. Этот sandbox Runner API закреплён за France VM execution worker; отказ worker даёт ошибку или `unknown`, без автоматического GHA fallback. GHA и региональная цепочка France → РФ → GHA из прежнего multi-worker плана не входят в этот runtime path. GCP VM не участвует в новых запусках.

## Наблюдаемость и приёмка

Structured events содержат profile/task/run/operation/generation и stage/status/reason, без значений secrets и приватных URL. TTL и scope — [общий контракт](https://github.com/trained-assist/trained-agent-architecture/blob/main/OBSERVABILITY-AND-ERROR-CONTRACT.md).

API canary проверяет receipt → engine → run branch/manifest → canonical publication → cleanup → следующий Run читает новый revision, включая concurrent CAS, conflict, повтор callback, storage failure и restart. CLI smoke, module tests и deployment acceptance — разные доказательства. Статус и план исполнения: [#95](https://github.com/trained-assist/ai-agent-runner/issues/95), [#136](https://github.com/trained-assist/ai-agent-runner/issues/136), [Integrator](https://github.com/trained-assist/trained-agent-architecture/issues/140).

Retiring GCP VM is not a development or fallback target. The Runner API is serverless on Cloudflare; its Durable Object owns admission and run state. The existing France VM is only the execution worker called by Runner API. The Control Plane reaches Runner API through a Cloudflare service binding and has no direct worker URL. GHA is not an execution fallback. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.
