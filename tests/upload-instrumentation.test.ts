import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeUpload, getPresignedUploadUrl, uploadChunk } from "@/lib/upload";

const { events, record } = vi.hoisted(() => {
  const events: Record<string, unknown>[] = [];
  return { events, record: vi.fn((context, details) => events.push({ ...context, ...details })) };
});
vi.mock("@/lib/upload-diagnostics", () => ({
  createUploadDiagnosticContext: (input: Record<string, unknown>) => ({ ...input, attemptId: "generated-attempt" }),
  recordUploadDiagnostic: record,
}));

const context = {
  attemptId: "attempt-1",
  sessionId: "session-1",
  trackId: "track-1",
  segmentId: "segment-1",
  kind: "retry" as const,
  recordingToken: "private-recording-token",
};
const fetchMock = vi.fn();

beforeEach(() => {
  events.length = 0;
  record.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("upload attempt correlation", () => {
  it("links presign and completion requests with the same attempt ID", async () => {
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url === "/api/upload/presign" ? { url: "https://storage.example/recording" } : { status: "complete" },
    ), { status: 200 }));

    await getPresignedUploadUrl("session-1", "track-1", 9999, undefined,
      { segmentId: "segment-1" }, context.recordingToken, context);
    await completeUpload("session-1", "track-1", 10, context.recordingToken, "segment-1", context);

    for (const endpoint of ["/api/upload/presign", "/api/upload/complete"]) {
      const call = fetchMock.mock.calls.find(([url]) => url === endpoint);
      expect(JSON.parse(call![1].body)).toMatchObject({ diagnosticAttemptId: "attempt-1" });
      expect(JSON.parse(call![1].body)).not.toHaveProperty("recordingToken");
    }
  });

  it("keeps attempt IDs and recording tokens off the S3 request", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const url = "https://storage.example/recording?X-Amz-SignedHeaders=host%3Bif-none-match";
    const blob = new Blob(["recording"]);
    await uploadChunk(url, blob, context);
    expect(fetchMock).toHaveBeenCalledWith(url, {
      method: "PUT", body: blob,
      headers: { "Content-Type": "audio/webm", "If-None-Match": "*" },
    });
  });

  it("distinguishes an existing object from a newly successful PUT", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 412 }));
    await uploadChunk("https://storage.example/r?X-Amz-SignedHeaders=host%3Bif-none-match",
      new Blob(["recording"]), context);
    expect(events).toEqual([
      expect.objectContaining({ attemptId: "attempt-1", stage: "put", outcome: "started", bytes: 9 }),
      expect.objectContaining({ attemptId: "attempt-1", stage: "put", outcome: "already_exists", httpStatus: 412 }),
    ]);
  });

  it("records network failure without pretending there was an HTTP response", async () => {
    const failure = new TypeError("Failed to fetch https://secret.example?token=secret");
    fetchMock.mockRejectedValueOnce(failure);
    await expect(uploadChunk("https://storage.example/r", new Blob(["x"]), context)).rejects.toBe(failure);
    expect(events.at(-1)).toMatchObject({ stage: "put", outcome: "failed", errorCategory: "network" });
    expect(events.at(-1)).not.toHaveProperty("httpStatus");
    expect(events.at(-1)).not.toHaveProperty("message");
    expect(events.at(-1)).not.toHaveProperty("url");
  });

  it("records HTTP completion separately from the returned track readiness", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "failed" }), { status: 200 }));
    await expect(completeUpload("session-1", "track-1", 10, undefined, "segment-1", context)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ stage: "complete", outcome: "succeeded", httpStatus: 200, trackStatus: "failed" }));
  });

  it("does not wait for diagnostic response-body inspection before resolving completion", async () => {
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, "clone").mockReturnValue({ json: () => new Promise(() => {}) } as Response);
    fetchMock.mockResolvedValueOnce(response);
    const completed = vi.fn();
    void completeUpload("session-1", "track-1", 10, undefined, "segment-1", context).then(completed);
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce(), { timeout: 100 });
    expect(events).toContainEqual(expect.objectContaining({ stage: "complete", outcome: "succeeded", httpStatus: 200 }));
  });

  it("does not change upload results when diagnostic recording throws", async () => {
    record.mockImplementationOnce(() => { throw new Error("storage full"); });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(uploadChunk("https://storage.example/r", new Blob(["x"]), context)).resolves.toBeUndefined();
  });
});
