#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

set -a
[ -f ./.env ] && . ./.env
[ -f ./.env.local ] && . ./.env.local
set +a

if [ -z "${S3_BUCKET_NAME:-}" ]; then
  exit 0
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI is required for the local startup auth check." >&2
  exit 1
fi

if aws sts get-caller-identity >/dev/null 2>&1; then
  exit 0
fi

echo "AWS credentials are unavailable or expired." >&2
echo "Reauthenticate with 'aws login' and retry 'npm run dev'." >&2
exit 1
