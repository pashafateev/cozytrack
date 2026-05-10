import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  NoSuchKey,
  NotFound,
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

export async function listTrackChunkParts(
  sessionId: string,
  trackId: string
): Promise<{ partNumber: number; key: string; size: number }[]> {
  const prefix = trackPrefix(sessionId, trackId);
  const chunkKeyPattern = /^(\d+)\.webm$/;
  const parts: { partNumber: number; key: string; size: number }[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const object of response.Contents ?? []) {
      const key = object.Key;
      if (!key) continue;
      const match = chunkKeyPattern.exec(key.slice(prefix.length));
      if (!match) continue;
      const partNumber = Number(match[1]);
      if (partNumber === 9999) continue;
      parts.push({ partNumber, key, size: object.Size ?? 0 });
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  parts.sort((a, b) => a.partNumber - b.partNumber);
  return parts;
}

export async function trackRecordingExists(
  sessionId: string,
  trackId: string
): Promise<boolean> {
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: trackRecordingKey(sessionId, trackId),
      })
    );
    return true;
  } catch (error) {
    if (error instanceof NotFound || error instanceof NoSuchKey) {
      return false;
    }
    // Some S3 implementations surface 404 as a generic error with the right
    // status code instead of NotFound. Don't swallow other failures.
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    if (status === 404) {
      return false;
    }
    throw error;
  }
}

export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  const body = response.Body;
  if (!body) {
    throw new Error(`S3 object ${key} returned empty body`);
  }
  return await body.transformToByteArray();
}

export async function putObjectBytes(
  key: string,
  bytes: Uint8Array
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: "audio/webm",
    })
  );
}

export async function deleteTrackChunks(
  sessionId: string,
  trackId: string
): Promise<void> {
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

    if (keysToDelete.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: keysToDelete.map((Key) => ({ Key })),
            Quiet: true,
          },
        })
      );
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);
}
