import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Request,
} from "@playwright/test";
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const cleanupSessions = new Set<string>();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for browser smoke tests`);
  }
  return value;
}

function assertSafeBrowserSmokeEnv() {
  if (process.env.COZYTRACK_BROWSER_SMOKE_TEST !== "1") {
    throw new Error("Set COZYTRACK_BROWSER_SMOKE_TEST=1 to run browser smoke tests");
  }

  const bucket = requiredEnv("S3_BUCKET_NAME");
  if (!/(ci|test|local)/i.test(bucket)) {
    throw new Error(`Refusing to use non-test bucket: ${bucket}`);
  }

  const databaseUrl = requiredEnv("DATABASE_URL");
  if (!/(localhost|127\.0\.0\.1)/.test(databaseUrl)) {
    throw new Error("Browser smoke tests require a local throwaway DATABASE_URL");
  }
}

function createS3Client(): S3Client {
  return new S3Client({
    region: requiredEnv("AWS_REGION"),
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: requiredEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("AWS_SECRET_ACCESS_KEY"),
    },
  });
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

test.beforeAll(() => {
  assertSafeBrowserSmokeEnv();
});

test.afterEach(async () => {
  const s3 = createS3Client();
  const bucket = requiredEnv("S3_BUCKET_NAME");

  for (const sessionId of cleanupSessions) {
    const takes = await db.recordingTake.findMany({
      where: { sessionId },
      select: { id: true },
    });
    await db.recordingTakeParticipantStatus.deleteMany({
      where: { takeId: { in: takes.map((take) => take.id) } },
    });
    await db.recordingTake.deleteMany({ where: { sessionId } });
    await db.track.deleteMany({ where: { sessionId } });
    await db.session.deleteMany({ where: { id: sessionId } });
    await deletePrefix(s3, bucket, `sessions/${sessionId}/`);
  }
  cleanupSessions.clear();
});

test.afterAll(async () => {
  await db.$disconnect();
});

async function createAndJoinHostStudio(
  page: Page,
  sessionName: string,
  participantName: string,
): Promise<string> {
  const hostPassword = requiredEnv("HOST_PASSWORD");

  await test.step("sign in and create a session", async () => {
    await page.goto("/signin?return_to=/");
    await page.getByLabel("Password").fill(hostPassword);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/$/);
    await page.getByPlaceholder(/Name this session/).fill(sessionName);
    await page.getByRole("button", { name: /Record/ }).click();
    await expect(page).toHaveURL(/\/studio\/[^/]+$/);
  });

  const sessionId = page.url().split("/studio/")[1];
  if (!sessionId) {
    throw new Error(`Could not extract session id from URL: ${page.url()}`);
  }
  cleanupSessions.add(sessionId);

  await joinStudioWithFakeMicrophone(page, participantName, {
    expectHostControls: true,
  });

  return sessionId;
}

async function joinStudioWithFakeMicrophone(
  page: Page,
  participantName: string,
  options: { expectHostControls: boolean },
) {
  await test.step(`join the studio as ${participantName}`, async () => {
    await page.getByPlaceholder("Enter your name").fill(participantName);
    await page.getByRole("button", { name: "Join Studio" }).click();

    const continueWithBuiltInMic = page.getByRole("button", {
      name: /continue with built-in mic/i,
    });
    if (await continueWithBuiltInMic.isVisible().catch(() => false)) {
      await continueWithBuiltInMic.click();
    }

    if (options.expectHostControls) {
      await expect(
        page.getByRole("button", { name: "Start recording" }),
      ).toBeVisible();
    } else {
      await expect(page.getByText("Host controls recording")).toBeVisible();
    }
  });
}

async function createInviteUrl(hostPage: Page, sessionId: string): Promise<string> {
  const response = await hostPage.request.post(
    new URL(`/api/sessions/${sessionId}/invite`, hostPage.url()).toString(),
  );
  expect(response.ok()).toBe(true);

  const body = (await response.json()) as { url?: string };
  expect(body.url).toEqual(expect.stringContaining("/join/"));
  return body.url!;
}

function parseJsonRequestBody(request: Request): Record<string, unknown> | null {
  const body = request.postData();
  if (!body) return null;

  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function joinGuestStudio(
  page: Page,
  inviteUrl: string,
  sessionId: string,
  participantName: string,
) {
  await page.goto(inviteUrl);
  await page.getByLabel("Your name").fill(participantName);
  await page.getByRole("button", { name: "Join session" }).click();
  await expect(page).toHaveURL(new RegExp(`/studio/${sessionId}$`));
  await joinStudioWithFakeMicrophone(page, participantName, {
    expectHostControls: false,
  });
}

async function assertStoredRecording(
  sessionId: string,
  track: { durationMs: number | null; s3Key: string | null },
) {
  expect(track.durationMs ?? 0).toBeGreaterThan(0);
  expect(track.s3Key).toEqual(
    expect.stringMatching(
      new RegExp(`^sessions/${sessionId}/tracks/[^/]+/recording\\.webm$`),
    ),
  );

  if (!track.s3Key) {
    throw new Error("Expected completed track to have an S3 key");
  }

  const head = await createS3Client().send(
    new HeadObjectCommand({
      Bucket: requiredEnv("S3_BUCKET_NAME"),
      Key: track.s3Key,
    }),
  );
  expect(head.ContentLength).toBeGreaterThan(0);
}

test("keeps catch-up and start-message races to one local recorder", async ({
  browser,
  page,
}) => {
  const hostName = "Race Host";
  const guestName = "Race Guest";
  const guestContext = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 1280, height: 720 },
  });

  let releaseCatchupRequest = () => {};
  const catchupRequestBarrier = new Promise<void>((resolve) => {
    releaseCatchupRequest = resolve;
  });
  let catchupRequestBlocked = false;
  let releaseFirstPresign = () => {};
  const firstPresignBarrier = new Promise<void>((resolve) => {
    releaseFirstPresign = resolve;
  });
  let firstPresignReleased = false;
  let guestInitialPresignCount = 0;

  const releasePresign = () => {
    if (firstPresignReleased) return;
    firstPresignReleased = true;
    releaseFirstPresign();
  };

  try {
    const sessionName = `Start race smoke ${Date.now()}`;
    const sessionId = await createAndJoinHostStudio(page, sessionName, hostName);
    const inviteUrl = await createInviteUrl(page, sessionId);

    const guestPage = await guestContext.newPage();
    await guestPage.route("**/api/sessions/**/recording-state", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        request.method() === "GET" &&
        url.pathname === `/api/sessions/${sessionId}/recording-state` &&
        !catchupRequestBlocked
      ) {
        catchupRequestBlocked = true;
        await catchupRequestBarrier;
      }

      await route.continue();
    });

    await guestPage.route("**/api/upload/presign", async (route) => {
      const request = route.request();
      const body = parseJsonRequestBody(request);
      if (
        request.method() === "POST" &&
        body?.sessionId === sessionId &&
        body?.participantName === guestName &&
        body?.partNumber === 0
      ) {
        guestInitialPresignCount += 1;
        if (guestInitialPresignCount === 1) {
          await firstPresignBarrier;
        }
      }

      await route.continue();
    });

    await joinGuestStudio(guestPage, inviteUrl, sessionId, guestName);
    await expect
      .poll(() => catchupRequestBlocked, { timeout: 30_000 })
      .toBe(true);

    await test.step("start while the guest catch-up request is pending", async () => {
      await page.getByRole("button", { name: "Start recording" }).click();
      await expect(
        page.getByRole("button", { name: "Stop recording" }),
      ).toBeVisible();
      await expect
        .poll(() => guestInitialPresignCount, { timeout: 30_000 })
        .toBe(1);

      releaseCatchupRequest();
      await guestPage.waitForTimeout(1_000);
      expect(guestInitialPresignCount).toBe(1);

      releasePresign();
      await expect(
        guestPage.getByRole("status", { name: "Recording in progress" }),
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("stop and verify the raced guest still has one segment", async () => {
      await page.waitForTimeout(2_000);
      await page.getByRole("button", { name: "Stop recording" }).click();
      await expect(page.getByText("FINALIZING").first()).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Start recording" }),
      ).toBeVisible({ timeout: 60_000 });

      await expect
        .poll(
          async () => {
            const tracks = await db.track.findMany({
              where: { sessionId, participantName: guestName },
              include: { segments: true },
            });
            return {
              trackCount: tracks.length,
              segmentCount: tracks.reduce(
                (total, track) => total + track.segments.length,
                0,
              ),
            };
          },
          { timeout: 60_000 },
        )
        .toEqual({ trackCount: 1, segmentCount: 1 });
    });
  } finally {
    releaseCatchupRequest();
    releasePresign();
    await guestContext.close();
  }
});

test("does not resume recording after the stop state update fails", async ({
  page,
}) => {
  const sessionName = `Stop failure smoke ${Date.now()}`;
  const participantName = "Stop Failure Host";
  const sessionId = await createAndJoinHostStudio(
    page,
    sessionName,
    participantName,
  );
  let failedStopStateUpdate = false;

  await page.route("**/api/sessions/**/recording-state", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = parseJsonRequestBody(request);
    if (
      !failedStopStateUpdate &&
      request.method() === "POST" &&
      url.pathname === `/api/sessions/${sessionId}/recording-state` &&
      body?.active === false
    ) {
      failedStopStateUpdate = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced stop state failure" }),
      });
      return;
    }

    await route.continue();
  });

  await test.step("stop locally while the server take remains active", async () => {
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: "Start recording" }).click();
    await expect(
      page.getByRole("button", { name: "Stop recording" }),
    ).toBeVisible();

    await page.waitForTimeout(6_000);
    await page.getByRole("button", { name: "Stop recording" }).click();
    await expect(page.getByText("FINALIZING").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start recording" }),
    ).toBeVisible({ timeout: 60_000 });

    expect(failedStopStateUpdate).toBe(true);
    await page.waitForTimeout(3_000);
    await expect(
      page.getByRole("button", { name: "Start recording" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop recording" }),
    ).toBeHidden();

    await expect
      .poll(
        async () => {
          const take = await db.recordingTake.findFirst({
            where: { sessionId, stoppedAt: null },
            include: { participantStatuses: true },
          });
          return (
            take?.participantStatuses.some(
              (status) =>
                status.participantId === "host" &&
                status.recordingStatus === "connected",
            ) ?? false
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  await test.step("reload and do not catch up to the stopped take", async () => {
    await page.reload();
    await joinStudioWithFakeMicrophone(page, participantName, {
      expectHostControls: true,
    });

    await page.waitForTimeout(3_000);
    await expect(
      page.getByRole("button", { name: "Start recording" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop recording" }),
    ).toBeHidden();
  });
});

test("records a host track through the browser and stores a completed WebM", async ({
  page,
}) => {
  const sessionName = `Browser smoke ${Date.now()}`;
  const participantName = "Browser Smoke Host";
  const sessionId = await createAndJoinHostStudio(
    page,
    sessionName,
    participantName,
  );

  await test.step("start and stop a short recording", async () => {
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: "Start recording" }).click();
    await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();

    await page.waitForTimeout(2_000);
    await page.getByRole("button", { name: "Stop recording" }).click();
    await expect(page.getByText("FINALIZING").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start recording" }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("button", { name: "Finish recording" })).toBeVisible();
  });

  await test.step("assert complete track metadata and stored recording", async () => {
    await expect
      .poll(
        async () => {
          const track = await db.track.findFirst({
            where: { sessionId, participantName },
            select: { status: true },
          });
          return track?.status ?? null;
        },
        { timeout: 30_000 },
      )
      .toBe("complete");

    const track = await db.track.findFirstOrThrow({
      where: { sessionId, participantName },
      select: { durationMs: true, s3Key: true },
    });

    await assertStoredRecording(sessionId, track);
  });

  await test.step("finish the recording from the studio UI", async () => {
    await page.getByRole("button", { name: "Finish recording" }).click();
    await expect(page.getByText("Ready for ingest")).toBeVisible({ timeout: 45_000 });
  });
});

test("recovers a failed final upload from the local browser backup", async ({
  page,
}) => {
  const sessionName = `Browser recovery ${Date.now()}`;
  const participantName = "Browser Recovery Host";
  const sessionId = await createAndJoinHostStudio(
    page,
    sessionName,
    participantName,
  );
  let failedFinalUpload = false;

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      !failedFinalUpload &&
      request.method() === "PUT" &&
      url.pathname.endsWith("/recording.webm")
    ) {
      failedFinalUpload = true;
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "forced final upload failure",
      });
      return;
    }

    await route.continue();
  });

  await test.step("record until a local backup chunk exists and force final upload failure", async () => {
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: "Start recording" }).click();
    await expect(
      page.getByRole("button", { name: "Stop recording" }),
    ).toBeVisible();

    await page.waitForTimeout(6_000);
    await page.getByRole("button", { name: "Stop recording" }).click();
    await expect(page.getByText("FINALIZING").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start recording" }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Local recording backup")).toBeVisible();
    await expect(
      page.getByText(
        "Remote upload failed. Local backup is available in this browser.",
      ),
    ).toBeVisible();
    expect(failedFinalUpload).toBe(true);
  });

  await test.step("retry upload from the local backup", async () => {
    const retryUpload = page.getByRole("button", { name: "Retry upload" });
    await expect(retryUpload).toBeEnabled();
    await retryUpload.click();
    await expect(page.getByText("Local backup uploaded")).toBeVisible();
    await expect(page.getByText("Local recording backup")).toBeHidden({
      timeout: 45_000,
    });
    await expect(
      page.getByRole("button", { name: "Finish recording" }),
    ).toBeVisible();
  });

  await test.step("assert recovered track metadata and stored recording", async () => {
    await expect
      .poll(
        async () => {
          const track = await db.track.findFirst({
            where: { sessionId, participantName },
            select: { status: true },
          });
          return track?.status ?? null;
        },
        { timeout: 30_000 },
      )
      .toBe("complete");

    const track = await db.track.findFirstOrThrow({
      where: { sessionId, participantName },
      select: { durationMs: true, s3Key: true },
    });

    await assertStoredRecording(sessionId, track);
  });
});

test("records host plus two guests and stores three completed WebMs", async ({
  browser,
  page,
}) => {
  const participantNames = [
    "Three Person Host",
    "Three Person Guest A",
    "Three Person Guest B",
  ];
  const guestContexts: BrowserContext[] = [];

  try {
    const sessionName = `Three participant smoke ${Date.now()}`;
    const sessionId = await createAndJoinHostStudio(
      page,
      sessionName,
      participantNames[0],
    );
    const inviteUrl = await createInviteUrl(page, sessionId);

    const guestPages = await Promise.all(
      participantNames.slice(1).map(async () => {
        const context = await browser.newContext({
          permissions: ["microphone"],
          viewport: { width: 1280, height: 720 },
        });
        guestContexts.push(context);
        return await context.newPage();
      }),
    );

    await Promise.all(
      guestPages.map((guestPage, index) =>
        joinGuestStudio(guestPage, inviteUrl, sessionId, participantNames[index + 1]),
      ),
    );

    await test.step("wait for both guests to appear in the host room", async () => {
      for (const participantName of participantNames.slice(1)) {
        await expect(page.getByText(participantName, { exact: true })).toBeVisible({
          timeout: 30_000,
        });
      }
    });

    await test.step("start and stop a three-person recording", async () => {
      await page.waitForTimeout(1_000);
      await page.getByRole("button", { name: "Start recording" }).click();
      await expect(
        page.getByRole("button", { name: "Stop recording" }),
      ).toBeVisible();

      for (const guestPage of guestPages) {
        await expect(
          guestPage.getByRole("status", { name: "Recording in progress" }),
        ).toBeVisible({ timeout: 30_000 });
      }

      await page.waitForTimeout(3_000);
      await page.getByRole("button", { name: "Stop recording" }).click();
      await expect(page.getByText("FINALIZING").first()).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Start recording" }),
      ).toBeVisible({ timeout: 60_000 });
    });

    await test.step("assert all three participant recordings completed", async () => {
      await expect
        .poll(
          async () => {
            const tracks = await db.track.findMany({
              where: {
                sessionId,
                participantName: { in: participantNames },
              },
              select: { participantName: true, status: true },
              orderBy: { participantName: "asc" },
            });
            return tracks.map((track) => `${track.participantName}:${track.status}`);
          },
          { timeout: 60_000 },
        )
        .toEqual(
          [...participantNames]
            .sort()
            .map((participantName) => `${participantName}:complete`),
        );

      const tracks = await db.track.findMany({
        where: {
          sessionId,
          participantName: { in: participantNames },
        },
        select: { participantName: true, durationMs: true, s3Key: true },
        orderBy: { participantName: "asc" },
      });
      expect(tracks).toHaveLength(3);

      for (const track of tracks) {
        await assertStoredRecording(sessionId, track);
      }
    });

    await test.step("finish the recording from the host UI", async () => {
      await page.getByRole("button", { name: "Finish recording" }).click();
      await expect(page.getByText("Ready for ingest")).toBeVisible({
        timeout: 45_000,
      });
    });
  } finally {
    await Promise.all(guestContexts.map((context) => context.close()));
  }
});

test("keeps a returning guest in one logical track during an active recording", async ({
  browser,
  page,
}) => {
  const hostName = "Reconnect Host";
  const guestName = "Reconnect Guest";
  const guestContexts: BrowserContext[] = [];

  try {
    const sessionName = `Reconnect smoke ${Date.now()}`;
    const sessionId = await createAndJoinHostStudio(page, sessionName, hostName);
    const inviteUrl = await createInviteUrl(page, sessionId);

    const guestContext = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1280, height: 720 },
    });
    guestContexts.push(guestContext);

    const firstGuestPage = await guestContext.newPage();
    await joinGuestStudio(firstGuestPage, inviteUrl, sessionId, guestName);

    await test.step("start recording with the first guest present", async () => {
      await page.waitForTimeout(1_000);
      await page.getByRole("button", { name: "Start recording" }).click();
      await expect(
        page.getByRole("button", { name: "Stop recording" }),
      ).toBeVisible();
      await expect(
        firstGuestPage.getByRole("status", { name: "Recording in progress" }),
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("close the guest tab after its first segment starts", async () => {
      await expect
        .poll(
          async () => {
            const track = await db.track.findFirst({
              where: { sessionId, participantName: guestName },
              include: { segments: true },
            });
            return track?.segments.length ?? 0;
          },
          { timeout: 30_000 },
        )
        .toBe(1);

      await page.waitForTimeout(6_000);
      await firstGuestPage.close();
    });

    const returningGuestPage = await guestContext.newPage();
    await joinGuestStudio(returningGuestPage, inviteUrl, sessionId, guestName);

    await test.step("returning guest catches up to the active recording", async () => {
      await expect(
        returningGuestPage.getByRole("status", {
          name: "Recording in progress",
        }),
      ).toBeVisible({ timeout: 45_000 });

      await expect
        .poll(
          async () => {
            const tracks = await db.track.findMany({
              where: { sessionId, participantName: guestName },
              include: { segments: true },
            });
            return {
              trackCount: tracks.length,
              segmentCount: tracks.reduce(
                (total, track) => total + track.segments.length,
                0,
              ),
            };
          },
          { timeout: 30_000 },
        )
        .toEqual({ trackCount: 1, segmentCount: 2 });
    });

    await test.step("stop and verify the returned guest materializes once", async () => {
      await page.waitForTimeout(2_000);
      await page.getByRole("button", { name: "Stop recording" }).click();
      await expect(page.getByText("FINALIZING").first()).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Start recording" }),
      ).toBeVisible({ timeout: 60_000 });

      await expect
        .poll(
          async () => {
            const tracks = await db.track.findMany({
              where: { sessionId, participantName: guestName },
              select: {
                id: true,
                status: true,
                segments: {
                  select: { status: true },
                  orderBy: { segmentIndex: "asc" },
                },
              },
            });
            return tracks.map((track) => ({
              status: track.status,
              segmentCount: track.segments.length,
              completedSegments: track.segments.filter(
                (segment) => segment.status === "complete",
              ).length,
            }));
          },
          { timeout: 60_000 },
        )
        .toEqual([
          {
            status: "complete",
            segmentCount: 2,
            completedSegments: 1,
          },
        ]);

      const guestTrack = await db.track.findFirstOrThrow({
        where: { sessionId, participantName: guestName },
        select: { durationMs: true, s3Key: true },
      });
      await assertStoredRecording(sessionId, guestTrack);
    });

    await test.step("finish the recording from the host UI", async () => {
      await page.getByRole("button", { name: "Finish recording" }).click();
      await expect(page.getByText("Ready for ingest")).toBeVisible({
        timeout: 45_000,
      });
    });
  } finally {
    await Promise.all(guestContexts.map((context) => context.close()));
  }
});

test("keeps a returning host in one logical track during an active recording", async ({
  browser,
  page,
}) => {
  const hostName = "Reconnect Host Return";
  const guestName = "Host Return Guest";
  const guestContexts: BrowserContext[] = [];

  try {
    const hostContext = page.context();
    let hostPage = page;
    const sessionName = `Host reconnect smoke ${Date.now()}`;
    const sessionId = await createAndJoinHostStudio(
      hostPage,
      sessionName,
      hostName,
    );
    const inviteUrl = await createInviteUrl(hostPage, sessionId);

    const guestContext = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1280, height: 720 },
    });
    guestContexts.push(guestContext);

    const guestPage = await guestContext.newPage();
    await joinGuestStudio(guestPage, inviteUrl, sessionId, guestName);

    await test.step("start recording with host and guest present", async () => {
      await hostPage.waitForTimeout(1_000);
      await hostPage.getByRole("button", { name: "Start recording" }).click();
      await expect(
        hostPage.getByRole("button", { name: "Stop recording" }),
      ).toBeVisible();
      await expect(
        guestPage.getByRole("status", { name: "Recording in progress" }),
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("close the host tab while the guest keeps recording", async () => {
      await expect
        .poll(
          async () => {
            const track = await db.track.findFirst({
              where: { sessionId, participantName: hostName },
              include: { segments: true },
            });
            return track?.segments.length ?? 0;
          },
          { timeout: 30_000 },
        )
        .toBe(1);

      await hostPage.waitForTimeout(6_000);
      await hostPage.close();

      await expect(
        guestPage.getByRole("status", { name: "Recording in progress" }),
      ).toBeVisible({ timeout: 30_000 });
    });

    hostPage = await hostContext.newPage();
    await hostPage.goto(`/studio/${sessionId}`);
    await joinStudioWithFakeMicrophone(hostPage, hostName, {
      expectHostControls: true,
    });

    await test.step("returning host catches up and regains stop controls", async () => {
      await expect(
        hostPage.getByRole("button", { name: "Stop recording" }),
      ).toBeVisible({ timeout: 45_000 });

      await expect
        .poll(
          async () => {
            const tracks = await db.track.findMany({
              where: { sessionId, participantName: hostName },
              include: { segments: true },
            });
            return {
              trackCount: tracks.length,
              segmentCount: tracks.reduce(
                (total, track) => total + track.segments.length,
                0,
              ),
            };
          },
          { timeout: 30_000 },
        )
        .toEqual({ trackCount: 1, segmentCount: 2 });
    });

    await test.step("stop and verify the returned host materializes once", async () => {
      await hostPage.waitForTimeout(2_000);
      await hostPage.getByRole("button", { name: "Stop recording" }).click();
      await expect(hostPage.getByText("FINALIZING").first()).toBeVisible();
      await expect(
        hostPage.getByRole("button", { name: "Start recording" }),
      ).toBeVisible({ timeout: 60_000 });

      await expect
        .poll(
          async () => {
            const tracks = await db.track.findMany({
              where: { sessionId, participantName: hostName },
              select: {
                id: true,
                status: true,
                segments: {
                  select: { status: true },
                  orderBy: { segmentIndex: "asc" },
                },
              },
            });
            return tracks.map((track) => ({
              status: track.status,
              segmentCount: track.segments.length,
              completedSegments: track.segments.filter(
                (segment) => segment.status === "complete",
              ).length,
            }));
          },
          { timeout: 60_000 },
        )
        .toEqual([
          {
            status: "complete",
            segmentCount: 2,
            completedSegments: 1,
          },
        ]);

      const hostTrack = await db.track.findFirstOrThrow({
        where: { sessionId, participantName: hostName },
        select: { durationMs: true, s3Key: true },
      });
      await assertStoredRecording(sessionId, hostTrack);
    });

    await test.step("finish the recording from the returned host UI", async () => {
      await hostPage.getByRole("button", { name: "Finish recording" }).click();
      await expect(hostPage.getByText("Ready for ingest")).toBeVisible({
        timeout: 45_000,
      });
    });
  } finally {
    await Promise.all(guestContexts.map((context) => context.close()));
  }
});
