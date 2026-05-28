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

docker compose --profile local-storage up -d postgres redis livekit minio
docker compose --profile local-storage --profile tools run --rm minio-mc /scripts/minio-bucket.sh provision

npx prisma db push
npx playwright test --config playwright.config.ts "$@"
