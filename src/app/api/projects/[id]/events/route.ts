import { NextResponse } from "next/server";
import { listEvents } from "@/lib/events";
import { parseBuildEvent } from "../../../_lib";

// GET /api/projects/[id]/events?limit=200
//   Returns: { events: BuildEvent[] } — payload pre-parsed if present.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
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
