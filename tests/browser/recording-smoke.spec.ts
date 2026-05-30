import { expect, test } from "@playwright/test";
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
    await db.track.deleteMany({ where: { sessionId } });
    await db.session.deleteMany({ where: { id: sessionId } });
    await deletePrefix(s3, bucket, `sessions/${sessionId}/`);
  }
  cleanupSessions.clear();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test("records a host track through the browser and stores a completed WebM", async ({
  page,
}) => {
  const hostPassword = requiredEnv("HOST_PASSWORD");
  const sessionName = `Browser smoke ${Date.now()}`;
  const participantName = "Browser Smoke Host";

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

  await test.step("join the studio with a fake microphone", async () => {
    await page.getByPlaceholder("Enter your name").fill(participantName);
    await page.getByRole("button", { name: "Join Studio" }).click();

    const continueWithBuiltInMic = page.getByRole("button", {
      name: /continue with built-in mic/i,
    });
    if (await continueWithBuiltInMic.isVisible().catch(() => false)) {
      await continueWithBuiltInMic.click();
    }

    await expect(
      page.getByRole("button", { name: "Start recording" }),
    ).toBeVisible();
  });

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

    expect(track.durationMs).toBeGreaterThan(0);
    expect(track.s3Key).toMatch(
      new RegExp(`^sessions/${sessionId}/tracks/[^/]+/recording\\.webm$`),
    );

    const head = await createS3Client().send(
      new HeadObjectCommand({
        Bucket: requiredEnv("S3_BUCKET_NAME"),
        Key: track.s3Key,
      }),
    );
    expect(head.ContentLength).toBeGreaterThan(0);
  });

  await test.step("finish the recording from the studio UI", async () => {
    await page.getByRole("button", { name: "Finish recording" }).click();
    await expect(page.getByText("Ready for ingest")).toBeVisible({ timeout: 45_000 });
  });
});
