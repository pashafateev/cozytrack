// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromBuffer } from "yauzl";
import { downloadTracksZip, type DownloadTracksInput } from "@/lib/download-tracks";

const fetchMock = vi.fn<typeof fetch>();
let savedBlob: Blob | undefined;
let anchor: { href: string; download: string; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
let appendChild: ReturnType<typeof vi.fn>;
let createObjectURL: ReturnType<typeof vi.spyOn>;
let revokeObjectURL: ReturnType<typeof vi.spyOn>;

const input: DownloadTracksInput = {
  sessionId: "session-1",
  sessionName: "Interview",
  tracks: [
    { id: "track/1", participantName: "Alice", format: "webm" },
    { id: "track-2", participantName: "Bob", format: "wav" },
  ],
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

function authorize() {
  return json({ url: "https://s3.example/recording?signature=secret" });
}

function extract(blob: Blob): Promise<{ name: string; bytes: Buffer }[]> {
  return blob.arrayBuffer().then((bytes) => new Promise((resolve, reject) => {
    fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const entries: { name: string; bytes: Buffer }[] = [];
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error);
          const chunks: Buffer[] = [];
          stream.on("error", reject);
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.push({ name: entry.fileName, bytes: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  savedBlob = undefined;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
  appendChild = vi.fn();
  vi.stubGlobal("document", {
    createElement: vi.fn(() => anchor),
    body: { appendChild },
  });
  createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    savedBlob = blob as Blob;
    return "blob:archive";
  });
  revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("downloadTracksZip", () => {
  it("creates an independently readable ZIP with original bytes and ordered unique safe names", async () => {
    const bytes = [new Uint8Array([0, 255, 1, 128, 10]), new Uint8Array([82, 73, 70, 70])];
    fetchMock
      .mockResolvedValueOnce(authorize())
      .mockResolvedValueOnce(new Response(bytes[0]))
      .mockResolvedValueOnce(authorize())
      .mockResolvedValueOnce(new Response(bytes[1]));
    await downloadTracksZip({
      ...input,
      sessionName: '../../CON\r\n"<>: /',
      sessionId: "../unsafe\\session",
      tracks: [
        { ...input.tracks[0], participantName: "../../Álice\\\r\n<evil>", format: "WEBM" },
        { ...input.tracks[1], participantName: "../../Álice\\\r\n<evil>", format: "../exe" },
      ],
    });

    expect(await extract(savedBlob!)).toEqual([
      { name: "001-Alice-evil.webm", bytes: Buffer.from(bytes[0]) },
      { name: "002-Alice-evil.bin", bytes: Buffer.from(bytes[1]) },
    ]);
    expect(anchor.download).toBe("cozytrack-CON-unsafe-session-tracks.zip");
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:archive");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/tracks/track%2F1/download", {
      signal: expect.any(AbortSignal), credentials: "same-origin", cache: "no-store",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://s3.example/recording?signature=secret", {
      signal: expect.any(AbortSignal), credentials: "omit", cache: "no-store",
    });
  });

  it("fetches and authorizes the next track only after the previous source ends", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    fetchMock
      .mockResolvedValueOnce(authorize())
      .mockResolvedValueOnce(new Response(body))
      .mockResolvedValueOnce(authorize())
      .mockResolvedValueOnce(new Response("second"));

    const pending = downloadTracksZip(input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    source.enqueue(new TextEncoder().encode("first"));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    source.close();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await extract(savedBlob!)).map((entry) => entry.bytes.toString())).toEqual(["first", "second"]);
  });

  it("uses fallback names and bounds filename length", async () => {
    fetchMock
      .mockResolvedValueOnce(authorize())
      .mockResolvedValueOnce(new Response("one"))
      .mockResolvedValueOnce(authorize())
      .mockResolvedValueOnce(new Response("two"));
    await downloadTracksZip({
      ...input, sessionName: "", sessionId: "",
      tracks: [
        { ...input.tracks[0], participantName: ".../\\\u0000", format: "" },
        { ...input.tracks[1], participantName: "a".repeat(1000), format: "webm" },
      ],
    });
    const entries = await extract(savedBlob!);
    expect(entries[0].name).toBe("001-participant.bin");
    expect(entries[1].name).toBe(`002-${"a".repeat(80)}.webm`);
    expect(anchor.download).toBe("cozytrack-session-session-tracks.zip");
  });

  it.each([401, 404, 409, 410, 500])("stops when track authorization returns %s", async (status) => {
    fetchMock.mockResolvedValueOnce(json({ error: "unsafe internal detail" }, status));
    await expect(downloadTracksZip(input)).rejects.toThrow(
      status === 401 ? "Host access expired" : "A track is no longer available",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each([403, 404, 500])("stops and cancels storage error response %s", async (status) => {
    const cancel = vi.fn();
    fetchMock
      .mockResolvedValueOnce(authorize())
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }));
    await expect(downloadTracksZip(input)).rejects.toThrow("Could not download a track from storage");
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each([{}, { url: "javascript:alert(1)" }, { url: 42 }])("rejects malformed authorization data %j", async (data) => {
    fetchMock.mockResolvedValueOnce(json(data));
    await expect(downloadTracksZip(input)).rejects.toThrow("Could not authorize");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("hides network errors and signed URLs", async () => {
    fetchMock.mockResolvedValueOnce(authorize()).mockRejectedValueOnce(
      new Error("Failed fetching https://s3.example/recording?signature=secret"),
    );
    await expect(downloadTracksZip(input)).rejects.toThrow(
      /^Could not download all tracks\. Check your connection and try again\.$/,
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("handles a source stream failure without downloading later tracks", async () => {
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("signed URL / internal storage error")); },
    });
    fetchMock.mockResolvedValueOnce(authorize()).mockResolvedValueOnce(new Response(source));
    await expect(downloadTracksZip(input)).rejects.toThrow(/^Could not download all tracks/);
    expect(source.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });

  it("cancels a pending source read and ZIP Blob consumption on abort", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    fetchMock.mockResolvedValueOnce(authorize()).mockResolvedValueOnce(new Response(source));
    const controller = new AbortController();
    const pending = downloadTracksZip(input, { signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(source.locked).toBe(true));
    controller.abort();
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("aborts pending authorization requests", async () => {
    fetchMock.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
    }));
    const controller = new AbortController();
    const pending = downloadTracksZip(input, { signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does no work when already cancelled or no tracks are eligible", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(downloadTracksZip(input, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(downloadTracksZip({ ...input, tracks: [] })).rejects.toThrow("No completed tracks");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("removes the anchor and eventually revokes the URL if the browser handoff fails", async () => {
    fetchMock.mockResolvedValueOnce(authorize()).mockResolvedValueOnce(new Response("one"));
    anchor.click.mockImplementationOnce(() => { throw new Error("handoff failed"); });
    await expect(downloadTracksZip({ ...input, tracks: input.tracks.slice(0, 1) })).rejects.toThrow(/^Could not download all tracks/);
    expect(anchor.remove).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:archive");
  });
});
