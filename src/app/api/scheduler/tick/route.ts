import { NextResponse } from "next/server";
import { requireUserRole } from "@/lib/auth";
import { processBuildQueue, getSchedulerStatus } from "@/lib/scheduler";

// POST /api/scheduler/tick — admin-triggered tick (from UI polling).
export async function POST() {
  const role = await requireUserRole();
  if (role !== "ADMIN" && role !== "DEMO_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await processBuildQueue();
  return NextResponse.json(result);
}

// GET /api/scheduler/tick — Vercel Cron triggered tick.
// Vercel Cron sends: GET with Authorization: Bearer ${CRON_SECRET}
// This processes the build queue without requiring admin auth (cron is authenticated by the secret).
export async function GET(req: Request) {
  // Check for Vercel Cron secret.
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    // Vercel Cron request — process the queue.
    const result = await processBuildQueue();
    return NextResponse.json(result);
  }

  // Not a cron request — return status (admin-only).
  const role = await requireUserRole();
  if (role !== "ADMIN" && role !== "DEMO_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const status = await getSchedulerStatus();
  return NextResponse.json(status);
}
