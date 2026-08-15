import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { recordEvidence } from "@/lib/evidence";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType, TaskStatus } from "@/lib/types";

// POST /api/worker/submit-evidence
//
// Phase 8: AUTHENTICATED — requires a valid execution token.
//
// The worker submits execution evidence (test results, guardian results,
// review results, commit SHA, etc.) to the control plane.
// The control plane persists this as immutable evidence.
//
// This replaces the old /api/worker/execute-task endpoint where the control
// plane ran the execution. Now the WORKER executes and REPORTS results.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req);
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    if (!token.executionId) {
      return NextResponse.json({ error: "Execution token required" }, { status: 403 });
    }

    const body = await req.json();
    const { taskId, projectId, commitSha, testResults, guardianResult, reviewResult, filesChanged, implementationLog } = body;

    // Get the task.
    const task = await db.task.findUnique({ where: { id: taskId } });
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // P13: Completion requires a real commit SHA and all verification passes.
    // UNVERIFIED, VIOLATION, ARCHITECTURE_CHANGE_REQUIRED all block completion.
    const testsOk = Array.isArray(testResults) && testResults.length > 0 && testResults.every((t: any) => t.passes);
    const guardianOk = guardianResult?.verdict === "PASS" || guardianResult?.verdict === "WARNING";
    const reviewOk = reviewResult?.verdict === "APPROVED";
    const hasRealCommit = !!commitSha && commitSha !== "null" && commitSha.length >= 7;

    // Task can only be COMPLETED if ALL of:
    // - real commit exists (commitSha is not null)
    // - tests pass
    // - Guardian is PASS or WARNING (NOT UNVERIFIED/VIOLATION/ARCHITECTURE_CHANGE_REQUIRED)
    // - Reviewer is APPROVED
    const canComplete = hasRealCommit && guardianOk && reviewOk && testsOk;

    await db.task.update({
      where: { id: taskId },
      data: {
        commitSha: commitSha || null,
        filesChangedJson: JSON.stringify(filesChanged || []),
        testResultsJson: JSON.stringify(testResults || []),
        guardianResultJson: guardianResult ? JSON.stringify(guardianResult) : null,
        reviewResultJson: reviewResult ? JSON.stringify(reviewResult) : null,
        implementationLog: implementationLog || null,
        architectureStatus: guardianResult?.verdict || "PENDING",
        reviewStatus: reviewResult?.verdict === "APPROVED" ? "PASSED" : reviewResult?.verdict === "REJECTED" ? "FAILED" : "CHANGES_REQUESTED",
        status: canComplete ? TaskStatus.COMPLETED : TaskStatus.FAILED,
        completedAt: canComplete ? new Date() : null,
        failureReason: canComplete ? null : `commit=${hasRealCommit ? "ok" : "MISSING"}, guardian=${guardianResult?.verdict}, review=${reviewResult?.verdict}, tests=${testsOk ? "ok" : "fail"}`,
      },
    });

    // Record immutable evidence.
    const architecture = await db.architecture.findUnique({ where: { projectId } });
    try {
      await recordEvidence(taskId, projectId, {
        architectureVersion: architecture?.version || "unknown",
        architectureHash: architecture?.hash || "unknown",
        commitSha,
        changedFiles: filesChanged || [],
        commandsExecuted: testResults?.map((t: any) => ({ command: t.command || t.name, exitCode: t.exitCode ?? (t.passes ? 0 : 1), durationMs: t.durationMs || 0 })) || [],
        testRuns: testResults || [],
        runtimeChecks: [],
        guardianResults: guardianResult,
        reviewResults: reviewResult,
        integrationChecks: [],
      });
    } catch (err: any) {
      // Evidence recording failure blocks completion (Phase 3 rule).
      await db.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.FAILED,
          failureReason: `BLOCKED — evidence recording failed: ${err.message}`,
        },
      });
    }

    // Emit build event — uses the SAME canComplete expression (with hasRealCommit).
    await ensureBuildEvent({
      projectId,
      type: canComplete ? BuildEventType.TASK_COMPLETED : BuildEventType.TASK_FAILED,
      level: canComplete ? "success" : "error",
      message: `Task ${task.code} ${canComplete ? "COMPLETED" : "FAILED"} by worker ${token.workerId} (commit: ${commitSha?.slice(0, 7) || "none"})`,
      taskId,
      agentType: task.agentType,
    });

    // Phase 10B: success uses the SAME canComplete expression everywhere.
    // No second definition of success — hasRealCommit is always required.
    return NextResponse.json({ ok: true, success: canComplete, taskStatus: canComplete ? "COMPLETED" : "FAILED" });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
