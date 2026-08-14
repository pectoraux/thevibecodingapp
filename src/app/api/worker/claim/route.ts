import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { claimExecutionJob } from "@/lib/execution-jobs";

// POST /api/worker/claim
//
// Phase 7: Worker requests the next available job.
// The control plane atomically assigns a job using FOR UPDATE SKIP LOCKED.
// Two workers can NEVER claim the same job.
//
// Returns: { job: ClaimedJob | null }
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { workerId, capabilities } = body;

    if (!workerId) {
      return NextResponse.json({ error: "workerId required" }, { status: 400 });
    }

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
    const job = await claimExecutionJob(workerId, capabilities || JSON.parse(worker.capabilities));

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
    }

    return NextResponse.json({ job });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
