#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SERVICE_USER="${SERVICE_USER:-sandbox}"
SERVICE_GROUP="${SERVICE_GROUP:-$SERVICE_USER}"
UNIT_NAME="agent-runner-api.service"
PORT="${AGENT_API_PORT:-8787}"
CONF_DIR="${CONF_DIR:-/etc/agent-runner}"
KEY_FILE="$CONF_DIR/api-key"
REGISTRY_FILE="$CONF_DIR/key-registry.json"
ENV_FILE="$CONF_DIR/agent-runner-api.env"
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
HEALTH_URL="http://127.0.0.1:$PORT/healthz"
ROTATE_KEY=0
SKIP_UFW=0
WORKER_URL="${EXTERNAL_WORKER_URL:-}"
WORKER_TOKEN="${EXTERNAL_WORKER_TOKEN:-}"
ADMISSION_LOG="${AGENT_API_ADMISSION_LOG:-}"
JOURNAL_DIR="${JOURNAL_DIR:-/var/lib/agent-runner}"

log() { printf '[deploy-api] %s\n' "$*"; }
warn() { printf '[deploy-api] WARN: %s\n' "$*" >&2; }
die() { printf '[deploy-api] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
Usage: sudo scripts/deploy-api-service.sh [options]

Runs on the VM from the repo checkout: build -> config dir -> API key -> worker URL/token ->
admission journal -> systemd unit -> enable+start -> health-check -> auth-check -> ufw
(only after auth).

The service itself keeps nothing on disk; the only exception is the admission journal, which
the worker contract (docs/EXTERNAL-WORKER-CONTRACT.md, p. 2) requires so that dedup by
Idempotency-Key and polling of already-accepted runs survive a restart of this API.

Options:
  --port <n>                 listen port (default 8787, same as AGENT_API_PORT)
  --worker-url <url>         external worker base URL (default $EXTERNAL_WORKER_URL)
  --worker-token <token>     shared secret for the worker (default $EXTERNAL_WORKER_TOKEN)
  --admission-log <path>     admission journal file; its directory is created mode 0700 and
                              owned by $SERVICE_USER (default $AGENT_API_ADMISSION_LOG)
  --rotate-key               generate a fresh API key even if one is installed
  --no-ufw                   never touch the firewall
  -h, --help                 this text

Environment overrides: REPO_DIR, SERVICE_USER, AGENT_API_PORT, CONF_DIR, JOURNAL_DIR,
EXTERNAL_WORKER_URL, EXTERNAL_WORKER_TOKEN, AGENT_API_ADMISSION_LOG, RUNNER_DEFAULT_REPO,
AGENT_API_ENV. Extra KEY=value lines already present in the service env file are kept as
they are.

The journal path must be writable by the unit: infra/agent-runner-api.service grants write
access to $JOURNAL_DIR (the systemd default). A journal elsewhere also needs its own
ReadWritePaths line in that unit.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
  --worker-url) WORKER_URL="${2:-}"; shift 2 ;;
  --worker-token) WORKER_TOKEN="${2:-}"; shift 2 ;;
    --admission-log) ADMISSION_LOG="${2:-}"; shift 2 ;;
    --rotate-key) ROTATE_KEY=1; shift ;;
    --no-ufw) SKIP_UFW=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option $1" ;;
  esac
done

[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port: expected 1..65535, got \"$PORT\""
PORT=$((10#$PORT))
(( PORT >= 1 && PORT <= 65535 )) || die "--port: expected 1..65535, got \"$PORT\""
# Путь журнала задаёт оператор, а не скрипт: пустой или не абсолютный путь означал бы
# запись в CWD юнита, то есть тихую потерю дедупликации при рестарте.
if [[ -n "$ADMISSION_LOG" ]]; then
  [[ "$ADMISSION_LOG" == /* ]] || die "--admission-log: expected an absolute path, got \"$ADMISSION_LOG\""
  [[ "$ADMISSION_LOG" != */ && "$ADMISSION_LOG" != "/" ]] || die "--admission-log: expected a file path, got \"$ADMISSION_LOG\""
  [[ ! -d "$ADMISSION_LOG" ]] || die "--admission-log: $ADMISSION_LOG is a directory, expected a file path"
fi
[[ $EUID -eq 0 ]] || die "run as root on the VM: the script installs /etc/agent-runner and a systemd unit"
[[ -f "$REPO_DIR/package.json" ]] || die "no repo checkout at $REPO_DIR"
command -v node >/dev/null || die "node not found in PATH"
command -v npm >/dev/null || die "npm not found in PATH"
command -v curl >/dev/null || die "curl not found in PATH"
command -v openssl >/dev/null || die "openssl not found in PATH"
id "$SERVICE_USER" >/dev/null || die "service user $SERVICE_USER does not exist"
NODE_BIN="$(command -v node)"
cd "$REPO_DIR"

log "1/7 npm install (skipped when node_modules is complete)"
if [[ -x "$REPO_DIR/node_modules/.bin/tsc" && -d "$REPO_DIR/node_modules/@google-cloud/storage" ]]; then
  log "node_modules ok"
else
  sudo -u "$SERVICE_USER" -H npm ci --include=dev --no-audit --no-fund
fi

log "2/7 build → $REPO_DIR/dist"
sudo -u "$SERVICE_USER" -H npm run build
[[ -f "$REPO_DIR/dist/api/main.js" ]] || die "build did not produce dist/api/main.js"

log "3/7 config $CONF_DIR (no data dir: the API is stateless)"
install -d -m 0755 -o root -g root "$CONF_DIR"

log "4/7 API key"
KEY_STATE=existing
if [[ -f "$KEY_FILE" && $ROTATE_KEY -eq 0 ]]; then
  KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
else
  KEY="ak_$(openssl rand -hex 24)"
  KEY_STATE=new
fi
[[ "$KEY" =~ ^ak_[0-9a-f]{48}$ ]] || die "API key in $KEY_FILE is malformed; fix it or rerun with --rotate-key"
umask 077
printf '%s\n' "$KEY" > "$CONF_DIR/.api-key.tmp"
chown "$SERVICE_USER:$SERVICE_GROUP" "$CONF_DIR/.api-key.tmp"
chmod 0600 "$CONF_DIR/.api-key.tmp"
mv "$CONF_DIR/.api-key.tmp" "$KEY_FILE"
KEY_HASH="$(printf '%s' "$KEY" | sha256sum | awk '{print $1}')"
cat > "$CONF_DIR/.key-registry.tmp" <<JSON
{
  "schemaVersion": 1,
  "principals": [
    {
      "keyHash": "$KEY_HASH",
      "principalId": "sandbox",
      "profileId": "profile-sandbox",
      "scopes": ["runs:read", "runs:write"]
    }
  ]
}
JSON
chown "$SERVICE_USER:$SERVICE_GROUP" "$CONF_DIR/.key-registry.tmp"
chmod 0600 "$CONF_DIR/.key-registry.tmp"
mv "$CONF_DIR/.key-registry.tmp" "$REGISTRY_FILE"
log "key state: $KEY_STATE (raw key only in $KEY_FILE, mode 0600; registry holds the sha256 only)"

log "5/7 service environment $ENV_FILE"
if [[ -f "$ENV_FILE" ]]; then
  [[ -n "$WORKER_URL" ]] || WORKER_URL="$(sed -n 's/^EXTERNAL_WORKER_URL=//p' "$ENV_FILE" | head -n1)"
  [[ -n "$WORKER_TOKEN" ]] || WORKER_TOKEN="$(sed -n 's/^EXTERNAL_WORKER_TOKEN=//p' "$ENV_FILE" | head -n1)"
  [[ -n "$ADMISSION_LOG" ]] || ADMISSION_LOG="$(sed -n 's/^AGENT_API_ADMISSION_LOG=//p' "$ENV_FILE" | head -n1)"
fi
[[ -n "$WORKER_URL" ]] || die "external worker URL is required: pass --worker-url or set EXTERNAL_WORKER_URL"
[[ "$WORKER_URL" =~ ^https?:// ]] || die "--worker-url: expected an http(s) URL, got \"$WORKER_URL\""

# Журнал приёмных записей: единственное, что сервис пишет на диск, и единственное, что нужно
# его контракту (EXTERNAL-WORKER-CONTRACT.md, п. 2) — без него повтор submit с тем же
# Idempotency-Key после рестарта API завёл бы второй ран. Каталог создаём здесь, потому что
# юнит работает с ProtectSystem=full и может писать только в выданный ему ReadWritePaths.
JOURNAL_DIR_ACTUAL=""
if [[ -n "$ADMISSION_LOG" ]]; then
  JOURNAL_DIR_ACTUAL="$(dirname "$ADMISSION_LOG")"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$JOURNAL_DIR_ACTUAL"
  log "admission journal: $ADMISSION_LOG (directory $JOURNAL_DIR_ACTUAL mode 0700, owner $SERVICE_USER)"
  case "$JOURNAL_DIR_ACTUAL/" in
    "$JOURNAL_DIR"/*) ;;
    *) warn "journal lives in $JOURNAL_DIR_ACTUAL, outside $JOURNAL_DIR; infra/agent-runner-api.service grants write access to $JOURNAL_DIR — add the path to ReadWritePaths there, or the journal will fail to open" ;;
  esac
else
  warn "no admission journal (--admission-log not set, AGENT_API_ADMISSION_LOG empty)"
  warn "  dedup by Idempotency-Key and polling of accepted runs will NOT survive a restart of this API;"
  warn "  the worker contract (p. 2) requires that. Re-run this script with --admission-log $JOURNAL_DIR/admissions.jsonl"
fi
if [[ -n "$ADMISSION_LOG" ]]; then
  # `touch`, а не усечение: журнал — это память о дедупликации и о ранах, уже принятых
  # воркером. Переустановка не должна стирать её и поднимать чужой рап на повторе ключа.
  touch "$ADMISSION_LOG"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$ADMISSION_LOG"
  chmod 0600 "$ADMISSION_LOG"
fi

EXTRA_ENV=""
if [[ -f "$ENV_FILE" ]]; then
  EXTRA_ENV="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" \
    | grep -vE '^(AGENT_API_HOST|AGENT_API_PORT|AGENT_API_KEY_REGISTRY|AGENT_API_ADMISSION_LOG|EXTERNAL_WORKER_URL|EXTERNAL_WORKER_TOKEN)=' \
    || true)"
fi
{
  cat <<ENV
AGENT_API_HOST=0.0.0.0
AGENT_API_PORT=$PORT
AGENT_API_KEY_REGISTRY=$REGISTRY_FILE
EXTERNAL_WORKER_URL=$WORKER_URL
EXTERNAL_WORKER_TOKEN=$WORKER_TOKEN
ENV
  if [[ -n "$ADMISSION_LOG" ]]; then printf 'AGENT_API_ADMISSION_LOG=%s\n' "$ADMISSION_LOG"; fi
  if [[ -n "$EXTRA_ENV" ]]; then printf '%s\n' "$EXTRA_ENV"; fi
} > "$CONF_DIR/.env.tmp"
chown "$SERVICE_USER:$SERVICE_GROUP" "$CONF_DIR/.env.tmp"
chmod 0600 "$CONF_DIR/.env.tmp"
mv "$CONF_DIR/.env.tmp" "$ENV_FILE"

log "6/7 systemd unit $UNIT_PATH"
sed -e "s|@NODE@|$NODE_BIN|g" -e "s|/opt/sb/ai-agent-runner|$REPO_DIR|g" \
  "$REPO_DIR/infra/agent-runner-api.service" > "$UNIT_PATH.tmp"
chmod 0644 "$UNIT_PATH.tmp"
mv "$UNIT_PATH.tmp" "$UNIT_PATH"
systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null
systemctl restart "$UNIT_NAME"

log "7/7 health-check $HEALTH_URL"
HEALTH=""
for attempt in $(seq 1 40); do
  if HEALTH="$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null)"; then
    break
  fi
  HEALTH=""
  if [[ "$attempt" == "40" ]]; then
    systemctl --no-pager -l status "$UNIT_NAME" || true
    journalctl -u "$UNIT_NAME" -n 40 --no-pager || true
    die "service did not become healthy within 20s"
  fi
  sleep 0.5
done
log "health: $HEALTH"

ANON="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'content-type: application/json' \
  --data '{}' "http://127.0.0.1:$PORT/v1/runs")"
[[ "$ANON" == "401" ]] || { journalctl -u "$UNIT_NAME" -n 40 --no-pager || true; die "anonymous submit returned HTTP $ANON, expected 401; firewall stays closed"; }
PROBE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:$PORT/v1/runs/run_deploy_probe/status")"
[[ "$PROBE" == "404" ]] || { journalctl -u "$UNIT_NAME" -n 40 --no-pager || true; die "authenticated probe returned HTTP $PROBE, expected 404; firewall stays closed"; }
log "auth: anonymous=401, with key=404 (authenticated, unknown run) — auth verified before opening anything"

if [[ $SKIP_UFW -eq 1 ]]; then
  log "ufw: skipped (--no-ufw)"
elif ! ufw status | grep -q 'Status: active'; then
  log "ufw: inactive — port $PORT NOT opened remotely (localhost-only until ufw is enabled)"
elif ufw status | grep -qE "^${PORT}/tcp"; then
  log "ufw: rule for ${PORT}/tcp already present"
else
  ufw allow "${PORT}/tcp" comment 'agent-runner-api' >/dev/null
  log "ufw: opened ${PORT}/tcp (anonymous requests still get 401)"
fi

log "--- summary"
log "unit:    $UNIT_NAME (enabled, $(systemctl is-active "$UNIT_NAME"))"
log "port:    $PORT   health: $HEALTH_URL   worker: $WORKER_URL"
if [[ -n "$ADMISSION_LOG" ]]; then
  log "journal: $ADMISSION_LOG (dedup by Idempotency-Key and polling of accepted runs survive a restart)"
else
  log "journal: none — dedup and polling do NOT survive a restart; rerun with --admission-log $JOURNAL_DIR/admissions.jsonl"
fi
log "state:   stateless beyond that journal — receipts and run progress live in process memory"
log "key:     $KEY_FILE mode $(stat -c '%a' "$KEY_FILE") owner $(stat -c '%U' "$KEY_FILE")"
if [[ "$KEY_STATE" == "new" ]]; then
  log "NEW API KEY (printed once here, stored in $KEY_FILE):"
  log "  $KEY"
fi
log "cli:     RUNNER_API_URL=http://<host>:$PORT RUNNER_API_KEY_FILE=$KEY_FILE node scripts/runner-cli.mjs submit --prompt 'hi'"
