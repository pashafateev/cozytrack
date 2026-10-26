// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { issueGuestSessionCookie, issueHostSessionCookie, issueRecordingUploadToken } from "@/lib/auth";
import { POST } from "@/app/api/upload/diagnostics/route";

const records = vi.hoisted(() => ({
  track: { id: "track-1", sessionId: "session-1", participantId: "guest-1", status: "complete" } as Record<string, unknown> | null,
  segment: { trackId: "track-1" } as Record<string, unknown> | null,
}));
vi.mock("@/lib/db", () => ({ db: {
  track: { findUnique: async () => records.track },
  trackSegment: { findUnique: async () => records.segment },
} }));

const event = {
  version: 1, id: "event-1", attemptId: "attempt-1", sessionId: "session-1",
  trackId: "track-1", segmentId: "segment-1", kind: "final", stage: "put",
  outcome: "failed", at: 1_800_000_000_000,
};
function request(events: unknown[], headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://cozytrack.example/api/upload/diagnostics", {
    method: "POST", body: JSON.stringify({ events }),
    headers: { "content-type": "application/json", ...headers },
  });
}
async function hostHeaders() {
  return { cookie: `cozytrack_host=${await issueHostSessionCookie()}` };
}
let output: string[];
beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-secret-for-upload-diagnostics-12345678");
  records.track = { id: "track-1", sessionId: "session-1", participantId: "guest-1", status: "complete" };
  records.segment = { trackId: "track-1" };
  output = [];
  vi.spyOn(console, "info").mockImplementation((...args) => { output.push(args.join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("upload diagnostic collector", () => {
  it("accepts a completed track and logs only sanitized browser data", async () => {
    const response = await POST(request([{ ...event, source: "server", receivedAt: 3, message: "secret", url: "https://secret" }], await hostHeaders()));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1 });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/^\[UPLOAD\] /);
    expect(JSON.parse(output[0].slice(9))).toEqual({ ...event, source: "browser", receivedAt: expect.any(Number) });
  });

  it("accepts a guest's own track", async () => {
    const cookie = await issueGuestSessionCookie("session-1", "Alice", "guest-1");
    expect((await POST(request([event], { cookie: `cozytrack_guest_session-1=${cookie.value}` }))).status).toBe(202);
  });

  it("rejects a guest's attempt to report another participant's track without logging", async () => {
    const cookie = await issueGuestSessionCookie("session-1", "Alice", "other-guest");
    expect((await POST(request([event], { cookie: `cozytrack_guest_session-1=${cookie.value}` }))).status).toBe(403);
    expect(output).toEqual([]);
  });

  it("accepts exact recording token scope after cookies expire", async () => {
    const token = await issueRecordingUploadToken("session-1", "track-1", "segment-1");
    expect((await POST(request([event], { "x-cozytrack-recording-token": token }))).status).toBe(202);
  });

  it.each(["wrong-segment", undefined])("does not bypass token segment scope with %s", async (segmentId) => {
    const token = await issueRecordingUploadToken("session-1", "track-1", "segment-1");
    expect((await POST(request([{ ...event, segmentId }], { "x-cozytrack-recording-token": token }))).status).toBe(401);
    expect(output).toEqual([]);
  });

  it("rejects unauthenticated logs", async () => {
    expect((await POST(request([event]))).status).toBe(401);
    expect(output).toEqual([]);
  });

  it.each<Record<string, string>>([
    { origin: "https://attacker.example" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
  ])("rejects cross-site submissions even with valid cookies: %j", async (headers) => {
    expect((await POST(request([event], { ...await hostHeaders(), ...headers }))).status).toBe(403);
    expect(output).toEqual([]);
  });

  it.each([
    { events: [] }, { events: Array.from({ length: 21 }, () => event) },
    { events: [event, { ...event, trackId: "track-2" }] },
    { events: [event, { ...event, segmentId: "segment-2" }] },
    { events: [{ ...event, stage: "secret" }] },
  ])("rejects malformed or mixed-scope batches", async ({ events }) => {
    expect((await POST(request(events, await hostHeaders()))).status).toBe(400);
    expect(output).toEqual([]);
  });

  it("bounds actual body bytes even when Content-Length understates them", async () => {
    const response = await POST(request([{ ...event, message: "x".repeat(17_000) }], { ...await hostHeaders(), "content-length": "1" }));
    expect(response.status).toBe(413);
    expect(output).toEqual([]);
  });

  it("requires JSON so cross-origin simple forms cannot submit diagnostics", async () => {
    expect((await POST(request([event], { ...await hostHeaders(), "content-type": "text/plain" }))).status).toBe(415);
    expect(output).toEqual([]);
  });

  it.each([
    { track: null, segment: { trackId: "track-1" }, status: 404 },
    { track: { sessionId: "other-session" }, segment: { trackId: "track-1" }, status: 403 },
    { track: { sessionId: "session-1" }, segment: null, status: 404 },
    { track: { sessionId: "session-1" }, segment: { trackId: "other-track" }, status: 403 },
  ])("validates stored track and segment relationships", async ({ track, segment, status }) => {
    records.track = track;
    records.segment = segment;
    expect((await POST(request([event], await hostHeaders()))).status).toBe(status);
    expect(output).toEqual([]);
  });
});
