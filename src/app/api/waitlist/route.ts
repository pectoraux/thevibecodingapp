import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserRole } from "@/lib/auth";

// GET /api/waitlist — ADMIN only. Returns all waitlist entries, newest first.
//   Returns: { entries: WaitlistEntry[] }
export async function GET() {
  try {
    const role = await requireUserRole();
    if (role !== "ADMIN" && role !== "DEMO_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const entries = await db.waitlistEntry.findMany({
      orderBy: { requestedAt: "desc" },
    });
    return NextResponse.json({ entries });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch waitlist" }, { status: 500 });
  }
}
