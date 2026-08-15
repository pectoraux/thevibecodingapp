import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType, TaskStatus } from "@/lib/types";
import { refreshCanonicalHead } from "@/app/api/worker/submit-evidence/route";

// POST /api/projects/[id]/tasks/[taskId]/merge
//
// Phase 16A: Merge a task's PR into the canonical integration branch.
// Only project owner can merge. Requires:
//   - task.status === COMPLETED
//   - task.integrationState === INTEGRATION_PENDING
//   - task.prNumber exists
//   - PR head SHA matches task.commitSha
//   - PR base matches project.githubDefaultBranch
//   - Stale base detection (canonical HEAD may have moved)
export async function POST(req: Request, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id, taskId } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const task = await db.task.findUnique({ where: { id: taskId } });
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // P16A: Verify task is COMPLETED and INTEGRATION_PENDING.
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
    // If canonicalHeadSha has moved since the PR was created, the PR may be stale.
    const currentCanonicalHead = project.canonicalHeadSha;
    const prBaseSha = prData.base?.sha;
    if (currentCanonicalHead && prBaseSha && currentCanonicalHead !== prBaseSha) {
      // The canonical HEAD has moved since this PR was created.
      // The PR is based on a stale commit.
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

    // 5. Merge the PR via GitHub API.
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

    // 6. Refresh canonicalHeadSha from actual GitHub branch HEAD.
    const newCanonicalHead = await refreshCanonicalHead(id);

    // 7. Mark task as INTEGRATED.
    await db.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.INTEGRATED,
        integrationState: "INTEGRATED",
        prState: "MERGED",
      },
    });

    await ensureBuildEvent({
      projectId: id,
      type: BuildEventType.TASK_COMPLETED,
      level: "success",
      message: `Task ${task.code} INTEGRATED — PR #${task.prNumber} merged, canonical HEAD: ${newCanonicalHead?.slice(0, 7) || "unknown"}`,
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
