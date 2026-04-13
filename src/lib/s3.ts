import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const s3 = new S3Client({
  region: process.env.AWS_REGION!,
});

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
