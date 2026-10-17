import { NextRequest, NextResponse } from "next/server";
import { resolvePrincipal, verifyRecordingUploadToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { sanitizeUploadDiagnosticEvent } from "@/lib/upload-diagnostic-event";
import { logUploadDiagnosticEvent } from "@/lib/upload-diagnostics-server";

const MAX_BODY_BYTES = 16 * 1024;

async function readBoundedJson(req: NextRequest): Promise<{ value?: unknown; status?: number }> {
  if (!req.body) return { status: 400 };
  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return { status: 413 };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { value: JSON.parse(text) };
  } catch {
    return { status: 400 };
  } finally {
    reader.releaseLock();
  }
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if ((origin && origin !== new URL(req.url).origin) || req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "JSON required" }, { status: 415 });
  }
  const parsed = await readBoundedJson(req);
  if (parsed.status) return NextResponse.json({ error: "Invalid diagnostic body" }, { status: parsed.status });
  const body = parsed.value as { events?: unknown } | null;
  if (!body || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 20) {
    return NextResponse.json({ error: "Expected 1 to 20 events" }, { status: 400 });
  }
  const events = body.events.map(sanitizeUploadDiagnosticEvent);
  const scope = events[0];
  if (!scope || events.some((event) => !event || event.sessionId !== scope.sessionId || event.trackId !== scope.trackId || event.segmentId !== scope.segmentId)) {
    return NextResponse.json({ error: "Invalid or mixed diagnostic scope" }, { status: 400 });
  }

  try {
    const principal = await resolvePrincipal(req, scope.sessionId);
    if (principal?.kind === "guest" && principal.sessionId !== scope.sessionId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (!principal) {
      const token = req.headers.get("x-cozytrack-recording-token") ?? undefined;
      // Never omit the segment when checking a segment-scoped token: the
      // upload verifier also supports older track-scoped credentials.
      const uploadPrincipal = await verifyRecordingUploadToken(token, scope.sessionId, scope.trackId, scope.segmentId ?? scope.trackId);
      if (!uploadPrincipal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const track = await db.track.findUnique({
      where: { id: scope.trackId },
      select: { sessionId: true, participantId: true },
    });
    // Initial presign failures before track creation remain browser-local.
    // Requiring a stored relationship keeps this endpoint out of arbitrary
    // authenticated log injection and accepts completed tracks for later export.
    if (!track) return NextResponse.json({ error: "Track not found" }, { status: 404 });
    if (track.sessionId !== scope.sessionId || (principal?.kind === "guest" && track.participantId !== principal.participantId)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (scope.segmentId) {
      const segment = await db.trackSegment.findUnique({
        where: { id: scope.segmentId }, select: { trackId: true },
      });
      if (!segment) return NextResponse.json({ error: "Segment not found" }, { status: 404 });
      if (segment.trackId !== scope.trackId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    for (const event of events) logUploadDiagnosticEvent(event, "browser");
    return NextResponse.json({ accepted: events.length }, { status: 202 });
  } catch {
    // Never include authentication, database, or request details in logs.
    return NextResponse.json({ error: "Diagnostics unavailable" }, { status: 503 });
  }
}
