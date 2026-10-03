#!/usr/bin/env bash
# Пересоздание чистой песочницы для приёмки P29 (промоушен, этап I10).
#
# Скрипт создаёт НОВЫЙ namespace эксперимента: отдельные data/config корни на каждый
# воркер, свежие ключи, закреплённые манифесты релиза и общий реестр владения задачами.
# Ничего за пределами namespace не создаётся и не удаляется; существующий namespace
# не переиспользуется, а откладывается в сторону (<ns>.replaced-<ts>) — «чистое» здесь
# означает «пустое», а не «снесённое».
#
# Usage: sudo scripts/recreate-sandbox.sh --namespace <id> [options]
#   --namespace <id>       имя namespace (обязательно), напр. p29-20261003
#   --fleet-root <dir>     корень флота (по умолчанию /var/lib/agent-runner-fleet)
#   --workers <a,b>        воркеры симуляции (по умолчанию a,b)
#   --base-port <n>        порт первого воркера (по умолчанию 8790), второй = +1
#   --source-commit <sha>  закреплённый source commit (по умолчанию git HEAD репозитория)
#   --config-version <n>   configVersion кандидата (по умолчанию 2), предыдущий = на единицу меньше
#   --release-id <id>      релиз кандидата (по умолчанию <ns>-r2)
#   --previous-release <id> предыдущий релиз для отката (по умолчанию <ns>-r1)
#   --region <r>           регион в host-manifest (по умолчанию sandbox-eu)
#   --owner <user>         владелец файлов (по умолчанию текущий пользователь)
#   --replace              отложить существующий namespace в сторону и создать новый
#   -h, --help             эта справка
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NAMESPACE=""
FLEET_ROOT="${FLEET_ROOT:-/var/lib/agent-runner-fleet}"
WORKERS="a,b"
BASE_PORT="${AGENT_API_PORT:-8790}"
SOURCE_COMMIT=""
CONFIG_VERSION=2
RELEASE_ID=""
PREVIOUS_RELEASE=""
REGION="sandbox-eu"
OWNER=""
REPLACE=0

log() { printf '[recreate-sandbox] %s\n' "$*"; }
die() { printf '[recreate-sandbox] ERROR: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="${2:-}"; shift 2 ;;
    --fleet-root) FLEET_ROOT="${2:-}"; shift 2 ;;
    --workers) WORKERS="${2:-}"; shift 2 ;;
    --base-port) BASE_PORT="${2:-}"; shift 2 ;;
    --source-commit) SOURCE_COMMIT="${2:-}"; shift 2 ;;
    --config-version) CONFIG_VERSION="${2:-}"; shift 2 ;;
    --release-id) RELEASE_ID="${2:-}"; shift 2 ;;
    --previous-release) PREVIOUS_RELEASE="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --owner) OWNER="${2:-}"; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option $1" ;;
  esac
done

[[ -n "$NAMESPACE" ]] || die "--namespace is required"
[[ "$NAMESPACE" =~ ^[a-z0-9][a-z0-9-]{2,40}$ ]] || die "--namespace: expected lowercase id, got \"$NAMESPACE\""
[[ "$BASE_PORT" =~ ^[0-9]+$ ]] || die "--base-port: expected a number"
BASE_PORT=$((10#$BASE_PORT))
(( BASE_PORT > 1024 && BASE_PORT < 65000 )) || die "--base-port: out of range"
[[ "$CONFIG_VERSION" =~ ^[0-9]+$ ]] && CONFIG_VERSION=$((10#$CONFIG_VERSION)) || die "--config-version: expected a number"
(( CONFIG_VERSION >= 2 )) || die "--config-version: expected at least 2 (the previous release carries a lower config version)"
command -v openssl >/dev/null || die "openssl not found (used for fresh sandbox keys)"
OWNER="${OWNER:-$(id -un)}"
id "$OWNER" >/dev/null || die "owner $OWNER does not exist"

if [[ -z "$SOURCE_COMMIT" ]]; then
  [[ -d "$REPO_DIR/.git" ]] || die "no git checkout at $REPO_DIR and no --source-commit given"
  SOURCE_COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD)"
fi
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "--source-commit: expected a pinned 40-hex commit, got \"$SOURCE_COMMIT\""
RELEASE_ID="${RELEASE_ID:-$NAMESPACE-r2}"
PREVIOUS_RELEASE="${PREVIOUS_RELEASE:-$NAMESPACE-r1}"

NS_ROOT="$FLEET_ROOT/$NAMESPACE"
if [[ -e "$NS_ROOT" ]]; then
  if [[ $REPLACE -eq 0 ]]; then
    die "namespace $NAMESPACE already exists at $NS_ROOT; pass --replace to move it aside (nothing is deleted)"
  fi
  ASIDE="$NS_ROOT.replaced-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$NS_ROOT" "$ASIDE"
  log "previous namespace moved aside: $ASIDE (data preserved, not deleted)"
fi

install -d -m 0750 -o "$OWNER" -g "$(id -gn "$OWNER")" "$FLEET_ROOT"
install -d -m 0700 -o "$OWNER" -g "$(id -gn "$OWNER")" "$NS_ROOT" "$NS_ROOT/fleet" "$NS_ROOT/config"

# Ключи, общие для всего namespace: клиентский ключ control plane (его знает каждый воркер
# релиза — так проверяется «одна задача — один владелец») и ключ принципала вне когорты
# (отрицательные проверки приёма). Пишутся один раз на namespace, значения — только сюда.
umask 077
client_key="ak_$(openssl rand -hex 24)"
outsider_key="ak_$(openssl rand -hex 24)"
printf '%s\n' "$client_key" > "$NS_ROOT/config/client-api-key"
printf '%s\n' "$outsider_key" > "$NS_ROOT/config/outsider-api-key"
chmod 0600 "$NS_ROOT/config/client-api-key" "$NS_ROOT/config/outsider-api-key"
client_hash="$(printf '%s' "$client_key" | sha256sum | awk '{print $1}')"
outsider_hash="$(printf '%s' "$outsider_key" | sha256sum | awk '{print $1}')"
log "client key (principal p29-client) и outsider key (p29-outsider, вне когорты) выпущены для namespace"

# Локальный fixture-репозиторий: ран клонирует его вместо GitHub — прогон не зависит от
# сети и не тянет чужой репозиторий в песочницу (SANDBOX: свои данные, свои зависимости).
FIXTURE_REPO="$NS_ROOT/config/fixture-repo.git"
git init --quiet --bare "$FIXTURE_REPO"
# Временный каталог — только внутри namespace: проба не оставляет следов в /tmp,
# а удаление исходника fixture необратимо (создаётся один раз на namespace).
FIXTURE_SRC="$(mktemp -d "$NS_ROOT/.fixture-src-XXXXXX")"
git -C "$FIXTURE_SRC" init -q -b main
git -C "$FIXTURE_SRC" config user.email "sandbox@local"
git -C "$FIXTURE_SRC" config user.name "sandbox"
printf '# sandbox fixture repository\n\nКонтекст рана для приёмки P29: локальный, без сети и без чужих данных.\n' > "$FIXTURE_SRC/README.md"
git -C "$FIXTURE_SRC" add README.md
git -C "$FIXTURE_SRC" commit -qm "sandbox fixture"
git -C "$FIXTURE_SRC" push -q "$FIXTURE_REPO" HEAD:main
rm -rf "$FIXTURE_SRC"
log "fixture-репозиторий: $FIXTURE_REPO"

WORKER_LIST=()
IFS=',' read -r -a WORKER_LIST <<< "$WORKERS"
[[ ${#WORKER_LIST[@]} -gt 0 ]] || die "--workers: expected at least one worker id"
[[ "${#WORKER_LIST[@]}" -le 2 ]] || die "--workers: the sandbox simulation covers one or two workers"

WORKERS_JSON=""
index=0
for worker in "${WORKER_LIST[@]}"; do
  [[ "$worker" =~ ^[a-z0-9][a-z0-9-]{0,15}$ ]] || die "--workers: bad worker id \"$worker\""
  port=$((BASE_PORT + index))
  # Кандидат и предыдущий релиз: воркер b обслуживает предыдущий релиз — это и есть
  # «прежний владелец», к которому возвращается приём после отката.
  if [[ $index -eq 0 ]]; then release_id="$RELEASE_ID"; else release_id="$PREVIOUS_RELEASE"; fi
  config_version=$((index == 0 ? CONFIG_VERSION : CONFIG_VERSION - 1))
  worker_root="$NS_ROOT/worker-$worker"
  config_dir="$worker_root/config"
  data_dir="$worker_root/data"
  install -d -m 0700 -o "$OWNER" -g "$(id -gn "$OWNER")" "$worker_root" "$config_dir" "$data_dir" "$worker_root/logs"

  umask 077
  key="ak_$(openssl rand -hex 24)"
  printf '%s\n' "$key" > "$config_dir/api-key"
  key_hash="$(printf '%s' "$key" | sha256sum | awk '{print $1}')"
  share_secret="$(openssl rand -hex 32)"

  cat > "$config_dir/key-registry.json" <<JSON
{
  "schemaVersion": 1,
  "principals": [
    {
      "keyHash": "$key_hash",
      "principalId": "sandbox-$worker",
      "profileId": "profile-p29-$worker",
      "scopes": ["runs:read", "runs:write"],
      "engines": ["fake"]
    },
    {
      "keyHash": "$client_hash",
      "principalId": "p29-client",
      "profileId": "profile-p29-client",
      "scopes": ["runs:read", "runs:write"],
      "engines": ["fake"]
    },
    {
      "keyHash": "$outsider_hash",
      "principalId": "p29-outsider",
      "profileId": "profile-p29-outsider",
      "scopes": ["runs:read", "runs:write"],
      "engines": ["fake", "opencode"]
    }
  ]
}
JSON

  cat > "$config_dir/release.json" <<JSON
{
  "schemaVersion": 1,
  "releaseId": "$release_id",
  "sourceCommit": "$SOURCE_COMMIT",
  "configVersion": $config_version,
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "engines": ["fake"],
  "paid": { "engines": ["opencode", "claude", "codex"], "allowed": false },
  "bindings": [
    { "name": "AGENT_API_KEY_REGISTRY", "required": true, "source": "env:$config_dir/worker.env", "owner": "$OWNER" },
    { "name": "ARTIFACT_SHARE_SECRET", "required": true, "source": "env:$config_dir/worker.env", "owner": "$OWNER" }
  ],
  "retention": { "mainEventsDays": 30, "verboseLogsDays": 7 },
  "host": {
    "workerId": "sandbox-$worker",
    "region": "$REGION",
    "environment": "sandbox",
    "roles": { "schedule": false, "delivery": false },
    "roots": { "dataDir": "$data_dir", "configDir": "$config_dir" },
    "endpoint": { "host": "127.0.0.1", "port": $port },
    "configVersion": $config_version
  }
}
JSON

  cat > "$config_dir/worker.env" <<ENV
AGENT_API_HOST=127.0.0.1
AGENT_API_PORT=$port
AGENT_API_DATA_DIR=$data_dir
AGENT_API_KEY_REGISTRY=$config_dir/key-registry.json
AGENT_API_RELEASE_MANIFEST=$config_dir/release.json
AGENT_API_RELEASE_STATE=$config_dir/release-state.json
AGENT_API_REGION=$REGION
AGENT_API_ENVIRONMENT=sandbox
AGENT_API_OWNER_STORE=$NS_ROOT/fleet/owners.json
AGENT_API_COHORT_ID=p29
AGENT_API_COHORT_MODE=allowlist
AGENT_API_COHORT_PRINCIPALS=p29-client,sandbox-$worker
ARTIFACT_SHARE_SECRET=$share_secret
ARTIFACT_BASE_URL=http://127.0.0.1:$port
RUNNER_DEFAULT_REPO=file://$FIXTURE_REPO
ENV

  printf '{"releaseId":"%s","sourceCommit":"%s","configVersion":%s,"workerId":"sandbox-%s","region":"%s","configVersionHost":%s,"port":%s,"previousReleaseId":"%s"}\n' \
    "$release_id" "$SOURCE_COMMIT" "$config_version" "$worker" "$REGION" "$config_version" "$port" "$PREVIOUS_RELEASE" > "$config_dir/pinned.json"
  chmod 0600 "$config_dir"/api-key "$config_dir"/key-registry.json "$config_dir"/release.json "$config_dir"/worker.env "$config_dir"/pinned.json

  [[ -n "$WORKERS_JSON" ]] && WORKERS_JSON+=","
  WORKERS_JSON+="{\"workerId\":\"sandbox-$worker\",\"releaseId\":\"$release_id\",\"configVersion\":$config_version,\"port\":$port,\"dataDir\":\"$data_dir\",\"configDir\":\"$config_dir\",\"envFile\":\"$config_dir/worker.env\",\"keyFile\":\"$config_dir/api-key\",\"keyRegistry\":\"$config_dir/key-registry.json\",\"manifest\":\"$config_dir/release.json\",\"stateFile\":\"$config_dir/release-state.json\",\"logFile\":\"$worker_root/logs/api.log\"}"
  log "worker sandbox-$worker: release $release_id (config $config_version), port $port, data $data_dir"
  index=$((index + 1))
done

cat > "$NS_ROOT/provisioning.json" <<JSON
{
  "schemaVersion": 1,
  "namespace": "$NAMESPACE",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "sourceCommit": "$SOURCE_COMMIT",
  "candidateReleaseId": "$RELEASE_ID",
  "previousReleaseId": "$PREVIOUS_RELEASE",
  "fleetRoot": "$NS_ROOT",
  "ownerStore": "$NS_ROOT/fleet/owners.json",
  "region": "$REGION",
  "environment": "sandbox",
  "note": "экспериментальные данные и ключи только здесь; значения секретов в этот файл не попадают",
  "workers": [$WORKERS_JSON]
}
JSON
chmod 0640 "$NS_ROOT/provisioning.json"

log "namespace: $NS_ROOT"
log "provisioning manifest: $NS_ROOT/provisioning.json"
log "next: node scripts/promotion-probe.mjs --fleet-root $FLEET_ROOT --namespace $NAMESPACE"