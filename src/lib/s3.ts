import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type S3ClientConfig = NonNullable<ConstructorParameters<typeof S3Client>[0]>;

function cleanEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function booleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }

  return undefined;
}

export function buildS3ClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): S3ClientConfig {
  const endpoint = cleanEnv(env.S3_ENDPOINT);
  const forcePathStyle = booleanEnv(env.S3_FORCE_PATH_STYLE) ?? Boolean(endpoint);
  const config: S3ClientConfig = {
    region: env.AWS_REGION!,
  };

  if (endpoint) {
    config.endpoint = endpoint;
  }

  if (forcePathStyle) {
    config.forcePathStyle = true;
  }

  return config;
}

export const s3 = new S3Client(buildS3ClientConfig());

const bucket = process.env.S3_BUCKET_NAME!;

// S3 key format: sessions/{sessionId}/tracks/{trackId}/{partNumber}.webm
// Final merged file: sessions/{sessionId}/tracks/{trackId}/recording.webm

export function trackPartKey(
  sessionId: string,
  trackId: string,
  partNumber: number
): string {
  return `sessions/${sessionId}/tracks/${trackId}/${partNumber}.webm`;
}

export function trackRecordingKey(
  sessionId: string,
  trackId: string
): string {
  return `sessions/${sessionId}/tracks/${trackId}/recording.webm`;
}

export function trackPrefix(sessionId: string, trackId: string): string {
  return `sessions/${sessionId}/tracks/${trackId}/`;
}

export function sessionPrefix(sessionId: string): string {
  return `sessions/${sessionId}/`;
}

export async function getPresignedPutUrl(key: string): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: "audio/webm",
  });
  return getSignedUrl(s3, command, { expiresIn: 3600 });
}

export async function getPresignedGetUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  return getSignedUrl(s3, command, { expiresIn: 3600 });
}

async function deleteObjects(keysToDelete: string[]): Promise<void> {
  if (keysToDelete.length === 0) {
    return;
  }

  const response = await s3.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: keysToDelete.map((Key) => ({ Key })),
        Quiet: true,
      },
    })
  );

  if (response.Errors && response.Errors.length > 0) {
    const keys = response.Errors.map((error) => error.Key).filter(Boolean);
    throw new Error(
      `Failed to delete S3 objects${keys.length ? `: ${keys.join(", ")}` : ""}`
    );
  }
}

export async function deleteSessionObjects(sessionId: string): Promise<number> {
  const prefix = sessionPrefix(sessionId);
  let continuationToken: string | undefined;
  let deletedObjects = 0;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const keysToDelete = (response.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => Boolean(key));

    await deleteObjects(keysToDelete);
    deletedObjects += keysToDelete.length;

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return deletedObjects;
}

export async function deleteTrackChunks(
  sessionId: string,
  trackId: string
): Promise<void> {
  try {
    const prefix = trackPrefix(sessionId, trackId);
    const finalKey = trackRecordingKey(sessionId, trackId);
    const chunkKeyPattern = /^\d+\.webm$/;
    let continuationToken: string | undefined;

    do {
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      const keysToDelete = (response.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key))
        .filter(
          (key) =>
            key !== finalKey && chunkKeyPattern.test(key.slice(prefix.length))
        );

      await deleteObjects(keysToDelete);

      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);
  } catch (error) {
    console.error("Failed to delete track chunks:", error);
  }
}
