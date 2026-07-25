import { expect, test, type BrowserContext, type Page } from "@playwright/test";
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

async function installSyntheticMicrophone(
  page: Page,
  availableChannels: 1 | 2,
) {
  await page.addInitScript((channelCount) => {
    const contexts: AudioContext[] = [];
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      writable: true,
      value: async (constraints: MediaStreamConstraints) => {
        if (!constraints.audio) {
          throw new DOMException("Synthetic smoke input is audio-only", "NotFoundError");
        }

        const context = new AudioContext({ sampleRate: 48_000 });
        contexts.push(context);
        const destination = new MediaStreamAudioDestinationNode(context, {
          channelCount,
        });
        const merger =
          channelCount === 2 ? context.createChannelMerger(2) : undefined;
        const oscillators: OscillatorNode[] = [];

        for (let channel = 0; channel < channelCount; channel += 1) {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.frequency.value = channel === 0 ? 440 : 880;
          gain.gain.value = 0.08;
          oscillator.connect(gain);
          if (merger) {
            gain.connect(merger, 0, channel);
          } else {
            gain.connect(destination);
          }
          oscillator.start();
          oscillators.push(oscillator);
        }
        merger?.connect(destination);

        const [track] = destination.stream.getAudioTracks();
        const getSettings = track.getSettings.bind(track);
        Object.defineProperty(track, "getSettings", {
          configurable: true,
          value: () => ({ ...getSettings(), channelCount }),
        });
        track.addEventListener(
          "ended",
          () => {
            for (const oscillator of oscillators) {
              try {
                oscillator.stop();
              } catch {
                // Already stopped.
              }
            }
            void context.close();
          },
          { once: true },
        );

        return destination.stream;
      },
    });
    Object.defineProperty(window, "__cozytrackSyntheticMicContexts", {
      configurable: true,
      value: contexts,
    });
  }, availableChannels);
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

async function measureRemoteAudioRms(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const remoteAudio = Array.from(document.querySelectorAll("audio")).find(
      (element) => {
        const stream = element.srcObject as MediaStream | null;
        return stream?.getAudioTracks().some(
          (track) => track.readyState === "live",
        );
      },
    );
    const stream = remoteAudio?.srcObject as MediaStream | null;
    if (!stream) throw new Error("remote audio stream unavailable");

    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    const sink = context.createGain();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    sink.gain.value = 0;
    source.connect(analyser);
    analyser.connect(sink).connect(context.destination);

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      let squares = 0;
      for (const sample of samples) {
        squares += sample * sample;
      }
      return Math.sqrt(squares / samples.length);
    } finally {
      source.disconnect();
      analyser.disconnect();
      sink.disconnect();
      await context.close();
    }
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

test("rejects recording from a stale Studio page after the session is finalized", async ({
  page,
}) => {
  const sessionId = await createAndJoinHostStudio(
    page,
    `Stale finalized studio ${Date.now()}`,
    "Stale Studio Host",
  );
  const writableRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/upload/presign") ||
      request.method() === "PUT"
    ) {
      writableRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  await db.session.update({
    where: { id: sessionId },
    data: { status: "ready", finalizedAt: new Date() },
  });

  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(
    page.getByText(
      "This session is finalized and can no longer be recorded into. Start a new session.",
    ),
  ).toBeVisible();

  await page.waitForTimeout(500);
  const [takes, tracks, segments] = await Promise.all([
    db.recordingTake.count({ where: { sessionId } }),
    db.track.count({ where: { sessionId } }),
    db.trackSegment.count({ where: { track: { sessionId } } }),
  ]);
  expect({ takes, tracks, segments }).toEqual({
    takes: 0,
    tracks: 0,
    segments: 0,
  });
  expect(writableRequests).toEqual([]);
});

test("recovers an unfinished active take before finalizing", async ({ page }) => {
  const participantName = "Unfinished Take Host";
  const sessionId = await createAndJoinHostStudio(
    page,
    `Unfinished take recovery ${Date.now()}`,
    participantName,
  );

  await page.waitForTimeout(1_000);
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
  await page.waitForTimeout(2_000);
  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect(page.getByText("FINALIZING").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start recording" }),
  ).toBeVisible({ timeout: 45_000 });

  await expect
    .poll(
      async () =>
        (
          await db.track.findFirst({
            where: { sessionId, participantName },
            select: { status: true },
          })
        )?.status ?? null,
      { timeout: 30_000 },
    )
    .toBe("complete");

  const unfinishedTake = await db.recordingTake.create({
    data: {
      sessionId,
      startedAt: new Date(),
      status: "recording",
    },
  });
  expect(
    await db.track.count({ where: { takeId: unfinishedTake.id } }),
  ).toBe(0);

  await page.getByRole("button", { name: "Finish recording" }).click();
  const recoveryAction = page.getByRole("button", {
    name: "End unfinished take and continue",
  });
  await expect(recoveryAction).toBeVisible();
  await expect(page.getByText("Ready for ingest")).toBeHidden();
  await expect
    .poll(async () =>
      (
        await db.session.findUniqueOrThrow({ where: { id: sessionId } })
      ).status,
    )
    .toBe("recording");
  await expect
    .poll(async () =>
      (
        await db.recordingTake.findUniqueOrThrow({
          where: { id: unfinishedTake.id },
        })
      ).status,
    )
    .toBe("recording");

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.accept();
  });
  await recoveryAction.click();
  await expect(page.getByText("Ready for ingest")).toBeVisible({
    timeout: 45_000,
  });
  await expect
    .poll(async () =>
      (
        await db.recordingTake.findUniqueOrThrow({
          where: { id: unfinishedTake.id },
        })
      ).status,
    )
    .toBe("stopped");
  await expect
    .poll(async () =>
      (
        await db.session.findUniqueOrThrow({ where: { id: sessionId } })
      ).status,
    )
    .toBe("ready");

  const beforeRetry = await Promise.all([
    db.recordingTake.count({ where: { sessionId } }),
    db.track.count({ where: { sessionId } }),
    db.trackSegment.count({ where: { track: { sessionId } } }),
  ]);
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(
    page.getByText(
      "This session is finalized and can no longer be recorded into. Start a new session.",
    ),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await expect(
    Promise.all([
      db.recordingTake.count({ where: { sessionId } }),
      db.track.count({ where: { sessionId } }),
      db.trackSegment.count({ where: { track: { sessionId } } }),
    ]),
  ).resolves.toEqual(beforeRetry);
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
  const guestContext = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 1280, height: 720 },
  });

  try {
    const sessionId = await createAndJoinHostStudio(
      page,
      `Guest reconnect smoke ${Date.now()}`,
      hostName,
    );
    const inviteUrl = await createInviteUrl(page, sessionId);
    const firstGuestPage = await guestContext.newPage();
    await joinGuestStudio(firstGuestPage, inviteUrl, sessionId, guestName);

    await test.step("start recording with the guest present", async () => {
      await page.waitForTimeout(1_000);
      await page.getByRole("button", { name: "Start recording" }).click();
      await expect(
        page.getByRole("button", { name: "Stop recording" }),
      ).toBeVisible();
      await expect(
        firstGuestPage.getByRole("status", {
          name: "Recording in progress",
        }),
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("close the guest tab after its first segment begins", async () => {
      await expect
        .poll(
          async () =>
            await db.trackSegment.count({
              where: {
                track: { sessionId, participantName: guestName },
              },
            }),
          { timeout: 30_000 },
        )
        .toBe(1);

      // Let the first timeslice upload before simulating the abrupt tab loss.
      await firstGuestPage.waitForTimeout(6_000);
      await firstGuestPage.close();
      await expect(page.getByText(guestName, { exact: true })).toBeHidden({
        timeout: 30_000,
      });
    });

    const returningGuestPage = await guestContext.newPage();
    await joinGuestStudio(
      returningGuestPage,
      inviteUrl,
      sessionId,
      guestName,
    );

    await test.step("returning guest catches up to the active take", async () => {
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
              select: {
                participantId: true,
                segments: { select: { id: true } },
              },
            });
            return {
              trackCount: tracks.length,
              participantIds: tracks.map((track) => track.participantId),
              segmentCount: tracks.reduce(
                (total, track) => total + track.segments.length,
                0,
              ),
            };
          },
          { timeout: 30_000 },
        )
        .toMatchObject({
          trackCount: 1,
          participantIds: [expect.stringMatching(/^guest_[0-9a-f-]+$/)],
          segmentCount: 2,
        });
    });

    await test.step("stop and materialize both guest segments once", async () => {
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
                status: true,
                segments: {
                  select: { status: true },
                  orderBy: { segmentIndex: "asc" },
                },
              },
            });
            return tracks.map((track) => ({
              status: track.status,
              segmentStatuses: track.segments.map((segment) => segment.status),
            }));
          },
          { timeout: 60_000 },
        )
        .toEqual([
          {
            status: "complete",
            segmentStatuses: ["complete", "complete"],
          },
        ]);

      const guestTrack = await db.track.findFirstOrThrow({
        where: { sessionId, participantName: guestName },
        select: { durationMs: true, s3Key: true },
      });
      await assertStoredRecording(sessionId, guestTrack);
    });
  } finally {
    await guestContext.close();
  }
});

test("publishes the additional host channel as one centered remote track while recording both host channels", async ({
  browser,
  page,
}) => {
  const guestContext = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 1280, height: 720 },
  });

  try {
    await installSyntheticMicrophone(page, 2);
    const sessionId = await createAndJoinHostStudio(
      page,
      `Additional channel smoke ${Date.now()}`,
      "Additional Channel Host",
    );
    const inviteUrl = await createInviteUrl(page, sessionId);

    const guestPage = await guestContext.newPage();
    await installSyntheticMicrophone(guestPage, 1);
    await joinGuestStudio(
      guestPage,
      inviteUrl,
      sessionId,
      "Additional Channel Guest",
    );

    await page
      .getByRole("checkbox", { name: "Additional channel" })
      .check();
    await expect(page.getByText("Local Ch 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Local Ch 2", { exact: true })).toBeVisible();

    await expect
      .poll(
        () =>
          guestPage.locator("audio").evaluateAll((elements) =>
            elements.some((element) => {
              const stream = (element as HTMLAudioElement)
                .srcObject as MediaStream | null;
              return stream?.getAudioTracks().some(
                (track) => track.readyState === "live",
              );
            }),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    const receivedChannels = await guestPage.evaluate(async () => {
      const remoteAudio = Array.from(document.querySelectorAll("audio")).find(
        (element) => {
          const stream = element.srcObject as MediaStream | null;
          return stream?.getAudioTracks().some(
            (track) => track.readyState === "live",
          );
        },
      );
      const stream = remoteAudio?.srcObject as MediaStream | null;
      if (!stream) throw new Error("remote audio stream unavailable");

      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const splitter = context.createChannelSplitter(2);
      const left = context.createAnalyser();
      const right = context.createAnalyser();
      const leftSink = context.createGain();
      const rightSink = context.createGain();
      left.fftSize = 2048;
      right.fftSize = 2048;
      left.smoothingTimeConstant = 0;
      right.smoothingTimeConstant = 0;
      leftSink.gain.value = 0;
      rightSink.gain.value = 0;
      source.connect(splitter);
      splitter.connect(left, 0);
      splitter.connect(right, 1);
      left.connect(leftSink).connect(context.destination);
      right.connect(rightSink).connect(context.destination);

      try {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const leftSamples = new Float32Array(left.fftSize);
          const rightSamples = new Float32Array(right.fftSize);
          left.getFloatTimeDomainData(leftSamples);
          right.getFloatTimeDomainData(rightSamples);

          let leftSquares = 0;
          let rightSquares = 0;
          let differenceSquares = 0;
          let dotProduct = 0;
          for (let i = 0; i < leftSamples.length; i += 1) {
            const leftSample = leftSamples[i];
            const rightSample = rightSamples[i];
            leftSquares += leftSample * leftSample;
            rightSquares += rightSample * rightSample;
            differenceSquares +=
              (leftSample - rightSample) * (leftSample - rightSample);
            dotProduct += leftSample * rightSample;
          }

          const leftRms = Math.sqrt(leftSquares / leftSamples.length);
          const rightRms = Math.sqrt(rightSquares / rightSamples.length);
          if (leftRms < 0.001 || rightRms < 0.001) continue;
          return {
            correlation:
              dotProduct / Math.sqrt(leftSquares * rightSquares),
            differenceRms: Math.sqrt(
              differenceSquares / leftSamples.length,
            ),
            leftRms,
            rightRms,
          };
        }
        throw new Error("remote audio stayed silent");
      } finally {
        source.disconnect();
        splitter.disconnect();
        left.disconnect();
        right.disconnect();
        leftSink.disconnect();
        rightSink.disconnect();
        await context.close();
      }
    });
    expect(receivedChannels.leftRms).toBeGreaterThan(0.001);
    expect(receivedChannels.rightRms).toBeGreaterThan(0.001);
    expect(receivedChannels.correlation).toBeGreaterThan(0.999);
    expect(receivedChannels.differenceRms).toBeLessThan(
      Math.max(receivedChannels.leftRms, receivedChannels.rightRms) * 0.01,
    );

    await test.step("mute and unmute the monitor publication as microphone audio", async () => {
      await page.getByRole("button", { name: "Mute microphone" }).click();
      await expect(
        page.getByRole("button", { name: "Unmute microphone" }),
      ).toBeVisible();
      await expect
        .poll(() => measureRemoteAudioRms(guestPage), { timeout: 30_000 })
        .toBeLessThan(0.000_1);

      await page.getByRole("button", { name: "Unmute microphone" }).click();
      await expect(
        page.getByRole("button", { name: "Mute microphone" }),
      ).toBeVisible();
      await expect
        .poll(() => measureRemoteAudioRms(guestPage), { timeout: 30_000 })
        .toBeGreaterThan(0.001);
    });

    await page.getByRole("button", { name: "Start recording" }).click();
    await expect(
      guestPage.getByRole("status", { name: "Recording in progress" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_000);
    await page.getByRole("button", { name: "Stop recording" }).click();
    await expect(
      page.getByRole("button", { name: "Start recording" }),
    ).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(
        async () => {
          const tracks = await db.track.findMany({
            where: { sessionId },
            select: {
              participantId: true,
              participantName: true,
              status: true,
            },
          });
          return tracks
            .map((track) =>
              [
                track.participantId?.startsWith("host-local-ch-")
                  ? track.participantId
                  : track.participantName,
                track.status,
              ].join(":"),
            )
            .sort();
        },
        { timeout: 60_000 },
      )
      .toEqual(
        [
          "Additional Channel Guest:complete",
          "host-local-ch-1:complete",
          "host-local-ch-2:complete",
        ].sort(),
      );
  } finally {
    await guestContext.close();
  }
});
