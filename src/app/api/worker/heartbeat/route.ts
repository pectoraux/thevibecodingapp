import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { renewExecutionJobLease } from "@/lib/execution-jobs";

// POST /api/worker/heartbeat
//
// Phase 8: AUTHENTICATED — requires a valid execution token with leaseId.
// The worker identity AND lease are verified cryptographically.
//
// Phase 18I: Lease-fenced heartbeat. Uses token.executionId and token.leaseId
// (not body.jobId) for authorization. The lease must be current and not expired.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req);
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    // For heartbeat, the token must include executionId and leaseId.
    if (!token.executionId) {
      return NextResponse.json({ error: "Execution token required for heartbeat" }, { status: 403 });
    }
    if (!token.leaseId) {
      return NextResponse.json({ error: "Lease ID required for heartbeat" }, { status: 403 });
    }

    // Phase 18I: Use token.executionId + token.leaseId (not body.jobId).
    // The lease is the fencing primitive — body.jobId is IGNORED.
    const renewed = await renewExecutionJobLease(
      token.executionId,
      token.workerId,
      token.leaseId
    );

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
