#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

set -a
[ -f ./.env ] && . ./.env
[ -f ./.env.local ] && . ./.env.local
set +a

: "${S3_BUCKET_NAME:?S3_BUCKET_NAME is required}"

case "$S3_BUCKET_NAME" in
  *dev*|*local*|*test*)
    ;;
  *)
    echo "Refusing to reset bucket '$S3_BUCKET_NAME' because it does not look like a dev/local/test bucket." >&2
    exit 1
    ;;
esac

docker compose up -d

echo "Resetting database"
npx prisma db push --force-reset --accept-data-loss >/dev/null

echo "Emptying s3://$S3_BUCKET_NAME"

while true; do
  delete_payload="$({
    aws s3api list-object-versions --bucket "$S3_BUCKET_NAME" --output json
  } | jq -c '{Objects: ((.Versions // []) + (.DeleteMarkers // []) | map({Key, VersionId})), Quiet: true}')"

  if [ "$(printf '%s' "$delete_payload" | jq '.Objects | length')" -eq 0 ]; then
    break
  fi

  aws s3api delete-objects --bucket "$S3_BUCKET_NAME" --delete "$delete_payload" >/dev/null
done

echo "Local reset complete"
