#!/bin/sh
# E2E acceptance loop (issue #2) — обёртка для `scripts/e2e-loop.sh`.
# Требует devDependencies (npm ci); собирает src/ во временный .e2e-dist сама.
set -e
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/e2e-loop.mjs" "$@"
