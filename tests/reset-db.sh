#!/usr/bin/env bash
# Recreates a local test database and applies all migrations. Usage: tests/reset-db.sh postgres://user@host:port
set -euo pipefail
SERVER="${1:-postgres://postgres@localhost:5433}"
psql "$SERVER/postgres" -q -c "DROP DATABASE IF EXISTS rooms_test WITH (FORCE)" -c "CREATE DATABASE rooms_test"
for f in netlify/database/migrations/*.sql; do psql "$SERVER/rooms_test" -q -v ON_ERROR_STOP=1 -f "$f"; done
echo "Ready: $SERVER/rooms_test"
