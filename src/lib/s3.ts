import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const s3 = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
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
