import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType, TaskStatus } from "@/lib/types";
import { refreshCanonicalHead } from "@/app/api/worker/submit-evidence/route";

// POST /api/projects/[id]/tasks/[taskId]/merge
//
// Phase 16B: Merge a task's PR into the canonical integration branch.
// Task execution state (status) remains COMPLETED — only integrationState changes.
//
// Only project owner can merge. Requires:
//   - task.status === COMPLETED (execution verified)
//   - task.integrationState === INTEGRATION_PENDING
//   - task.prNumber exists
//   - task.projectId === project ID from URL (binding check)
//   - PR head SHA matches task.commitSha
//   - PR base matches project.githubDefaultBranch
//   - Stale base detection (canonical HEAD may have moved)
//   - GitHub CI checks pass (if configured)
export async function POST(req: Request, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id, taskId } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // P16B: Load task with project binding — task must belong to this project.
    const task = await db.task.findFirst({
      where: { id: taskId, projectId: id },
    });
    if (!task) {
      return NextResponse.json({ error: "Task not found in this project" }, { status: 404 });
    }

    // P16B: Verify task is COMPLETED (execution state) and INTEGRATION_PENDING (integration state).
    if (task.status !== TaskStatus.COMPLETED) {
      return NextResponse.json({ error: `Task must be COMPLETED (current: ${task.status})` }, { status: 400 });
    }
    if (task.integrationState !== "INTEGRATION_PENDING") {
      return NextResponse.json({ error: `Task must be INTEGRATION_PENDING (current: ${task.integrationState})` }, { status: 400 });
    }
    if (!task.prNumber) {
      return NextResponse.json({ error: "No PR number — cannot merge" }, { status: 400 });
    }

    const githubPat = process.env.GITHUB_PAT;
    if (!githubPat) {
      return NextResponse.json({ error: "No GitHub credential configured" }, { status: 500 });
    }

    const [owner, repo] = project.githubRepo!.split("/");
    const headers = {
      "Authorization": `token ${githubPat}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "Forge-Control-Plane",
    };

    // 1. Query the PR from GitHub.
    const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${task.prNumber}`, {
      headers, signal: AbortSignal.timeout(10000),
    });
    if (!prRes.ok) {
      return NextResponse.json({ error: `PR not found: HTTP ${prRes.status}` }, { status: 404 });
    }
    const prData = await prRes.json();

    // 2. Verify PR head SHA matches task commitSha.
    if (prData.head?.sha !== task.commitSha) {
      return NextResponse.json({
        error: `PR head SHA mismatch: expected ${task.commitSha?.slice(0, 7)}, got ${prData.head?.sha?.slice(0, 7)}`,
      }, { status: 400 });
    }

    // 3. Verify PR base matches project's integration branch.
    if (prData.base?.ref !== project.githubDefaultBranch) {
      return NextResponse.json({
        error: `PR base mismatch: expected ${project.githubDefaultBranch}, got ${prData.base?.ref}`,
      }, { status: 400 });
    }

    // 4. P16A: Stale base detection.
    const currentCanonicalHead = project.canonicalHeadSha;
    const prBaseSha = prData.base?.sha;
    if (currentCanonicalHead && prBaseSha && currentCanonicalHead !== prBaseSha) {
      await db.task.update({
        where: { id: taskId },
        data: {
          integrationState: "INTEGRATION_FAILED",
          failureReason: `STALE_BASE: canonical HEAD is ${currentCanonicalHead.slice(0, 7)} but PR base is ${prBaseSha.slice(0, 7)}`,
        },
      });
      await db.project.update({
        where: { id },
        data: { status: "HUMAN_REVIEW_REQUIRED" },
      });
      return NextResponse.json({
        error: `STALE_BASE: canonical HEAD (${currentCanonicalHead.slice(0, 7)}) != PR base (${prBaseSha.slice(0, 7)}). Rebase required.`,
      }, { status: 409 });
    }

    // 5. P16B: Check GitHub CI status (check runs for the PR head commit).
    const checksRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${task.commitSha}/check-runs`, {
      headers, signal: AbortSignal.timeout(10000),
    });
    if (checksRes.ok) {
      const checksData = await checksRes.json();
      const checkRuns = checksData.check_runs || [];
      // Check if any required checks have failed or are still pending.
      const failedChecks = checkRuns.filter((cr: any) => cr.conclusion === "failure");
      const pendingChecks = checkRuns.filter((cr: any) => cr.status !== "completed");

      if (failedChecks.length > 0) {
        await db.task.update({
          where: { id: taskId },
          data: {
            integrationState: "INTEGRATION_FAILED",
            failureReason: `CI_FAILED: ${failedChecks.length} check(s) failed`,
          },
        });
        return NextResponse.json({
          error: `CI_FAILED: ${failedChecks.length} check(s) failed. Merge blocked.`,
        }, { status: 422 });
      }

      if (pendingChecks.length > 0) {
        return NextResponse.json({
          error: `CI_PENDING: ${pendingChecks.length} check(s) still running. Merge blocked.`,
        }, { status: 409 });
      }
    }

    // 6. Merge the PR via GitHub API.
    const mergeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${task.prNumber}/merge`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        commit_title: `[${task.code}] ${task.title}`,
        merge_method: "squash",
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!mergeRes.ok) {
      const mergeErr = await mergeRes.text();
      await db.task.update({
        where: { id: taskId },
        data: {
          integrationState: "INTEGRATION_FAILED",
          failureReason: `GitHub merge failed: HTTP ${mergeRes.status}: ${mergeErr}`,
        },
      });
      return NextResponse.json({
        error: `Merge failed: HTTP ${mergeRes.status}: ${mergeErr}`,
      }, { status: 500 });
    }

    // 7. P16B: Refresh canonicalHeadSha from actual GitHub branch HEAD.
    // Must succeed before marking INTEGRATED.
    const newCanonicalHead = await refreshCanonicalHead(id);

    if (!newCanonicalHead) {
      // P16B: PR merged but canonical HEAD refresh failed.
      // Do NOT mark as INTEGRATED — use CANONICAL_HEAD_UNVERIFIED.
      await db.task.update({
        where: { id: taskId },
        data: {
          integrationState: "CANONICAL_HEAD_UNVERIFIED",
          prState: "MERGED",
          failureReason: "PR merged but canonical HEAD refresh failed — manual verification required",
        },
      });
      await db.project.update({
        where: { id },
        data: { status: "HUMAN_REVIEW_REQUIRED" },
      });
      return NextResponse.json({
        ok: true,
        integrated: false,
        warning: "PR merged but canonical HEAD could not be verified. Manual review required.",
        prNumber: task.prNumber,
      });
    }

    // 8. P16B: Mark task as INTEGRATED — status remains COMPLETED.
    await db.task.update({
      where: { id: taskId },
      data: {
        // P16B: status STAYS COMPLETED — only integrationState changes.
        integrationState: "INTEGRATED",
        prState: "MERGED",
      },
    });

    await ensureBuildEvent({
      projectId: id,
      type: BuildEventType.TASK_COMPLETED,
      level: "success",
      message: `Task ${task.code} INTEGRATED — PR #${task.prNumber} merged, canonical HEAD: ${newCanonicalHead.slice(0, 7)}`,
      taskId,
      agentType: task.agentType,
    });

    return NextResponse.json({
      ok: true,
      integrated: true,
      prNumber: task.prNumber,
      canonicalHeadSha: newCanonicalHead,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
