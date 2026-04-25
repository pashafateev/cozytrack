import { NextRequest, NextResponse } from "next/server";
import { resolvePrincipal } from "@/lib/auth";
import { getSession } from "@/lib/sessions";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Host can read any session; guest can read only the session their
    // invite is scoped to (so the studio page loads for them).
    const principal = await resolvePrincipal(req, id);
    if (!principal) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (principal.kind === "guest" && principal.sessionId !== id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    return await getSession(id);
  } catch (error) {
    console.error("Failed to get session:", error);
    return NextResponse.json(
      { error: "Failed to get session" },
      { status: 500 }
    );
  }
}
