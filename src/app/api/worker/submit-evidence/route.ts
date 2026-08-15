import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { recordEvidence } from "@/lib/evidence";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType, TaskStatus } from "@/lib/types";
import { canCompleteTask, getFailureReason, type TaskEvidence, type ProjectMode } from "@/lib/completion-policy";

// POST /api/worker/submit-evidence
//
// Phase 15A: Hardened evidence authorization and remote verification.
//
// SECURITY: The worker is NEVER authoritative about taskId/projectId.
// The control plane derives task/project from the authenticated execution token.
// The worker submits execution evidence; the control plane decides completion.
//
// REMOTE VERIFICATION: For GITHUB_BACKED, the control plane independently verifies:
//   - commit exists in repository
//   - expected branch exists
//   - branch HEAD == commitSha
//   - baseCommitSha is ancestor of commitSha
// The worker's claims are NOT trusted.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req);
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    if (!token.executionId) {
      return NextResponse.json({ error: "Execution token required" }, { status: 403 });
    }

    // P15A: Derive task/project from the EXECUTION TOKEN, not the request body.
    // The worker is not authoritative for identity.
    const executionJob = await db.executionJob.findUnique({
      where: { executionId: token.executionId },
      select: { id: true, taskId: true, projectId: true, workerId: true, attempt: true },
    });

    if (!executionJob) {
      return NextResponse.json({ error: "Execution job not found for token" }, { status: 403 });
    }

    // Verify the worker matches.
    if (executionJob.workerId !== token.workerId) {
      return NextResponse.json({ error: "Worker does not own this execution" }, { status: 403 });
    }

    const taskId = executionJob.taskId;
    const projectId = executionJob.projectId;

    // Get the task and project from the DERIVED IDs.
    const task = await db.task.findUnique({ where: { id: taskId! } });
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const mode: ProjectMode = project.githubConnected && project.githubRepo ? "GITHUB_BACKED" : "LOCAL_ONLY";

    // Accept execution evidence from the body — but NOT taskId/projectId.
    const body = await req.json();
    const { commitSha, pushedToRemote, branchName, baseCommitSha, testResults, guardianResult, reviewResult, filesChanged, implementationLog } = body;

    // P15A: Remote commit verification for GitHub-backed projects.
    // FAIL CLOSED: branch must exist, HEAD must match, ancestry must be verified.
    let remoteCommitVerified = false;
    if (mode === "GITHUB_BACKED" && commitSha && pushedToRemote && branchName) {
      try {
        remoteCommitVerified = await verifyRemoteCommit(
          project.githubRepo!,
          commitSha,
          branchName,
          baseCommitSha || null
        );
      } catch (err: any) {
        console.error(`[submit-evidence] Remote verification failed: ${err.message}`);
        remoteCommitVerified = false;
      }
    } else if (mode === "LOCAL_ONLY") {
      remoteCommitVerified = true;
    }

    // Build the canonical evidence object.
    const testsPassed = Array.isArray(testResults) && testResults.length > 0 && testResults.every((t: any) => t.passes);

    // Record immutable evidence FIRST.
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
      });
      evidencePersisted = true;
    } catch {
      // Evidence recording failure blocks completion.
    }

    const evidence: TaskEvidence = {
      commitSha: commitSha || null,
      pushedToRemote: pushedToRemote || false,
      remoteCommitVerified,
      baseCommitSha: baseCommitSha || null,
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
      message: `Task ${task.code} ${canComplete ? "COMPLETED" : "FAILED"} by worker ${token.workerId} (commit: ${commitSha?.slice(0, 7) || "none"}, push: ${pushedToRemote ? "ok" : "fail"}, remote: ${remoteCommitVerified ? "verified" : "unverified"})`,
      taskId: taskId!,
      agentType: task.agentType,
    });

    return NextResponse.json({ ok: true, success: canComplete, taskStatus: canComplete ? "COMPLETED" : "FAILED", failureReason });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// P15A: Independently verify remote commit via GitHub API.
// FAIL CLOSED: all checks must pass. Missing branch = FAIL (not pass-through).
async function verifyRemoteCommit(
  githubRepo: string,
  commitSha: string,
  branchName: string,
  baseCommitSha: string | null
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
    // 1. Verify the commit exists in the repository.
    const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!commitRes.ok) {
      console.error(`[submit-evidence] Commit not found: HTTP ${commitRes.status}`);
      return false;
    }

    // 2. Verify the EXACT branch exists (not hardcoded — from evidence).
    const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branchName)}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!branchRes.ok) {
      console.error(`[submit-evidence] Branch not found: ${branchName} (HTTP ${branchRes.status})`);
      return false; // P15A: Missing branch = FAIL, not pass-through.
    }

    // 3. Verify branch HEAD matches the expected commit.
    const branchData = await branchRes.json();
    if (branchData.commit?.sha !== commitSha) {
      console.error(`[submit-evidence] Branch HEAD mismatch: expected ${commitSha.slice(0, 7)}, got ${branchData.commit?.sha?.slice(0, 7)}`);
      return false;
    }

    // 4. Verify base commit ancestry (if baseCommitSha provided).
    if (baseCommitSha) {
      const compareRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/compare/${baseCommitSha}...${commitSha}`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!compareRes.ok) {
        console.error(`[submit-evidence] Ancestry check failed: HTTP ${compareRes.status}`);
        return false;
      }
      const compareData = await compareRes.json();
      // The compare API returns status "ahead" if baseCommitSha is an ancestor of commitSha.
      if (compareData.status !== "ahead" && compareData.status !== "identical") {
        console.error(`[submit-evidence] Base ${baseCommitSha.slice(0, 7)} is not an ancestor of ${commitSha.slice(0, 7)} (status: ${compareData.status})`);
        return false;
      }
    }

    return true;
  } catch (err: any) {
    console.error(`[submit-evidence] Remote verification error: ${err.message}`);
    return false;
  }
}
