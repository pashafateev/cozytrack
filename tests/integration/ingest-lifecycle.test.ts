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
  downloadIngestTrack: typeof import("@/app/api/ingest/tracks/[id]/download/route").GET;
  finalizeSession: typeof import("@/app/api/sessions/[id]/finalize/route").POST;
  getIngestSession: typeof import("@/app/api/ingest/sessions/[id]/route").GET;
  listIngestSessions: typeof import("@/app/api/ingest/sessions/route").GET;
  presignUpload: typeof import("@/app/api/upload/presign/route").POST;
  purgeSessionFiles: typeof import("@/app/api/ingest/sessions/[id]/purge-files/route").POST;
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
    downloadRoute,
    finalizeRoute,
    ingestSessionRoute,
    ingestSessionsRoute,
    presignRoute,
    purgeRoute,
    s3,
  ] = await Promise.all([
    import("@/lib/auth"),
    import("@/app/api/upload/complete/route"),
    import("@/lib/db"),
    import("@/app/api/ingest/tracks/[id]/download/route"),
    import("@/app/api/sessions/[id]/finalize/route"),
    import("@/app/api/ingest/sessions/[id]/route"),
    import("@/app/api/ingest/sessions/route"),
    import("@/app/api/upload/presign/route"),
    import("@/app/api/ingest/sessions/[id]/purge-files/route"),
    import("@/lib/s3"),
  ]);

  return {
    auth,
    completeUpload: completeRoute.POST,
    db: dbModule.db,
    downloadIngestTrack: downloadRoute.GET,
    finalizeSession: finalizeRoute.POST,
    getIngestSession: ingestSessionRoute.GET,
    listIngestSessions: ingestSessionsRoute.GET,
    presignUpload: presignRoute.POST,
    purgeSessionFiles: purgeRoute.POST,
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

async function countPrefixObjects(sessionId: string): Promise<number> {
  let count = 0;
  let continuationToken: string | undefined;

  do {
    const listed = await modules.s3.s3.send(
      new ListObjectsV2Command({
        Bucket: requiredEnv("S3_BUCKET_NAME"),
        Prefix: modules.s3.sessionPrefix(sessionId),
        ContinuationToken: continuationToken,
      }),
    );
    count += listed.Contents?.length ?? 0;
    continuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return count;
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

function getRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost:3001${path}`, { method: "GET" });
}

function presignedPutHeaders(url: string): Record<string, string> {
  const signedHeaders = new URL(url).searchParams
    .get("X-Amz-SignedHeaders")
    ?.split(";");
  return {
    "content-type": "audio/webm",
    ...(signedHeaders?.includes("if-none-match")
      ? { "if-none-match": "*" }
      : {}),
  };
}

async function putPresignedBytes(url: string, bytes: Uint8Array) {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  const response = await fetch(url, {
    method: "PUT",
    headers: presignedPutHeaders(url),
    body: new Blob([body], { type: "audio/webm" }),
  });

  expect(response.ok).toBe(true);
}

async function createSession(name = "Ingest test session"): Promise<string> {
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

async function recordCompleteTrack(
  sessionId: string,
  participantName: string,
  recordingBytes: Uint8Array,
  durationMs: number,
): Promise<string> {
  const trackId = `track-${randomUUID()}`;

  const start = await modules.presignUpload(
    postJson(
      "/api/upload/presign",
      {
        sessionId,
        trackId,
        partNumber: 0,
        participantName,
        sessionStartedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      },
      await hostHeaders(),
    ),
  );
  expect(start.status).toBe(200);
  const startBody = (await start.json()) as {
    recordingToken: string;
    url: string;
  };
  await putPresignedBytes(startBody.url, new Uint8Array([0]));

  const finalUpload = await modules.presignUpload(
    postJson(
      "/api/upload/presign",
      { sessionId, trackId, partNumber: 9999 },
      { "x-cozytrack-recording-token": startBody.recordingToken },
    ),
  );
  expect(finalUpload.status).toBe(200);
  const finalBody = (await finalUpload.json()) as { url: string };
  await putPresignedBytes(finalBody.url, recordingBytes);

  const complete = await modules.completeUpload(
    postJson(
      "/api/upload/complete",
      { sessionId, trackId, durationMs },
      { "x-cozytrack-recording-token": startBody.recordingToken },
    ),
  );
  expect(complete.status).toBe(200);

  return trackId;
}

async function finalizeToReady(sessionId: string) {
  const finalized = await modules.finalizeSession(
    postJson(`/api/sessions/${sessionId}/finalize`, {}),
    { params: Promise.resolve({ id: sessionId }) },
  );
  expect(finalized.status).toBe(200);
  await expect(
    modules.db.session.findUniqueOrThrow({ where: { id: sessionId } }),
  ).resolves.toMatchObject({ status: "ready" });
}

async function downloadIngestTrack(trackId: string) {
  return await modules.downloadIngestTrack(
    getRequest(`/api/ingest/tracks/${trackId}/download`),
    { params: Promise.resolve({ id: trackId }) },
  );
}

async function purgeSessionFiles(sessionId: string) {
  return await modules.purgeSessionFiles(
    postJson(`/api/ingest/sessions/${sessionId}/purge-files`, {}),
    { params: Promise.resolve({ id: sessionId }) },
  );
}

beforeAll(async () => {
  assertSafeIntegrationEnv();
  modules = await loadModules();
  await ensureBucket(modules.s3.s3, requiredEnv("S3_BUCKET_NAME"));
});

afterEach(async () => {
  for (const sessionId of cleanupSessions) {
    await modules.db.track.deleteMany({ where: { sessionId } });
    await modules.db.recordingTakeParticipantStatus.deleteMany({
      where: { take: { sessionId } },
    });
    await modules.db.recordingTake.deleteMany({ where: { sessionId } });
    await modules.db.session.deleteMany({ where: { id: sessionId } });
    await deletePrefix(
      modules.s3.s3,
      requiredEnv("S3_BUCKET_NAME"),
      modules.s3.sessionPrefix(sessionId),
    );
  }
  cleanupSessions.clear();
});

describe("ingest lifecycle service integration", () => {
  it("lists ready sessions with summary track metadata and filters out non-ready ones", async () => {
    const readySessionId = await createSession("Ingest ready session");
    const readyTrackId = await recordCompleteTrack(
      readySessionId,
      "Ingest Ready Host",
      new Uint8Array([1, 2, 3, 4]),
      4_321,
    );
    await finalizeToReady(readySessionId);

    const recordingSessionId = await createSession("Ingest recording session");
    const inFlight = await modules.presignUpload(
      postJson(
        "/api/upload/presign",
        {
          sessionId: recordingSessionId,
          trackId: `track-${randomUUID()}`,
          partNumber: 0,
          participantName: "Ingest In-Flight Host",
        },
        await hostHeaders(),
      ),
    );
    expect(inFlight.status).toBe(200);

    const readyList = await modules.listIngestSessions(
      getRequest("/api/ingest/sessions?status=ready"),
    );
    expect(readyList.status).toBe(200);
    const readySessions = (await readyList.json()) as Array<{
      id: string;
      status: string;
      tracks: Array<Record<string, unknown>>;
    }>;
    const readySession = readySessions.find(
      (session) => session.id === readySessionId,
    );
    expect(readySession).toBeDefined();
    expect(readySession?.status).toBe("ready");
    expect(readySession?.tracks).toEqual([
      {
        id: readyTrackId,
        participantName: "Ingest Ready Host",
        status: "complete",
        durationMs: 4_321,
      },
    ]);
    expect(
      readySessions.some((session) => session.id === recordingSessionId),
    ).toBe(false);

    const recordingList = await modules.listIngestSessions(
      getRequest("/api/ingest/sessions?status=recording"),
    );
    expect(recordingList.status).toBe(200);
    const recordingSessions = (await recordingList.json()) as Array<{
      id: string;
    }>;
    expect(
      recordingSessions.some((session) => session.id === recordingSessionId),
    ).toBe(true);
    expect(
      recordingSessions.some((session) => session.id === readySessionId),
    ).toBe(false);

    const unfiltered = await modules.listIngestSessions(
      getRequest("/api/ingest/sessions"),
    );
    expect(unfiltered.status).toBe(200);
    const allSessions = (await unfiltered.json()) as Array<{ id: string }>;
    for (const sessionId of [readySessionId, recordingSessionId]) {
      expect(allSessions.some((session) => session.id === sessionId)).toBe(true);
    }

    const invalidFilter = await modules.listIngestSessions(
      getRequest("/api/ingest/sessions?status=purged"),
    );
    expect(invalidFilter.status).toBe(400);
  });

  it("returns full track rows for session detail and 404 for unknown sessions", async () => {
    const sessionId = await createSession("Ingest detail session");
    const trackId = await recordCompleteTrack(
      sessionId,
      "Ingest Detail Host",
      new Uint8Array([5, 6, 7]),
      2_500,
    );
    await finalizeToReady(sessionId);

    const detail = await modules.getIngestSession(
      getRequest(`/api/ingest/sessions/${sessionId}`),
      { params: Promise.resolve({ id: sessionId }) },
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      id: string;
      status: string;
      tracks: Array<Record<string, unknown>>;
    };
    expect(detailBody.id).toBe(sessionId);
    expect(detailBody.status).toBe("ready");
    expect(detailBody.tracks).toHaveLength(1);
    expect(detailBody.tracks[0]).toMatchObject({
      id: trackId,
      sessionId,
      participantName: "Ingest Detail Host",
      participantId: "host",
      s3Key: modules.s3.trackRecordingKey(sessionId, trackId),
      status: "complete",
      durationMs: 2_500,
      s3PurgedAt: null,
    });

    const missing = await modules.getIngestSession(
      getRequest(`/api/ingest/sessions/session-${randomUUID()}`),
      { params: Promise.resolve({ id: `session-${randomUUID()}` }) },
    );
    expect(missing.status).toBe(404);
  });

  it("serves a presigned download that fetches the stored recording bytes", async () => {
    const sessionId = await createSession("Ingest download session");
    const recordingBytes = new Uint8Array([11, 22, 33, 44, 55]);
    const trackId = await recordCompleteTrack(
      sessionId,
      "Ingest Download Host",
      recordingBytes,
      1_200,
    );
    await finalizeToReady(sessionId);

    const download = await downloadIngestTrack(trackId);
    expect(download.status).toBe(200);
    const { url } = (await download.json()) as { url: string };

    const fetched = await fetch(url);
    expect(fetched.ok).toBe(true);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(recordingBytes);

    const missing = await downloadIngestTrack(`track-${randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  it("rejects downloads while a re-record supersedes the stored artifact", async () => {
    const sessionId = await createSession("Ingest re-record session");
    await modules.db.recordingTake.create({
      data: {
        id: `take-${randomUUID()}`,
        sessionId,
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const trackId = await recordCompleteTrack(
      sessionId,
      "Ingest Re-record Host",
      new Uint8Array([1, 2, 3]),
      900,
    );

    const beforeRerecord = await downloadIngestTrack(trackId);
    expect(beforeRerecord.status).toBe(200);

    const rerecord = await modules.presignUpload(
      postJson(
        "/api/upload/presign",
        {
          sessionId,
          trackId,
          segmentId: `segment-${randomUUID()}`,
          partNumber: 0,
          participantName: "Ingest Re-record Host",
          sessionStartedAt: new Date("2026-01-01T00:00:01.000Z").toISOString(),
        },
        await hostHeaders(),
      ),
    );
    expect(rerecord.status).toBe(200);
    await expect(
      modules.db.track.findUniqueOrThrow({ where: { id: trackId } }),
    ).resolves.toMatchObject({ status: "recording" });

    const download = await downloadIngestTrack(trackId);
    expect(download.status).toBe(409);
    await expect(download.json()).resolves.toMatchObject({
      error: expect.stringContaining("not complete"),
    });
  });

  it("purges real session objects, stamps tracks, and repeats idempotently", async () => {
    const sessionId = await createSession("Ingest purge session");
    const firstTrackId = await recordCompleteTrack(
      sessionId,
      "Ingest Purge Host",
      new Uint8Array([1, 2, 3, 4]),
      3_000,
    );
    const secondTrackId = await recordCompleteTrack(
      sessionId,
      "Ingest Purge Guest",
      new Uint8Array([5, 6, 7, 8]),
      3_100,
    );
    await finalizeToReady(sessionId);

    const objectsBeforePurge = await countPrefixObjects(sessionId);
    expect(objectsBeforePurge).toBeGreaterThan(0);

    const purge = await purgeSessionFiles(sessionId);
    expect(purge.status).toBe(200);
    const purgeBody = (await purge.json()) as {
      deletedObjects: number;
      purgedTracks: number;
      s3PurgedAt: string;
    };
    expect(purgeBody.deletedObjects).toBe(objectsBeforePurge);
    expect(purgeBody.purgedTracks).toBe(2);

    await expect(countPrefixObjects(sessionId)).resolves.toBe(0);
    const purgedTracks = await modules.db.track.findMany({
      where: { sessionId },
      select: { id: true, s3PurgedAt: true },
    });
    expect(purgedTracks).toHaveLength(2);
    for (const track of purgedTracks) {
      expect(track.s3PurgedAt?.toISOString()).toBe(purgeBody.s3PurgedAt);
    }

    for (const trackId of [firstTrackId, secondTrackId]) {
      const download = await downloadIngestTrack(trackId);
      expect(download.status).toBe(410);
    }

    const repeatPurge = await purgeSessionFiles(sessionId);
    expect(repeatPurge.status).toBe(200);
    await expect(repeatPurge.json()).resolves.toMatchObject({
      deletedObjects: 0,
      purgedTracks: 0,
      s3PurgedAt: purgeBody.s3PurgedAt,
    });
  });

  it("refuses to purge non-ready sessions and leaves storage untouched", async () => {
    const sessionId = await createSession("Ingest premature purge session");
    const trackId = await recordCompleteTrack(
      sessionId,
      "Ingest Premature Host",
      new Uint8Array([9, 9, 9]),
      1_000,
    );

    const purge = await purgeSessionFiles(sessionId);
    expect(purge.status).toBe(409);

    await expect(countPrefixObjects(sessionId)).resolves.toBeGreaterThan(0);
    await expect(
      modules.db.track.findUniqueOrThrow({ where: { id: trackId } }),
    ).resolves.toMatchObject({ s3PurgedAt: null });

    const missing = await purgeSessionFiles(`session-${randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  it("stamps only unpurged tracks and preserves earlier purge timestamps", async () => {
    const sessionId = await createSession("Ingest partial purge session");
    const purgedEarlierTrackId = await recordCompleteTrack(
      sessionId,
      "Ingest Purged Earlier",
      new Uint8Array([1, 1, 1]),
      1_500,
    );
    const unpurgedTrackId = await recordCompleteTrack(
      sessionId,
      "Ingest Still Stored",
      new Uint8Array([2, 2, 2]),
      1_600,
    );
    await finalizeToReady(sessionId);

    const earlierPurgedAt = new Date("2026-01-02T00:00:00.000Z");
    await modules.db.track.update({
      where: { id: purgedEarlierTrackId },
      data: { s3PurgedAt: earlierPurgedAt },
    });

    const purge = await purgeSessionFiles(sessionId);
    expect(purge.status).toBe(200);
    const purgeBody = (await purge.json()) as {
      purgedTracks: number;
      s3PurgedAt: string;
    };
    expect(purgeBody.purgedTracks).toBe(1);

    const earlierTrack = await modules.db.track.findUniqueOrThrow({
      where: { id: purgedEarlierTrackId },
    });
    expect(earlierTrack.s3PurgedAt?.toISOString()).toBe(
      earlierPurgedAt.toISOString(),
    );

    const freshTrack = await modules.db.track.findUniqueOrThrow({
      where: { id: unpurgedTrackId },
    });
    expect(freshTrack.s3PurgedAt?.toISOString()).toBe(purgeBody.s3PurgedAt);
    expect(freshTrack.s3PurgedAt?.getTime()).toBeGreaterThan(
      earlierPurgedAt.getTime(),
    );
  });
});
