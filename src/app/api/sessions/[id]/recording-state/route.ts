import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolvePrincipal } from "@/lib/auth";

function parseStartedAt(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed);
}

async function requirePrincipal(req: NextRequest, sessionId: string) {
  const principal = await resolvePrincipal(req, sessionId);
  if (!principal) return { error: "unauthorized", status: 401 } as const;
  if (principal.kind === "guest" && principal.sessionId !== sessionId) {
    return { error: "forbidden", status: 403 } as const;
  }
  return { principal } as const;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const auth = await requirePrincipal(req, id);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const session = await db.session.findUnique({
      where: { id },
      select: { id: true, activeRecordingStartedAt: true },
    });
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    return NextResponse.json({
      active: Boolean(session.activeRecordingStartedAt),
      sessionStartedAt: session.activeRecordingStartedAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error("Failed to read recording state:", error);
    return NextResponse.json(
      { error: "Failed to read recording state" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const auth = await requirePrincipal(req, id);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    if (auth.principal.kind !== "host") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const active = body?.active === true;
    const startedAt = active ? parseStartedAt(body?.sessionStartedAt) : null;
    if (active && !startedAt) {
      return NextResponse.json(
        { error: "sessionStartedAt is required when active is true" },
        { status: 400 },
      );
    }

    const updated = await db.session.update({
      where: { id },
      data: { activeRecordingStartedAt: startedAt },
      select: { activeRecordingStartedAt: true },
    });

    return NextResponse.json({
      active: Boolean(updated.activeRecordingStartedAt),
      sessionStartedAt: updated.activeRecordingStartedAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error("Failed to update recording state:", error);
    return NextResponse.json(
      { error: "Failed to update recording state" },
      { status: 500 },
    );
  }
}
