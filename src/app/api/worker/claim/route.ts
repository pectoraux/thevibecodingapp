import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { claimExecutionJob } from "@/lib/execution-jobs";

// POST /api/worker/claim
//
// Phase 8: AUTHENTICATED — requires a valid worker session token.
// The worker identity is established cryptographically via the token.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req);
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const workerId = token.workerId;

    // Verify the worker is registered and active.
    const worker = await db.workerRegistry.findUnique({ where: { workerId } });
    if (!worker || worker.status === "OFFLINE") {
      return NextResponse.json({ error: "Worker not registered" }, { status: 403 });
    }

    // Check worker capacity.
    if (worker.currentConcurrency >= worker.maxConcurrency) {
      return NextResponse.json({ job: null, reason: "Worker at capacity" });
    }

    // Atomically claim the next job.
    const capabilities = JSON.parse(worker.capabilities || "[]");
    const job = await claimExecutionJob(workerId, capabilities);

    if (job) {
      // Update worker concurrency.
      await db.workerRegistry.update({
        where: { workerId },
        data: {
          currentConcurrency: { increment: 1 },
          status: "BUSY",
          currentJobId: job.id,
          lastHeartbeat: new Date(),
        },
      });

      // Issue an execution-specific token (with leaseId) for heartbeat/complete.
      // Phase 18I: Use the ACTUAL leaseId from the DB, not job.id.
      const { createExecutionToken } = await import("@/lib/worker-auth");
      const executionToken = createExecutionToken(
        workerId,
        job.executionId,
        job.leaseId, // Phase 18I: The real lease ID from claimExecutionJob.
        job.projectId,
        capabilities
      );

      return NextResponse.json({ job, executionToken });
    }

    return NextResponse.json({ job: null });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
