import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

type Modules = {
  auth: typeof import("@/lib/auth");
  completeUpload: typeof import("@/app/api/upload/complete/route").POST;
  db: typeof import("@/lib/db").db;
  finalizeSession: typeof import("@/app/api/sessions/[id]/finalize/route").POST;
  presignUpload: typeof import("@/app/api/upload/presign/route").POST;
  recoverTrack: typeof import("@/lib/recovery").recoverTrack;
  s3: typeof import("@/lib/s3");
};

let modules: Modules;
const cleanupSessions = new Set<string>();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

function assertSafeIntegrationEnv() {
  if (process.env.COZYTRACK_INTEGRATION_TEST !== "1") {
    throw new Error("Set COZYTRACK_INTEGRATION_TEST=1 to run integration tests");
  }

  const bucket = requiredEnv("S3_BUCKET_NAME");
  if (!/(ci|test|local)/i.test(bucket)) {
    throw new Error(`Refusing to use non-test bucket: ${bucket}`);
  }

  const databaseUrl = requiredEnv("DATABASE_URL");
  if (!/(localhost|127\.0\.0\.1)/.test(databaseUrl)) {
    throw new Error("Integration tests require a local throwaway DATABASE_URL");
  }
}

async function loadModules(): Promise<Modules> {
  const [
    auth,
    completeRoute,
    dbModule,
    finalizeRoute,
    presignRoute,
    recovery,
    s3,
  ] = await Promise.all([
    import("@/lib/auth"),
    import("@/app/api/upload/complete/route"),
    import("@/lib/db"),
    import("@/app/api/sessions/[id]/finalize/route"),
    import("@/app/api/upload/presign/route"),
    import("@/lib/recovery"),
    import("@/lib/s3"),
  ]);

  return {
    auth,
    completeUpload: completeRoute.POST,
    db: dbModule.db,
    finalizeSession: finalizeRoute.POST,
    presignUpload: presignRoute.POST,
    recoverTrack: recovery.recoverTrack,
    s3,
  };
}

async function ensureBucket(s3: S3Client, bucket: string) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status !== 404) throw error;
  }

  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
}

async function deletePrefix(s3: S3Client, bucket: string, prefix: string) {
  let continuationToken: string | undefined;

  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    const objects = (listed.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => Boolean(key))
      .map((Key) => ({ Key }));

    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
    }

    continuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined;
  } while (continuationToken);
}

function postJson(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost:3001${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function putPresignedBytes(url: string, bytes: Uint8Array) {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "audio/webm" },
    body: new Blob([body], { type: "audio/webm" }),
  });

  expect(response.ok).toBe(true);
}

async function createSession(name = "Integration test session"): Promise<string> {
  const sessionId = `it-${randomUUID()}`;
  cleanupSessions.add(sessionId);
  await modules.db.session.create({
    data: { id: sessionId, name },
  });
  return sessionId;
}

async function hostHeaders(): Promise<Record<string, string>> {
  const hostToken = await modules.auth.issueHostSessionCookie();
  return {
    cookie: `${modules.auth.AUTH_COOKIES.host}=${hostToken}`,
  };
}

async function startUpload(
  sessionId: string,
  trackId = `track-${randomUUID()}`,
): Promise<{ recordingToken: string; trackId: string; url: string }> {
  const start = await modules.presignUpload(
    postJson(
      "/api/upload/presign",
      {
        sessionId,
        trackId,
        partNumber: 0,
        participantName: "Integration Host",
        deviceLabel: "USB Integration Mic",
        deviceId: "integration-device",
        isBuiltInMic: false,
        sessionStartedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      },
      await hostHeaders(),
    ),
  );

  expect(start.status).toBe(200);
  const body = (await start.json()) as {
    recordingToken: string;
    url: string;
  };

  return { recordingToken: body.recordingToken, trackId, url: body.url };
}

beforeAll(async () => {
  assertSafeIntegrationEnv();
  modules = await loadModules();
  await ensureBucket(modules.s3.s3, requiredEnv("S3_BUCKET_NAME"));
});

afterEach(async () => {
  for (const sessionId of cleanupSessions) {
    await modules.db.track.deleteMany({ where: { sessionId } });
    await modules.db.session.deleteMany({ where: { id: sessionId } });
    await deletePrefix(
      modules.s3.s3,
      requiredEnv("S3_BUCKET_NAME"),
      modules.s3.sessionPrefix(sessionId),
    );
  }
  cleanupSessions.clear();
});

describe("recording upload service integration", () => {
  it("creates, stores, completes, and cleans up a recording through real Postgres and S3-compatible storage", async () => {
    const sessionId = await createSession();
    const trackId = `track-${randomUUID()}`;
    const sessionStartedAt = new Date("2026-01-01T00:00:00.000Z").toISOString();

    const start = await modules.presignUpload(
      postJson(
        "/api/upload/presign",
        {
          sessionId,
          trackId,
          partNumber: 0,
          participantName: "Integration Host",
          deviceLabel: "USB Integration Mic",
          deviceId: "integration-device",
          isBuiltInMic: false,
          sessionStartedAt,
        },
        await hostHeaders(),
      ),
    );

    expect(start.status).toBe(200);
    const startBody = (await start.json()) as {
      key: string;
      recordingToken: string;
      url: string;
    };
    expect(startBody.key).toBe(modules.s3.trackPartKey(sessionId, trackId, 0));
    expect(startBody.recordingToken).toEqual(expect.any(String));
    await putPresignedBytes(startBody.url, new Uint8Array([1, 2, 3]));

    const secondChunk = await modules.presignUpload(
      postJson(
        "/api/upload/presign",
        { sessionId, trackId, partNumber: 1 },
        { "x-cozytrack-recording-token": startBody.recordingToken },
      ),
    );
    expect(secondChunk.status).toBe(200);
    const secondChunkBody = (await secondChunk.json()) as {
      key: string;
      url: string;
    };
    expect(secondChunkBody.key).toBe(
      modules.s3.trackPartKey(sessionId, trackId, 1),
    );
    await putPresignedBytes(secondChunkBody.url, new Uint8Array([4, 5, 6]));

    const finalUpload = await modules.presignUpload(
      postJson(
        "/api/upload/presign",
        { sessionId, trackId, partNumber: 9999 },
        { "x-cozytrack-recording-token": startBody.recordingToken },
      ),
    );
    expect(finalUpload.status).toBe(200);
    const finalBody = (await finalUpload.json()) as { key: string; url: string };
    expect(finalBody.key).toBe(modules.s3.trackRecordingKey(sessionId, trackId));
    await putPresignedBytes(finalBody.url, new Uint8Array([7, 8, 9, 10]));

    const complete = await modules.completeUpload(
      postJson(
        "/api/upload/complete",
        { sessionId, trackId, durationMs: 12_345 },
        { "x-cozytrack-recording-token": startBody.recordingToken },
      ),
    );
    expect(complete.status).toBe(200);

    const track = await modules.db.track.findUnique({ where: { id: trackId } });
    expect(track).toMatchObject({
      sessionId,
      participantName: "Integration Host",
      participantId: "host",
      s3Key: modules.s3.trackRecordingKey(sessionId, trackId),
      status: "complete",
      durationMs: 12_345,
      deviceLabel: "USB Integration Mic",
      deviceId: "integration-device",
      isBuiltInMic: false,
      partial: false,
    });
    expect(track?.sessionStartedAt?.toISOString()).toBe(sessionStartedAt);

    await expect(
      modules.s3.trackRecordingExists(sessionId, trackId),
    ).resolves.toBe(true);
    await expect(
      modules.s3.getObjectBytes(modules.s3.trackRecordingKey(sessionId, trackId)),
    ).resolves.toEqual(new Uint8Array([7, 8, 9, 10]));
    await expect(modules.s3.listTrackChunkParts(sessionId, trackId)).resolves
      .toHaveLength(0);
  });

  it("rejects a recording token when presigning or completing a different track", async () => {
    const sessionId = await createSession();
    const { recordingToken } = await startUpload(sessionId);
    const otherTrackId = `track-${randomUUID()}`;

    const presign = await modules.presignUpload(
      postJson(
        "/api/upload/presign",
        { sessionId, trackId: otherTrackId, partNumber: 1 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );
    expect(presign.status).toBe(401);

    const complete = await modules.completeUpload(
      postJson(
        "/api/upload/complete",
        { sessionId, trackId: otherTrackId, durationMs: 1000 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );
    expect(complete.status).toBe(401);
  });

  it("rejects completion when the track belongs to a different session", async () => {
    const owningSessionId = await createSession("Owning session");
    const otherSessionId = await createSession("Other session");
    const { trackId } = await startUpload(owningSessionId);

    const complete = await modules.completeUpload(
      postJson(
        "/api/upload/complete",
        { sessionId: otherSessionId, trackId, durationMs: 1000 },
        await hostHeaders(),
      ),
    );
    expect(complete.status).toBe(403);

    const track = await modules.db.track.findUnique({ where: { id: trackId } });
    expect(track?.status).toBe("recording");
  });

  it("keeps finalize blocked while a track is still actively uploading", async () => {
    const sessionId = await createSession();
    const { recordingToken, trackId, url } = await startUpload(sessionId);
    await putPresignedBytes(url, new Uint8Array([1, 2, 3]));

    const nextChunk = await modules.presignUpload(
      postJson(
        "/api/upload/presign",
        { sessionId, trackId, partNumber: 1 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );
    expect(nextChunk.status).toBe(200);
    const nextChunkBody = (await nextChunk.json()) as { url: string };
    await putPresignedBytes(nextChunkBody.url, new Uint8Array([4, 5, 6]));

    const finalized = await modules.finalizeSession(
      postJson(`/api/sessions/${sessionId}/finalize`, {}),
      { params: Promise.resolve({ id: sessionId }) },
    );

    expect(finalized.status).toBe(409);
    const body = (await finalized.json()) as {
      pending: Array<{ trackId: string; participantName: string; status: string }>;
    };
    expect(body.pending).toEqual([
      {
        trackId,
        participantName: "Integration Host",
        status: "recording",
      },
    ]);
  });

  it("recovers a recording by stitching real contiguous chunks from S3-compatible storage", async () => {
    const sessionId = await createSession();
    const { recordingToken, trackId, url } = await startUpload(sessionId);
    await putPresignedBytes(url, new Uint8Array([1, 2]));

    const secondChunk = await modules.presignUpload(
      postJson(
        "/api/upload/presign",
        { sessionId, trackId, partNumber: 1 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );
    expect(secondChunk.status).toBe(200);
    const secondChunkBody = (await secondChunk.json()) as { url: string };
    await putPresignedBytes(secondChunkBody.url, new Uint8Array([3, 4]));

    const recovered = await modules.recoverTrack(trackId);

    expect(recovered).toMatchObject({
      outcome: "recovered_from_chunks",
      partial: false,
      status: "complete",
      chunkCount: 2,
      missingPartNumbers: [],
    });
    await expect(
      modules.s3.getObjectBytes(modules.s3.trackRecordingKey(sessionId, trackId)),
    ).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
    await expect(modules.s3.listTrackChunkParts(sessionId, trackId)).resolves
      .toHaveLength(2);
  });

  it("marks recovered recordings partial when uploaded chunks have gaps", async () => {
    const sessionId = await createSession();
    const { recordingToken, trackId, url } = await startUpload(sessionId);
    await putPresignedBytes(url, new Uint8Array([1, 2]));

    const thirdChunk = await modules.presignUpload(
      postJson(
        "/api/upload/presign",
        { sessionId, trackId, partNumber: 2 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );
    expect(thirdChunk.status).toBe(200);
    const thirdChunkBody = (await thirdChunk.json()) as { url: string };
    await putPresignedBytes(thirdChunkBody.url, new Uint8Array([5, 6]));

    const recovered = await modules.recoverTrack(trackId);

    expect(recovered).toMatchObject({
      outcome: "recovered_partial",
      partial: true,
      status: "complete",
      chunkCount: 2,
      missingPartNumbers: [1],
    });

    const track = await modules.db.track.findUnique({ where: { id: trackId } });
    expect(track?.partial).toBe(true);
    await expect(
      modules.s3.getObjectBytes(modules.s3.trackRecordingKey(sessionId, trackId)),
    ).resolves.toEqual(new Uint8Array([1, 2, 5, 6]));
  });
});
