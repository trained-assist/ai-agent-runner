# MCP lifecycle и scoped bindings (P13, этап I04)

Карточка [#52](https://github.com/trained-assist/trained-agent-architecture/issues/52), эпик [#21](https://github.com/trained-assist/trained-agent-architecture/issues/21).
Документ описывает долговременную архитектуру; статус и чек-лист приёмки — в issue.

## Топология рана

```
engine ──stdio──▶ broker (per-run proxy, значений binding'ов не видит)
                   │  unix socket + run token (0600)
                   ▼
                 хост: McpRunSession → McpRunScope → stdio MCP-сервер (per-run процесс)
                   │  capability/invoke
                   ▼
                 CapabilityRegistry (общий handler) → внешний доменный сервис
```

- **Agent-local MCP** (TASK-ROUTER-AND-MCP §5): локальный stdio process/proxy на ран с
  ограниченными bindings. Поднимает его runner, а не движок: движок получает только
  `RUNNER_MCP_CONFIG` (путь к 0600-конфигу в workspace) и спавнит broker сам.
- **Remote domain MCP** — общий внешний сервис, на каждый ран не поднимается. В песочнице
  это фикстура `scripts/fake-remote-domain-service.mjs`; в бою — доменный сервис с auth per
   operation. Достигается он через capability handler, а не через процесс.
- **Capability handler** — единственное место с доменной логикой вызова. Один и тот же
  handler обслуживает MCP-вызов рана и внутренний API control plane
  (`POST /v1/capabilities/invoke`): бизнес-логика не дублируется в транспортах.

## Контракт `RunSpec.mcp`

| Поле | Смысл |
|---|---|
| `servers[].serverId` | идентификатор сервера в пределах рана (уникальный) |
| `servers[].transport` | только `stdio` (remote transport у раннего агента отсутствует) |
| `servers[].command` / `args` | команда процесса; в логах публикуется только `commandRef` (sha256-префикс) |
| `servers[].envAllowlist` | имена переменных окружения хоста, которые видит процесс (без значений в контракте) |
| `servers[].bindingRef` | ссылка на `credentialBindings` рана; **обязана быть объявлена там** |
| `servers[].allowedTools` | приёмка хоста: инструмент вне списка не уходит в процесс |
| `servers[].readinessTimeoutMs` / `toolTimeoutMs` | таймауты handshake/readiness и вызова инструмента |

Имена MCP-инструментов образуют одно плоское пространство имён у клиента рана, поэтому
один инструмент может быть объявлен ровно одним сервером (проверка при валидации spec).
Имя инструмента равно `capabilityId` — один идентификатор для MCP, API facade и каталога.
Имена/каталог как отдельная тема — карточка #124, здесь не меняются.

## Scoped bindings: три слоя приёмки

1. **Объявление (статика, `validateRunSpec`)**: `bindingRef` сервера обязан быть в
   `credentialBindings` рана; статус `missing`/`expired` — отказ до спавна.
2. **Инструмент (рантайм, `McpRunScope.authorizeTool`)**: вызов инструмента вне
   `allowedTools` отклоняется до похода в дочерний процесс. Причина уходит в лог рана
   (`mcp.tool_denied reason=tool_not_in_scope`).
3. **Scope binding'а (хост, `CapabilityRegistry.invoke`)**: `requiredScopes` handler'а
   проверяются против `scope` binding'а рана. Отказ — `BINDING_SCOPE_MISSING`, до
   исходящего вызова наружу.

Значения credential binding'ов резолвятся host-owned резолвером
(`RunnerOptions.bindingResolver`; в бою — Credential Broker / Secret Manager) и живут
только в процессе хоста: в spec, state, events, логи, конфиг движка и окружение дочерних
процессов они не попадают. Дочерний процесс присылает на мост только `capabilityId` и
аргументы — binding и caller подставляет хост, поэтому процесс не может выбрать, под каким
binding'ом исполнить действие.

## Жизненный цикл процессов

| Стадия | Что происходит | Событие в логе рана |
|---|---|---|
| Спавн | `detached: true`, своя группа процессов, окружение только из allowlist + координаты моста | `mcp.server_starting`, `mcp.server_spawned` |
| Handshake | `initialize` (protocolVersion 2025-06-18, согласование), затем `notifications/initialized` | `mcp.server_ready` (protocolVersion, serverInfo, scopedTools, bindingRef/Scope, pid, `isolation=same_service_uid_not_os_isolated`) |
| Readiness | сервер обязан объявить capability `tools` и предложить хотя бы один объявленный инструмент | `mcp.server_start_failed reason=readiness_failed` при отказе |
| Вызов | `tools/call` с таймаутом; зависший инструмент гасит сервер (fail-closed) | `mcp.tool_invoked`, `mcp.tool_result` (с `effectReceiptId`), `mcp.tool_timeout` |
| Отказ | scope/binding/инструмент вне объявления | `mcp.tool_denied`, `mcp.capability_denied`, `mcp.binding_denied`, `mcp.binding_unavailable` |
| Cleanup | SIGTERM → grace → SIGKILL, проверка смерти процесса | `mcp.server_cleanup` (signal/outcome/alive/elapsedMs), `mcp.session_cleanup` |
| Рестарт воркера | per-run процессы MCP не умирают с воркером: `recover()` дочищает их по pid из `state.json` | `mcp.orphan_reaped` |

Старт MCP идёт **до** спавна движка: отказ (spawn/handshake/readiness/binding) валит
старт рана с `failure.code = MCP_STARTUP_FAILED` и `exitReason = startup_failure`, движок
при этом не запускается. Fault point `mcp` позволяет внедрить сбой этой стадии в тестах.

## Что намеренно НЕ заявлено

- **OS-изоляция.** Per-run процессы MCP стартуют под тем же service UID, что и runner.
  UID сервиса не является доказанной границей изоляции (ARCHITECTURE §9). Это записано в
  логах (`isolation=same_service_uid_not_os_isolated`), в `GET /v1/capabilities`
  (`mcp.osIsolation: not_proven_service_uid_only`) и в транскрипте приёмки.
- **Run token моста виден движку.** Broker спавнится движком из того же пользователя и
  workspace, поэтому токен per-run моста лежит в 0600-конфиге рана. Это координата
  per-run процесса, а не изоляционная граница: приёмку выполняют host-side scoped
  bindings, которые процесс обойти не может.
- **Remote transport у раннего агента** (`mcp.remoteTransport: absent`) и каталог/имена
  MCP-инструментов (карточка #124) — вне этой карточки.

## Доказательство

`scripts/mcp-lifecycle-probe.mjs` гоняет пять сценариев на реальных процессах и пишет
sanitized-транскрипт (`docs/evidence/p13-mcp-lifecycle*/transcript.json` + sha256):

1. реальный вызов инструмента (write + read) с квитанциями эффекта внешнего сервиса;
2. управляемые сбои: упавший старт, зависший handshake, зависший инструмент;
3. отмена рана и гашение MCP-процессов;
4. рестарт воркера и дочистка осиротевшего MCP-процесса;
5. отсутствие значений binding'ов на всех поверхностях (events/state/result/конфиг/evidence/журнал сервиса).

Тесты: `test/mcp-lifecycle.test.ts` (12), `test/capability-facade.test.ts` (2).
