import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { renewExecutionJobLease } from "@/lib/execution-jobs";

// POST /api/worker/heartbeat
//
// Phase 7: Worker renews its lease on a job.
// Called periodically (lease_duration / 3) while the job is running.
// If the worker dies and stops heartbeating, the lease expires and the
// job is recovered (requeued) by recoverExpiredExecutionJobs().
export async function POST(req: Request) {
  try {
    const { workerId, jobId } = await req.json();

    if (!workerId || !jobId) {
      return NextResponse.json({ error: "workerId and jobId required" }, { status: 400 });
    }

    const renewed = await renewExecutionJobLease(jobId, workerId);

    // Update worker heartbeat.
    await db.workerRegistry.update({
      where: { workerId },
      data: { lastHeartbeat: new Date() },
    });

    return NextResponse.json({ ok: renewed });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
