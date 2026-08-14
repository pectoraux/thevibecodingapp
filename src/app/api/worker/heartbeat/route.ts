import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { renewExecutionJobLease } from "@/lib/execution-jobs";

// POST /api/worker/heartbeat
//
// Phase 8: AUTHENTICATED — requires a valid execution token with leaseId.
// The worker identity AND lease are verified cryptographically.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req);
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    // For heartbeat, the token must include executionId (proving lease ownership).
    if (!token.executionId) {
      return NextResponse.json({ error: "Execution token required for heartbeat" }, { status: 403 });
    }

    const body = await req.json();
    const jobId = body.jobId;

    if (!jobId) {
      return NextResponse.json({ error: "jobId required" }, { status: 400 });
    }

    // The workerId comes from the token.
    const renewed = await renewExecutionJobLease(jobId, token.workerId);

    // Update worker heartbeat.
    await db.workerRegistry.update({
      where: { workerId: token.workerId },
      data: { lastHeartbeat: new Date() },
    });

    return NextResponse.json({ ok: renewed });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
