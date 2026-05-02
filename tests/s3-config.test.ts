import { describe, expect, it } from "vitest";
import { buildS3ClientConfig } from "@/lib/s3";

describe("buildS3ClientConfig", () => {
  it("keeps AWS S3 behavior unchanged when no endpoint is configured", () => {
    const config = buildS3ClientConfig({
      AWS_REGION: "us-west-2",
      S3_BUCKET_NAME: "cozytrack-dev",
    });

    expect(config).toEqual({ region: "us-west-2" });
  });

  it("uses path-style addressing for local S3-compatible endpoints by default", () => {
    const config = buildS3ClientConfig({
      AWS_REGION: "us-east-1",
      S3_ENDPOINT: "http://localhost:9000",
      S3_BUCKET_NAME: "cozytrack-local",
    });

    expect(config).toMatchObject({
      region: "us-east-1",
      endpoint: "http://localhost:9000",
      forcePathStyle: true,
    });
  });

  it("allows explicitly disabling path-style addressing for custom endpoints", () => {
    const config = buildS3ClientConfig({
      AWS_REGION: "us-east-1",
      S3_ENDPOINT: "https://storage.example.com",
      S3_FORCE_PATH_STYLE: "false",
    });

    expect(config).toEqual({
      region: "us-east-1",
      endpoint: "https://storage.example.com",
    });
  });
});
