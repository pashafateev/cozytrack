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
: "${MINIO_READY_RETRIES:=60}"

attempt=1
until mc alias set local "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  if [ "$attempt" -ge "$MINIO_READY_RETRIES" ]; then
    echo "Timed out waiting for MinIO at $MINIO_ENDPOINT after $MINIO_READY_RETRIES attempts." >&2
    echo "Check that MinIO is running and the configured credentials are correct." >&2
    exit 1
  fi

  echo "Waiting for MinIO at $MINIO_ENDPOINT ($attempt/$MINIO_READY_RETRIES)"
  attempt=$((attempt + 1))
  sleep 1
done

mc mb --ignore-existing "local/$S3_BUCKET_NAME" >/dev/null

if [ "$action" = "empty" ]; then
  mc rm --recursive --force "local/$S3_BUCKET_NAME" >/dev/null
fi

echo "MinIO bucket $S3_BUCKET_NAME is ready"
