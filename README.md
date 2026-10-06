# AI Agent Runner

API и host-компоненты выполнения ai-agent-job. Run имеет отдельную идентичность, clean room, разрешённый context/env, наблюдаемый результат и lifecycle сохранения данных.

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

## Границы

- Клиент работает через async API: admission receipt, status/events, result, cancel. Квитанция не означает завершение.
- External worker запускает выбранный engine; API/host сверяют результат. Unknown launch/result не разрешает новый dispatch без reconcile.
- WorkspaceService готовит постоянный профиль и публикует разрешённые изменения через единый CAS/conflict flow. Run branch/compare URL не означают canonical publication.
- Тяжёлые объекты сохраняются в durable object storage; engine/publication/cleanup имеют разные статусы. Очистка не удаляет sole copy.
- Identity, repository binding, credential refs и placement выдаёт host, а не модель.

## Документы и код

| Граница | Источник |
|---|---|
| Модель и ownership | [ARCHITECTURE](ARCHITECTURE.md), [общая архитектура](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md) |
| API/config/operator procedures | [API service](docs/API-SERVICE.md), [external worker contract](docs/EXTERNAL-WORKER-CONTRACT.md) |
| Workspace | [H1–H5](docs/workspace-module-hooks.md), `src/workspace/`, `test/workspace-service.test.ts` |
| Contract validation | `src/contracts/` |
| API lifecycle | `src/api/`, `src/adapters/external-worker-adapter.ts` |
| Scoped MCP | [MCP lifecycle](docs/MCP-LIFECYCLE.md) |
| Регионы и изоляция | [Multi-worker](docs/MULTI-WORKER-REGION.md) |

## Проверка

Node >=20 согласно package.json. Команды не запускают cloud deployment:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Live probes используют synthetic profiles и scoped test credentials; smoke модуля отдельно от API canary. Конфигурация читается из действующего operator документа, а не из исторического roadmap.

## Источник статуса

[Persistence #95](https://github.com/trained-assist/ai-agent-runner/issues/95), [региональные workers #136](https://github.com/trained-assist/ai-agent-runner/issues/136), [интегратор](https://github.com/trained-assist/trained-agent-architecture/issues/140). Проверяйте source/deployed SHA: наличие кода и зелёный CI не означают live readiness.

Retiring GCP VM is not a development or fallback target. Use the own Agent Run API and serverless by default; a necessary persistent service belongs on the existing French VM. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.
