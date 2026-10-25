# MinIO's published images are no longer available. Build the test/local
# server and its matching client from pinned upstream Go modules instead.
FROM golang:1.24.8-alpine AS build
ENV CGO_ENABLED=0
# Server RELEASE.2025-10-15T17-29-55Z and the mc revision in its go.mod.
ARG MINIO_VERSION=v0.0.0-20251015172955-9e49d5e7a648
ARG MC_VERSION=v0.0.0-20250313080218-cf909e1063a9
RUN go install github.com/minio/minio@${MINIO_VERSION}
RUN go install github.com/minio/mc@${MC_VERSION}
RUN mkdir /licenses \
    && cp /go/pkg/mod/github.com/minio/minio@${MINIO_VERSION}/LICENSE /licenses/minio-LICENSE \
    && cp /go/pkg/mod/github.com/minio/mc@${MC_VERSION}/LICENSE /licenses/mc-LICENSE

# The bucket provisioning script needs /bin/sh, so this cannot use scratch.
FROM alpine:3.22
COPY --from=build /go/bin/minio /go/bin/mc /usr/local/bin/
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /licenses /licenses
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
