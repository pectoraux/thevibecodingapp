import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId, requireUserRole } from "@/lib/auth";

// POST /api/waitlist/[entryId]/reject — ADMIN only.
//   Body: (none)
//   - Updates the WaitlistEntry: status=REJECTED, reviewedAt, reviewedBy.
//   - Returns { entry } (the updated waitlist entry).
export async function POST(_req: Request, { params }: { params: Promise<{ entryId: string }> }) {
  try {
    const role = await requireUserRole();
    if (role !== "ADMIN" && role !== "DEMO_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const adminUserId = await requireUserId();
    if (!adminUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { entryId } = await params;
    const entry = await db.waitlistEntry.findUnique({ where: { id: entryId } });
    if (!entry) {
      return NextResponse.json({ error: "Waitlist entry not found" }, { status: 404 });
    }

    const updated = await db.waitlistEntry.update({
      where: { id: entryId },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedBy: adminUserId,
      },
    });

    return NextResponse.json({ entry: updated });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to reject waitlist entry" }, { status: 500 });
  }
}
