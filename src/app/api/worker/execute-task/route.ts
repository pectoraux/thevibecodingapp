import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { executeTask } from "@/lib/orchestrator";

// POST /api/worker/execute-task
//
// Phase 7: Called by the worker process to execute a claimed task.
// The worker owns the lease and sends heartbeats; this endpoint runs the
// actual task execution (LLM → git → tests → guardian → review → commit).
//
// The worker is authenticated by its registered workerId. We verify the
// worker exists and has an active claim on the job.
export async function POST(req: Request) {
  try {
    const { workerId, executionId, projectId, taskId, attempt } = await req.json();

    if (!workerId || !executionId || !projectId || !taskId) {
      return NextResponse.json({ error: "workerId, executionId, projectId, taskId required" }, { status: 400 });
    }

    // Verify the worker is registered.
    const worker = await db.workerRegistry.findUnique({ where: { workerId } });
    if (!worker) {
      return NextResponse.json({ error: "Worker not registered" }, { status: 403 });
    }

    // Verify the execution job exists and is claimed by this worker.
    const job = await db.executionJob.findUnique({ where: { executionId } });
    if (!job || job.workerId !== workerId) {
      return NextResponse.json({ error: "Job not claimed by this worker" }, { status: 403 });
    }

    // Update job status to RUNNING.
    await db.executionJob.update({
      where: { id: job.id },
      data: { status: "RUNNING", startedAt: new Date() },
    });

    // Execute the task via the orchestrator.
    // This calls executeTask() which does: LLM → git worktree → tests → guardian → review → commit.
    await executeTask(projectId, taskId);

    // Fetch the task to get the result.
    const task = await db.task.findUnique({ where: { id: taskId } });
    const success = task?.status === "COMPLETED";

    return NextResponse.json({
      success,
      commitSha: task?.commitSha || null,
      error: task?.failureReason || null,
      results: {
        taskStatus: task?.status,
        testResults: task?.testResultsJson ? JSON.parse(task.testResultsJson) : [],
        guardianResult: task?.guardianResultJson ? JSON.parse(task.guardianResultJson) : null,
        reviewResult: task?.reviewResultJson ? JSON.parse(task.reviewResultJson) : null,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
