#!/bin/sh

set -eu

action="${1:-provision}"

case "$action" in
  provision|empty)
    ;;
  *)
    echo "Usage: minio-bucket.sh [provision|empty]" >&2
    exit 64
    ;;
esac

: "${MINIO_ENDPOINT:=http://minio:9000}"
: "${MINIO_ROOT_USER:=minioadmin}"
: "${MINIO_ROOT_PASSWORD:=minioadmin}"
: "${S3_BUCKET_NAME:=cozytrack-local}"

until mc alias set local "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  echo "Waiting for MinIO at $MINIO_ENDPOINT"
  sleep 1
done

mc mb --ignore-existing "local/$S3_BUCKET_NAME" >/dev/null

if [ "$action" = "empty" ]; then
  mc rm --recursive --force "local/$S3_BUCKET_NAME" >/dev/null
fi

echo "MinIO bucket $S3_BUCKET_NAME is ready"
