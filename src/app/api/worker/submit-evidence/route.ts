import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { recordEvidence } from "@/lib/evidence";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType, TaskStatus } from "@/lib/types";
import { canCompleteTask, getFailureReason, type TaskEvidence, type ProjectMode } from "@/lib/completion-policy";

// POST /api/worker/submit-evidence
//
// Phase 15: Uses the ONE canonical canCompleteTask() function.
// For GITHUB_BACKED: independently verifies remote commit via GitHub API.
// The worker's claim is NOT sufficient — the control plane verifies.
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
    const { taskId, projectId, commitSha, pushedToRemote, testResults, guardianResult, reviewResult, filesChanged, implementationLog } = body;

    // Get the task.
    const task = await db.task.findUnique({ where: { id: taskId } });
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // Get the project to determine mode.
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const mode: ProjectMode = project.githubConnected && project.githubRepo ? "GITHUB_BACKED" : "LOCAL_ONLY";

    // P15: Remote commit verification for GitHub-backed projects.
    let remoteCommitVerified = false;
    if (mode === "GITHUB_BACKED" && commitSha && pushedToRemote) {
      try {
        remoteCommitVerified = await verifyRemoteCommit(project.githubRepo!, commitSha, task.code);
      } catch (err: any) {
        console.error(`[submit-evidence] Remote verification failed: ${err.message}`);
        remoteCommitVerified = false;
      }
    } else if (mode === "LOCAL_ONLY") {
      // Local-only: no remote to verify.
      remoteCommitVerified = true;
    }

    // P15: Build the canonical evidence object.
    const testsPassed = Array.isArray(testResults) && testResults.length > 0 && testResults.every((t: any) => t.passes);

    // Record immutable evidence FIRST — completion requires evidence persisted.
    const architecture = await db.architecture.findUnique({ where: { projectId } });
    let evidencePersisted = false;
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
      evidencePersisted = true;
    } catch (err: any) {
      // Evidence recording failure blocks completion.
    }

    const evidence: TaskEvidence = {
      commitSha: commitSha || null,
      pushedToRemote: pushedToRemote || false,
      remoteCommitVerified,
      baseCommitSha: null, // Resolved from task graph
      guardianVerdict: guardianResult?.verdict || "UNVERIFIED",
      reviewVerdict: reviewResult?.verdict || "REJECTED",
      testsPassed,
      evidencePersisted,
    };

    // P15: ONE canonical completion predicate.
    const canComplete = canCompleteTask(evidence, mode);
    const failureReason = canComplete ? null : getFailureReason(evidence, mode);

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
        failureReason,
      },
    });

    // Emit build event.
    await ensureBuildEvent({
      projectId,
      type: canComplete ? BuildEventType.TASK_COMPLETED : BuildEventType.TASK_FAILED,
      level: canComplete ? "success" : "error",
      message: `Task ${task.code} ${canComplete ? "COMPLETED" : "FAILED"} by worker ${token.workerId} (commit: ${commitSha?.slice(0, 7) || "none"}, push: ${pushedToRemote ? "ok" : "fail"}, remote: ${remoteCommitVerified ? "verified" : "unverified"})`,
      taskId,
      agentType: task.agentType,
    });

    return NextResponse.json({ ok: true, success: canComplete, taskStatus: canComplete ? "COMPLETED" : "FAILED", failureReason });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// P15: Independently verify the remote commit via GitHub API.
async function verifyRemoteCommit(githubRepo: string, commitSha: string, taskCode: string): Promise<boolean> {
  const githubPat = process.env.GITHUB_PAT;
  if (!githubPat) {
    console.error("[submit-evidence] No GITHUB_PAT for remote verification");
    return false;
  }

  const [owner, repo] = githubRepo.split("/");

  try {
    // Verify the commit exists in the repository.
    const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}`, {
      headers: {
        "Authorization": `token ${githubPat}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "Forge-Control-Plane",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!commitRes.ok) {
      console.error(`[submit-evidence] GitHub commit verification failed: HTTP ${commitRes.status}`);
      return false;
    }

    // Verify the branch exists and points to this commit.
    const branchName = `forge/${taskCode.toLowerCase()}/attempt-1`;
    const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${branchName}`, {
      headers: {
        "Authorization": `token ${githubPat}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "Forge-Control-Plane",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (branchRes.ok) {
      const branchData = await branchRes.json();
      if (branchData.commit?.sha !== commitSha) {
        console.error(`[submit-evidence] Branch HEAD mismatch: expected ${commitSha.slice(0, 7)}, got ${branchData.commit?.sha?.slice(0, 7)}`);
        return false;
      }
    }

    // Commit exists and branch matches (or branch not found, which is OK if we just verify commit existence).
    return true;
  } catch (err: any) {
    console.error(`[submit-evidence] Remote verification error: ${err.message}`);
    return false;
  }
}
