import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { recordEvidence } from "@/lib/evidence";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType, TaskStatus } from "@/lib/types";
import { canCompleteTask, getFailureReason, type TaskEvidence as TaskEvidenceObj, type ProjectMode } from "@/lib/completion-policy";

// POST /api/worker/submit-evidence
//
// Phase 15B: Git evidence is fully authoritative.
// The control plane derives ALL identity from the execution token:
//   - taskId from ExecutionJob
//   - projectId from ExecutionJob
//   - workerId from ExecutionJob
//   - expectedBranch from task.code + executionJob.attempt (NOT from worker body)
//   - expectedBase from task graph (NOT from worker body)
//   - repository from project.githubRepo (NOT from worker body)
//
// The worker submits only execution evidence (commitSha, pushedToRemote, test/guardian/review results).
// The control plane independently verifies GitHub state using DERIVED values.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req);
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    if (!token.executionId) {
      return NextResponse.json({ error: "Execution token required" }, { status: 403 });
    }

    // P15C: Derive ALL identity from the execution token AND verify the lease.
    const executionJob = await db.executionJob.findUnique({
      where: { executionId: token.executionId },
      select: { id: true, taskId: true, projectId: true, workerId: true, attempt: true, leaseId: true, leaseExpiresAt: true },
    });

    if (!executionJob) {
      return NextResponse.json({ error: "Execution job not found for token" }, { status: 403 });
    }

    // P15C: Verify worker owns this execution.
    if (executionJob.workerId !== token.workerId) {
      return NextResponse.json({ error: "Worker does not own this execution" }, { status: 403 });
    }

    // P15C: Verify the lease is still valid.
    if (executionJob.leaseId !== token.leaseId) {
      return NextResponse.json({ error: "Lease mismatch — token lease does not match execution lease" }, { status: 403 });
    }

    if (executionJob.leaseExpiresAt && executionJob.leaseExpiresAt < new Date()) {
      return NextResponse.json({ error: "Lease expired — evidence submission rejected" }, { status: 403 });
    }

    const taskId = executionJob.taskId;
    const projectId = executionJob.projectId;

    const task = await db.task.findUnique({ where: { id: taskId! } });
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const mode: ProjectMode = project.githubConnected && project.githubRepo ? "GITHUB_BACKED" : "LOCAL_ONLY";

    // P15B: Derive expected branch from TRUSTED state (task.code + executionJob.attempt).
    // Do NOT trust body.branchName.
    const expectedBranch = `forge/${task.code.toLowerCase()}/attempt-${executionJob.attempt}`;

    // P15C: Derive expected baseCommitSha from the task graph.
    // For tasks with multiple dependencies, ALL must be completed.
    // The base is the MOST RECENT commit across all completed dependencies.
    // (In a sequential merge model, the project HEAD advances after each merge,
    // so the latest dependency commit represents the canonical base.)
    // If any dependency is NOT completed, the base is null → ancestry check
    // is skipped, but the task should not have been claimed in the first place.
    let expectedBaseCommitSha: string | null = null;
    const deps = JSON.parse(task.dependencies || "[]") as string[];
    if (deps.length > 0) {
      const depTasks = await db.task.findMany({
        where: {
          projectId,
          code: { in: deps },
          status: "COMPLETED",
          commitSha: { not: null },
        },
        orderBy: { completedAt: "desc" },
      });

      // P15C: Verify ALL dependencies are completed.
      if (depTasks.length === deps.length) {
        // All deps complete — use the most recent commit as the base.
        // In a sequential model, this is the project's current HEAD.
        if (depTasks.length > 0 && depTasks[0].commitSha) {
          expectedBaseCommitSha = depTasks[0].commitSha;
        }
      } else {
        // Not all dependencies are completed — this is a scheduling error.
        // The task should not have been claimed. Mark as BLOCKED.
        const missing = deps.filter(d => !depTasks.some(dt => dt.code === d));
        return NextResponse.json({
          error: `BLOCKED: Dependencies not completed: ${missing.join(", ")}`,
        }, { status: 403 });
      }
    }

    // Accept execution evidence from the body — but NOT identity values.
    const body = await req.json();
    const { commitSha, pushedToRemote, testResults, guardianResult, reviewResult, filesChanged, implementationLog } = body;

    // P15B: Remote verification uses DERIVED expected values, not worker-supplied.
    let remoteCommitVerified = false;
    if (mode === "GITHUB_BACKED" && commitSha && pushedToRemote) {
      try {
        remoteCommitVerified = await verifyRemoteCommit(
          project.githubRepo!,
          commitSha,
          expectedBranch,           // DERIVED from task code + attempt
          expectedBaseCommitSha      // DERIVED from task graph
        );
      } catch (err: any) {
        console.error(`[submit-evidence] Remote verification failed: ${err.message}`);
        remoteCommitVerified = false;
      }
    } else if (mode === "LOCAL_ONLY") {
      remoteCommitVerified = true;
    }

    const testsPassed = Array.isArray(testResults) && testResults.length > 0 && testResults.every((t: any) => t.passes);

    // Record immutable evidence with FULL Git metadata.
    const architecture = await db.architecture.findUnique({ where: { projectId } });
    let evidencePersisted = false;
    try {
      await recordEvidence(taskId!, projectId, {
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
        // P15B: Git evidence metadata
        executionId: token.executionId,
        workerId: token.workerId,
        branchName: expectedBranch,
        baseCommitSha: expectedBaseCommitSha,
        pushedToRemote: pushedToRemote || false,
        remoteCommitVerified,
      });
      evidencePersisted = true;
    } catch {
      // Evidence recording failure blocks completion.
    }

    const evidence: TaskEvidenceObj = {
      commitSha: commitSha || null,
      pushedToRemote: pushedToRemote || false,
      remoteCommitVerified,
      baseCommitSha: expectedBaseCommitSha,
      guardianVerdict: guardianResult?.verdict || "UNVERIFIED",
      reviewVerdict: reviewResult?.verdict || "REJECTED",
      testsPassed,
      evidencePersisted,
    };

    const canComplete = canCompleteTask(evidence, mode);
    const failureReason = canComplete ? null : getFailureReason(evidence, mode);

    await db.task.update({
      where: { id: taskId! },
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
        failureReason,
      },
    });

    await ensureBuildEvent({
      projectId,
      type: canComplete ? BuildEventType.TASK_COMPLETED : BuildEventType.TASK_FAILED,
      level: canComplete ? "success" : "error",
      message: `Task ${task.code} ${canComplete ? "COMPLETED" : "FAILED"} by worker ${token.workerId} (commit: ${commitSha?.slice(0, 7) || "none"}, branch: ${expectedBranch}, push: ${pushedToRemote ? "ok" : "fail"}, remote: ${remoteCommitVerified ? "verified" : "unverified"})`,
      taskId: taskId!,
      agentType: task.agentType,
    });

    return NextResponse.json({ ok: true, success: canComplete, taskStatus: canComplete ? "COMPLETED" : "FAILED", failureReason });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// P15B: Independently verify remote commit using DERIVED expected values.
async function verifyRemoteCommit(
  githubRepo: string,
  commitSha: string,
  expectedBranch: string,
  expectedBaseCommitSha: string | null
): Promise<boolean> {
  const githubPat = process.env.GITHUB_PAT;
  if (!githubPat) {
    console.error("[submit-evidence] No GITHUB_PAT for remote verification");
    return false;
  }

  const [owner, repo] = githubRepo.split("/");
  const headers = {
    "Authorization": `token ${githubPat}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "Forge-Control-Plane",
  };

  try {
    // 1. Commit exists.
    const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}`, {
      headers, signal: AbortSignal.timeout(10000),
    });
    if (!commitRes.ok) {
      console.error(`[submit-evidence] Commit not found: HTTP ${commitRes.status}`);
      return false;
    }

    // 2. Expected branch exists.
    const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(expectedBranch)}`, {
      headers, signal: AbortSignal.timeout(10000),
    });
    if (!branchRes.ok) {
      console.error(`[submit-evidence] Expected branch not found: ${expectedBranch}`);
      return false;
    }

    // 3. Branch HEAD matches.
    const branchData = await branchRes.json();
    if (branchData.commit?.sha !== commitSha) {
      console.error(`[submit-evidence] Branch HEAD mismatch: expected ${commitSha.slice(0, 7)}, got ${branchData.commit?.sha?.slice(0, 7)}`);
      return false;
    }

    // 4. Base ancestry.
    if (expectedBaseCommitSha) {
      const compareRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/compare/${expectedBaseCommitSha}...${commitSha}`, {
        headers, signal: AbortSignal.timeout(10000),
      });
      if (!compareRes.ok) {
        console.error(`[submit-evidence] Ancestry check failed: HTTP ${compareRes.status}`);
        return false;
      }
      const compareData = await compareRes.json();
      if (compareData.status !== "ahead" && compareData.status !== "identical") {
        console.error(`[submit-evidence] Base ${expectedBaseCommitSha.slice(0, 7)} is not an ancestor of ${commitSha.slice(0, 7)}`);
        return false;
      }
    }

    return true;
  } catch (err: any) {
    console.error(`[submit-evidence] Remote verification error: ${err.message}`);
    return false;
  }
}
