#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export COZYTRACK_BROWSER_SMOKE_TEST=1
export COZYTRACK_BROWSER_PORT="${COZYTRACK_BROWSER_PORT:-3101}"
export NEXT_TELEMETRY_DISABLED=1

export DATABASE_URL="${COZYTRACK_BROWSER_DATABASE_URL:-postgresql://cozytrack:cozytrack@127.0.0.1:5433/cozytrack}"
export DIRECT_DATABASE_URL="${COZYTRACK_BROWSER_DIRECT_DATABASE_URL:-$DATABASE_URL}"

export AUTH_SECRET="${COZYTRACK_BROWSER_AUTH_SECRET:-cozytrack-browser-smoke-auth-secret-32chars}"
export HOST_PASSWORD="${COZYTRACK_BROWSER_HOST_PASSWORD:-cozytrack-browser-smoke-password}"

export LIVEKIT_API_KEY="${COZYTRACK_BROWSER_LIVEKIT_API_KEY:-devkey}"
export LIVEKIT_API_SECRET="${COZYTRACK_BROWSER_LIVEKIT_API_SECRET:-cozytrack-local-livekit-secret-32}"
export LIVEKIT_URL="${COZYTRACK_BROWSER_LIVEKIT_URL:-ws://127.0.0.1:7880}"
export NEXT_PUBLIC_LIVEKIT_URL="${COZYTRACK_BROWSER_PUBLIC_LIVEKIT_URL:-ws://127.0.0.1:7880}"

export MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
export AWS_ACCESS_KEY_ID="$MINIO_ROOT_USER"
export AWS_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD"
export AWS_REGION="${COZYTRACK_BROWSER_AWS_REGION:-us-east-1}"
export S3_BUCKET_NAME="${COZYTRACK_BROWSER_S3_BUCKET_NAME:-cozytrack-browser-test}"
export S3_ENDPOINT="${COZYTRACK_BROWSER_S3_ENDPOINT:-http://127.0.0.1:9000}"
export S3_FORCE_PATH_STYLE=true
export MINIO_API_CORS_ALLOW_ORIGIN="${MINIO_API_CORS_ALLOW_ORIGIN:-http://127.0.0.1:${COZYTRACK_BROWSER_PORT},http://localhost:${COZYTRACK_BROWSER_PORT},http://127.0.0.1:3001,http://localhost:3001}"

assert_local_database_url() {
  node -e '
    const value = process.argv[1];
    let parsed;
    try {
      parsed = new URL(value);
    } catch (error) {
      console.error(`Invalid DATABASE_URL: ${error.message}`);
      process.exit(1);
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    const allowed = new Set(["localhost", "127.0.0.1", "::1"]);
    if (!allowed.has(hostname)) {
      console.error(`Refusing to run browser smoke test against non-local database host: ${hostname}`);
      process.exit(1);
    }
  ' "$1"
}

assert_test_bucket() {
  bucket_lc="$(printf '%s' "$S3_BUCKET_NAME" | tr '[:upper:]' '[:lower:]')"
  case "$bucket_lc" in
    *ci*|*test*|*local*)
      ;;
    *)
      echo "Refusing to run browser smoke test against non-test bucket: $S3_BUCKET_NAME" >&2
      exit 1
      ;;
  esac
}

wait_for_postgres() {
  for attempt in $(seq 1 60); do
    if docker compose exec -T postgres pg_isready -U cozytrack -d cozytrack >/dev/null 2>&1; then
      return 0
    fi

    echo "Waiting for Postgres ($attempt/60)"
    sleep 1
  done

  echo "Timed out waiting for Postgres" >&2
  exit 1
}

wait_for_tcp() {
  host="$1"
  port="$2"
  name="$3"

  for attempt in $(seq 1 60); do
    if (echo >"/dev/tcp/$host/$port") >/dev/null 2>&1; then
      return 0
    fi

    echo "Waiting for $name at $host:$port ($attempt/60)"
    sleep 1
  done

  echo "Timed out waiting for $name at $host:$port" >&2
  exit 1
}

assert_local_database_url "$DATABASE_URL"
assert_local_database_url "$DIRECT_DATABASE_URL"
assert_test_bucket

docker compose --profile local-storage up -d postgres redis livekit minio
wait_for_postgres
wait_for_tcp 127.0.0.1 7880 LiveKit
docker compose --profile local-storage --profile tools run --rm minio-mc /scripts/minio-bucket.sh provision

npx prisma db push
npx prisma generate
npx playwright test --config playwright.config.ts "$@"
