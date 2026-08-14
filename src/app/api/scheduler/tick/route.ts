import { NextResponse } from "next/server";
import { requireUserRole } from "@/lib/auth";
import { getWorkerToken } from "@/lib/worker-auth";
import { processBuildQueue, getSchedulerStatus } from "@/lib/scheduler";

// POST /api/scheduler/tick
//
// Phase 8: Accepts worker session tokens OR admin auth.
// The worker calls this to trigger ExecutionJob creation from queued BuildJobs.
// This ensures the worker drives the entire pipeline without browser/admin intervention.
export async function POST(req: Request) {
  // Try worker authentication first.
  const workerToken = getWorkerToken(req);
  if (workerToken) {
    const result = await processBuildQueue();
    return NextResponse.json(result);
  }

  // Fall back to admin authentication.
  const role = await requireUserRole();
  if (role !== "ADMIN" && role !== "DEMO_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await processBuildQueue();
  return NextResponse.json(result);
}

// GET /api/scheduler/tick — Vercel Cron triggered tick.
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    const result = await processBuildQueue();
    return NextResponse.json(result);
  }

  const role = await requireUserRole();
  if (role !== "ADMIN" && role !== "DEMO_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const status = await getSchedulerStatus();
  return NextResponse.json(status);
}
