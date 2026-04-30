import { NextRequest, NextResponse } from "next/server";
import { listSessions } from "@/lib/sessions";

export async function GET(req: NextRequest) {
  try {
    return await listSessions(req);
  } catch (error) {
    console.error("Failed to list sessions:", error);
    return NextResponse.json(
      { error: "Failed to list sessions" },
      { status: 500 }
    );
  }
}
