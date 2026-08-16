import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { completeExecutionJob } from "@/lib/execution-jobs";

// POST /api/worker/complete
//
// Phase 8: AUTHENTICATED — requires a valid execution token.
// The worker identity is verified cryptographically. Results are idempotent.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req, "EXECUTION");
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    // For completion, the token must include executionId and leaseId.
    if (!token.executionId) {
      return NextResponse.json({ error: "Execution token required for completion" }, { status: 403 });
    }

    // Phase 18I: Require leaseId for lease-fenced completion.
    if (!token.leaseId) {
      return NextResponse.json({ error: "Lease ID required for completion" }, { status: 403 });
    }

    const body = await req.json();
    const { status, commitSha, results, errorMessage } = body;

    if (!status) {
      return NextResponse.json({ error: "status required" }, { status: 400 });
    }

    // Phase 18I: Lease-fenced completion — requires workerId + leaseId + not-expired.
    const completed = await completeExecutionJob(
      token.executionId,
      token.workerId,
      token.leaseId,
      {
        status,
        commitSha,
        results,
        errorMessage,
      }
    );

    // Update worker concurrency.
    const worker = await db.workerRegistry.findUnique({ where: { workerId: token.workerId } });
    if (worker) {
      const newConcurrency = Math.max(0, worker.currentConcurrency - 1);
      await db.workerRegistry.update({
        where: { workerId: token.workerId },
        data: {
          currentConcurrency: newConcurrency,
          status: newConcurrency === 0 ? "READY" : "BUSY",
          currentJobId: null,
        },
      });
    }

    return NextResponse.json({ ok: completed });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
