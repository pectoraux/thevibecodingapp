import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { completeExecutionJob } from "@/lib/execution-jobs";

// POST /api/worker/complete
//
// Phase 7: Worker reports the result of a job.
// Idempotent — if the same result is submitted twice, the second is a no-op.
export async function POST(req: Request) {
  try {
    const { executionId, status, commitSha, results, errorMessage, workerId } = await req.json();

    if (!executionId || !status) {
      return NextResponse.json({ error: "executionId and status required" }, { status: 400 });
    }

    // Complete the job (idempotent).
    const completed = await completeExecutionJob(executionId, {
      status,
      commitSha,
      results,
      errorMessage,
    });

    // Update worker concurrency.
    if (workerId) {
      const worker = await db.workerRegistry.findUnique({ where: { workerId } });
      if (worker) {
        const newConcurrency = Math.max(0, worker.currentConcurrency - 1);
        await db.workerRegistry.update({
          where: { workerId },
          data: {
            currentConcurrency: newConcurrency,
            status: newConcurrency === 0 ? "READY" : "BUSY",
            currentJobId: null,
          },
        });
      }
    }

    return NextResponse.json({ ok: completed });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
