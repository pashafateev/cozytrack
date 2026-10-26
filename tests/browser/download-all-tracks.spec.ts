import { expect, test } from "@playwright/test";
import { open } from "yauzl";

function readZip(path: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("Missing ZIP"));
      const entries = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error("Missing entry"));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

test("downloads one valid ZIP from the saved-session button", async ({ page }) => {
  // This focused browser test needs no database or media services: it exercises
  // the real UI, ZIP library, cross-origin fetch, and browser download.
  const signin = await page.request.post("/api/auth/signin", {
    data: { password: process.env.HOST_PASSWORD },
  });
  expect(signin.ok()).toBe(true);
  const sessionId = "download-browser-test";
  const tracks = ["track-1", "track-2"].map((id) => ({
    id,
    participantName: "Same participant",
    s3Key: `sessions/${sessionId}/${id}.webm`,
    s3PurgedAt: null,
    durationMs: 1_000,
    format: "webm",
    status: "complete",
    createdAt: "2026-10-24T10:00:00.000Z",
    deviceLabel: null,
    isBuiltInMic: false,
  }));
  await page.route(`**/api/sessions/${sessionId}`, (route) => route.fulfill({
    json: {
      id: sessionId,
      name: "Browser ZIP test",
      createdAt: "2026-10-24T10:00:00.000Z",
      tracks,
    },
  }));
  const requestedTracks: string[] = [];
  await page.route("**/api/tracks/*/download", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    requestedTracks.push(id);
    return route.fulfill({ json: { url: `https://recordings.test/${id}.webm` } });
  });
  await page.route("https://recordings.test/*", (route) => route.fulfill({
    body: Buffer.from(new URL(route.request().url()).pathname),
    contentType: "audio/webm",
    headers: { "Access-Control-Allow-Origin": "*" },
  }));
  await page.goto(`/session/${sessionId}`);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download All Tracks" }).click();
  const download = await downloadEvent;

  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).toBeTruthy();
  const entries = await readZip(path!);
  expect(entries.size).toBe(2);
  expect([...entries.keys()].every((name) => name.endsWith(".webm"))).toBe(true);
  expect([...entries.values()].map((bytes) => bytes.toString())).toEqual([
    "/track-1.webm",
    "/track-2.webm",
  ]);
  expect(requestedTracks).toEqual(["track-1", "track-2"]);
});
