#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

. ./scripts/local-env.sh
load_local_env

: "${S3_BUCKET_NAME:?S3_BUCKET_NAME is required}"

case "$S3_BUCKET_NAME" in
  *dev*|*local*|*test*)
    ;;
  *)
    echo "Refusing to reset bucket '$S3_BUCKET_NAME' because it does not look like a dev/local/test bucket." >&2
    exit 1
    ;;
esac

if is_local_s3_endpoint; then
  docker compose --profile local-storage up -d
else
  docker compose up -d
fi

echo "Resetting database"
npx prisma db push --force-reset --accept-data-loss >/dev/null

if is_local_s3_endpoint; then
  echo "Emptying MinIO bucket $S3_BUCKET_NAME"
  docker compose --profile local-storage --profile tools run --rm minio-mc /scripts/minio-bucket.sh empty
  echo "Local reset complete"
  exit 0
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI is required to reset an AWS-backed bucket." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to reset an AWS-backed bucket." >&2
  exit 1
fi

aws_endpoint_args=()
if [ -n "${S3_ENDPOINT:-}" ]; then
  aws_endpoint_args=(--endpoint-url "$S3_ENDPOINT")
fi

echo "Emptying s3://$S3_BUCKET_NAME"

while true; do
  delete_payload="$({
    aws "${aws_endpoint_args[@]}" s3api list-object-versions --bucket "$S3_BUCKET_NAME" --output json
  } | jq -c '{Objects: ((.Versions // []) + (.DeleteMarkers // []) | map({Key, VersionId})), Quiet: true}')"

  if [ "$(printf '%s' "$delete_payload" | jq '.Objects | length')" -eq 0 ]; then
    break
  fi

  aws "${aws_endpoint_args[@]}" s3api delete-objects --bucket "$S3_BUCKET_NAME" --delete "$delete_payload" >/dev/null
done

echo "Local reset complete"
