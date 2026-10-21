#!/usr/bin/env bash
# Proves supabase/schema.sql does what it claims, on a throwaway Postgres.
#
#   scripts/test-schema.sh
#
# Needs a local postgres binary (createdb / initdb / psql). Does not touch
# Supabase and does not need credentials. Nothing here runs in production.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(dirname "$(command -v initdb || echo /usr/lib/postgresql/17/bin/initdb)")}"
DATA="$(mktemp -d)/pgdata"
SOCK="$(mktemp -d)"
PORT="${PORT:-5433}"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-k $SOCK -p $PORT -c listen_addresses=''" -l "$DATA/pg.log" start >/dev/null
sleep 1

"$PGBIN/psql" -h "$SOCK" -p "$PORT" -U postgres -q -c "create database asxtest;" >/dev/null
cd "$ROOT/supabase"
"$PGBIN/psql" -h "$SOCK" -p "$PORT" -U postgres -d asxtest -q -f schema.test.sql 2>&1 | grep -vE '^(CREATE|INSERT|SET|RESET|DO|GRANT|REVOKE|DROP|ALTER|COMMENT| *)$'
