#!/usr/bin/env bash

load_local_env() {
  set -a
  [ -f ./.env ] && . ./.env
  [ -f ./.env.local ] && . ./.env.local
  set +a
}

is_local_s3_endpoint() {
  case "${S3_ENDPOINT:-}" in
    http://localhost:*|https://localhost:*|http://127.0.0.1:*|https://127.0.0.1:*|http://0.0.0.0:*|https://0.0.0.0:*|http://minio:*|https://minio:*|http://host.docker.internal:*|https://host.docker.internal:*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}
