import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { listEvents } from "@/lib/events";
import { parseBuildEvent } from "../../../_lib";

// GET /api/projects/[id]/events?limit=200
//   Returns: { events: BuildEvent[] } — payload pre-parsed if present.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const url = new URL(req.url);
    const rawLimit = url.searchParams.get("limit");
    let limit = 200;
    if (rawLimit) {
      const parsed = parseInt(rawLimit, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 1000);
      }
    }
    const events = await listEvents(id, limit);
    return NextResponse.json({ events: events.map(parseBuildEvent) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch events" }, { status: 500 });
  }
}
