import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";

// GET /api — root API ping. Requires authentication (used to be a public stub).
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, message: "Forge API", ts: Date.now() });
}
