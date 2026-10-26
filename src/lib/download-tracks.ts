"use client";

export interface DownloadTracksInput {
  sessionId: string;
  sessionName: string;
  // The caller supplies the eligible tracks in their desired archive order.
  // Each track is authorized and checked again immediately before downloading.
  tracks: readonly {
    id: string;
    participantName: string;
    format: string;
  }[];
}

class DownloadTracksError extends Error {}

function safeName(value: string, fallback: string, limit = 80): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .slice(0, limit)
    .replace(/^[-_]+|[-_]+$/g, "") || fallback;
}

function safeFormat(format: string): string {
  const extension = format.toLowerCase();
  return ["webm", "ogg", "wav", "mp3", "m4a", "mp4", "flac", "opus", "aac"]
    .includes(extension) ? extension : "bin";
}

/**
 * Fetch media directly from storage, one track at a time. Only authorization
 * JSON passes through the app server. ZIP output is collected into a browser
 * Blob, so total archive size is limited by the browser's Blob/storage budget.
 */
export async function downloadTracksZip(
  { sessionId, sessionName, tracks }: DownloadTracksInput,
  { signal }: { signal?: AbortSignal } = {},
): Promise<void> {
  const controller = new AbortController();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abortError = () => new DOMException("Download cancelled", "AbortError");
  const checkAborted = () => {
    if (controller.signal.aborted) throw abortError();
  };
  const abort = () => {
    controller.abort();
    // client-zip does not cancel its input reader when output fails. Explicitly
    // cancel our reader as well as fetch, including while a read is pending.
    void activeReader?.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  async function* readBody(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    activeReader = reader;
    try {
      for (;;) {
        checkAborted();
        const { value, done } = await reader.read();
        checkAborted();
        if (done) return;
        yield value;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      if (activeReader === reader) activeReader = undefined;
    }
  }

  async function* files() {
    const width = Math.max(3, String(tracks.length).length);
    for (const [index, track] of tracks.entries()) {
      checkAborted();
      const authorization = await fetch(
        `/api/tracks/${encodeURIComponent(track.id)}/download`,
        { signal: controller.signal, credentials: "same-origin", cache: "no-store" },
      );
      if (!authorization.ok) {
        await authorization.body?.cancel().catch(() => {});
        throw new DownloadTracksError(
          authorization.status === 401
            ? "Host access expired. Sign in again to download tracks."
            : "A track is no longer available. Refresh the session and try again.",
        );
      }
      const data: unknown = await authorization.json();
      const url = data && typeof data === "object" && "url" in data ? data.url : undefined;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        throw new DownloadTracksError("Could not authorize a track download. Please try again.");
      }
      checkAborted();
      const response = await fetch(url, {
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new DownloadTracksError("Could not download a track from storage. Please try again.");
      }
      yield {
        name: `${String(index + 1).padStart(width, "0")}-${safeName(track.participantName, "participant")}.${safeFormat(track.format)}`,
        input: readBody(response.body),
      };
    }
  }

  try {
    checkAborted();
    if (tracks.length === 0) {
      throw new DownloadTracksError("No completed tracks are available to download.");
    }
    // client-zip touches browser globals at module initialization.
    const { downloadZip } = await import("client-zip");
    checkAborted();
    const blob = await downloadZip(files()).blob();
    checkAborted();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    try {
      anchor.href = url;
      anchor.download = `cozytrack-${safeName(sessionName, "session")}-${safeName(sessionId, "session", 40)}-tracks.zip`;
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      // Immediate revocation races the browser's download handoff.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (error instanceof DownloadTracksError) throw error;
    // Do not surface fetch errors: browser/network messages may contain signed
    // storage URLs. Nor should storage error response bodies reach the UI.
    throw new Error("Could not download all tracks. Check your connection and try again.");
  } finally {
    signal?.removeEventListener("abort", abort);
    abort();
  }
}
