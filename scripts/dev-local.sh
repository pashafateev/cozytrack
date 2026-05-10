#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

. ./scripts/local-env.sh
load_local_env

export S3_ENDPOINT="http://localhost:9000"
export MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
export AWS_ACCESS_KEY_ID="$MINIO_ROOT_USER"
export AWS_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD"
export AWS_REGION="${LOCAL_AWS_REGION:-us-east-1}"
export S3_BUCKET_NAME="${LOCAL_S3_BUCKET_NAME:-cozytrack-local}"
export S3_FORCE_PATH_STYLE="true"

docker compose --profile local-storage up -d

docker compose --profile local-storage --profile tools run --rm minio-mc /scripts/minio-bucket.sh provision

npm run db:push
./node_modules/.bin/next dev -p 3001
