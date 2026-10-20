# Repository instructions

This file only points at the guides. Working instructions live in the documents below, so
that a change to a procedure is made once, in the place that describes it, and not
duplicated here.

## Delivery and safety

- [Continuous delivery](docs/DELIVERY.md) — branch, draft PR, green checks, merge, deploy.
- [Prohibitions and restrictions](docs/PROHIBITIONS.md) — what may not be disabled, and the
  evidence a restriction needs before it is introduced.
- [Credentials](docs/CREDENTIALS.md) — which keychain items exist and how secrets are read.
- [Credential blast-radius drill](docs/CREDENTIAL-BLAST-RADIUS-DRILL.md) — where a
  credential value ends up, and what survives the host dying.

## Engineering practice

- [Sandbox-driven engineering](docs/SANDBOX-ENGINEERING.md) — run realistic inputs in a
  declared sandbox instead of stopping at code inspection.
- [Environment contract](docs/ENVIRONMENT-CONTRACT.md) — what each environment is, what it
  is not, and what a local test does and does not prove.

## Operations

- [VM worker operations](docs/VM-WORKER-OPERATIONS.md) — install, update, rollback, health.
- [VM worker secret inventory](docs/VM-WORKER-SECRET-INVENTORY.md) — which secret lives where.
- [Multi-worker region](docs/MULTI-WORKER-REGION.md) — placement, failover, and the
  France sandbox worker.
- [VM worker compatibility boundaries](docs/VM-WORKER-LEGACY-COMPATIBILITY.md) — what this
  worker is and is not.
- [Promotion](docs/PROMOTION.md) — the promotion journal and fleet acceptance.
- [GitHub Actions capability](docs/GITHUB-ACTIONS-CAPABILITY.md) — what running the Runner
  in Actions costs and requires.
- [GitHub Actions runner contract](docs/GITHUB-ACTIONS-RUNNER-CONTRACT.md) — the contract
  the runner keeps when it runs inside Actions.
- [API sandbox operations](docs/API-SANDBOX-OPERATIONS.md) — the isolated test API lane.
- [Cloudflare Runner API](docs/CLOUDFLARE-RUNNER-API.md) — the serving path and its secrets.
- [MCP lifecycle](docs/MCP-LIFECYCLE.md) — how MCP servers are attached and retired.
- [Remote MCP](docs/REMOTE-MCP.md) — remote MCP endpoints and their auth.
- [External worker contract](docs/EXTERNAL-WORKER-CONTRACT.md) — the adapter contract.
- [API service](docs/API-SERVICE.md) — the stateless API and its limits.
- [GHA client credential provisioning](docs/GHA-CLIENT-CREDENTIAL-PROVISIONING.md) — how
  Actions credentials are issued.
- [Workspace module hooks](docs/workspace-module-hooks.md) — module-level hooks.
- [TZ external OpenCode worker](docs/TZ-EXTERNAL-OPENCODE-WORKER.md) — the external
  OpenCode worker lane.
- [Capacity admission](docs/CAPACITY-ADMISSION-137.md) — admission control.
- [Capacity store](docs/CAPACITY-STORE-OPERATIONS.md) — the capacity store.
- [Developer API foundation](docs/DEVELOPER-API-FOUNDATION.md) — the API foundation.
- [M1 step 7 scenario](docs/M1-STEP7-SCENARIO.md) — the original acceptance scenario.
