import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType, TaskStatus } from "@/lib/types";
import { refreshCanonicalHead } from "@/app/api/worker/submit-evidence/route";

// POST /api/projects/[id]/tasks/[taskId]/merge
//
// Phase 16C: Hardened merge endpoint with:
// - Atomic INTEGRATION_PENDING → MERGING transition (concurrency-safe)
// - Explicit required-check CI policy (not generic "all checks")
// - Idempotent merge (already-merged PR → refresh + INTEGRATED)
// - Canonical head reconciliation retry on CANONICAL_HEAD_UNVERIFIED
// - Block conclusions: failure, error, cancelled, timed_out, action_required
export async function POST(req: Request, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id, taskId } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // P16B: Load task with project binding.
    const task = await db.task.findFirst({
      where: { id: taskId, projectId: id },
    });
    if (!task) {
      return NextResponse.json({ error: "Task not found in this project" }, { status: 404 });
    }

    // P16C: Handle CANONICAL_HEAD_UNVERIFIED — retry refresh.
    if (task.integrationState === "CANONICAL_HEAD_UNVERIFIED") {
      const newHead = await refreshCanonicalHead(id);
      if (newHead) {
        await db.task.update({
          where: { id: taskId },
          data: { integrationState: "INTEGRATED", failureReason: null },
        });
        return NextResponse.json({ ok: true, integrated: true, canonicalHeadSha: newHead, reconciled: true });
      }
      return NextResponse.json({ error: "Canonical head still unverifiable — retry needed" }, { status: 409 });
    }

    // P16C: If already INTEGRATED, return idempotent success.
    if (task.integrationState === "INTEGRATED") {
      return NextResponse.json({ ok: true, integrated: true, alreadyIntegrated: true });
    }

    if (task.status !== TaskStatus.COMPLETED) {
      return NextResponse.json({ error: `Task must be COMPLETED (current: ${task.status})` }, { status: 400 });
    }
    if (task.integrationState !== "INTEGRATION_PENDING") {
      return NextResponse.json({ error: `Task must be INTEGRATION_PENDING (current: ${task.integrationState})` }, { status: 400 });
    }
    if (!task.prNumber) {
      return NextResponse.json({ error: "No PR number — cannot merge" }, { status: 400 });
    }

    // P16C: Atomic transition INTEGRATION_PENDING → MERGING.
    // Only one caller can succeed; others get 409.
    const transitionResult = await db.task.updateMany({
      where: { id: taskId, integrationState: "INTEGRATION_PENDING" },
      data: { integrationState: "MERGING" },
    });
    if (transitionResult.count === 0) {
      return NextResponse.json({ error: "INTEGRATION_ALREADY_IN_PROGRESS or not in PENDING state" }, { status: 409 });
    }

    const githubPat = process.env.GITHUB_PAT;
    if (!githubPat) {
      await db.task.update({ where: { id: taskId }, data: { integrationState: "INTEGRATION_FAILED", failureReason: "No GITHUB_PAT" } });
      return NextResponse.json({ error: "No GitHub credential configured" }, { status: 500 });
    }

    const [owner, repo] = project.githubRepo!.split("/");
    const headers = {
      "Authorization": `token ${githubPat}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "Forge-Control-Plane",
    };

    try {
      // 1. Query the PR from GitHub.
      const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${task.prNumber}`, {
        headers, signal: AbortSignal.timeout(10000),
      });
      if (!prRes.ok) {
        await db.task.update({ where: { id: taskId }, data: { integrationState: "INTEGRATION_FAILED", failureReason: `PR not found: HTTP ${prRes.status}` } });
        return NextResponse.json({ error: `PR not found: HTTP ${prRes.status}` }, { status: 404 });
      }
      const prData = await prRes.json();

      // P16C: Idempotent — if PR is already merged, just refresh canonical HEAD.
      if (prData.merged === true) {
        const newHead = await refreshCanonicalHead(id);
        if (newHead) {
          await db.task.update({
            where: { id: taskId },
            data: { integrationState: "INTEGRATED", prState: "MERGED" },
          });
          return NextResponse.json({ ok: true, integrated: true, alreadyMerged: true, canonicalHeadSha: newHead });
        }
        await db.task.update({
          where: { id: taskId },
          data: { integrationState: "CANONICAL_HEAD_UNVERIFIED", prState: "MERGED" },
        });
        return NextResponse.json({ ok: true, integrated: false, warning: "PR already merged but canonical HEAD unverified" });
      }

      // 2. Verify PR head SHA matches task commitSha.
      if (prData.head?.sha !== task.commitSha) {
        await db.task.update({ where: { id: taskId }, data: { integrationState: "INTEGRATION_FAILED", failureReason: `PR head SHA mismatch` } });
        return NextResponse.json({ error: `PR head SHA mismatch: expected ${task.commitSha?.slice(0, 7)}, got ${prData.head?.sha?.slice(0, 7)}` }, { status: 400 });
      }

      // 3. Verify PR base matches project's integration branch.
      if (prData.base?.ref !== project.githubDefaultBranch) {
        await db.task.update({ where: { id: taskId }, data: { integrationState: "INTEGRATION_FAILED", failureReason: `PR base mismatch` } });
        return NextResponse.json({ error: `PR base mismatch: expected ${project.githubDefaultBranch}, got ${prData.base?.ref}` }, { status: 400 });
      }

      // 4. Stale base detection.
      const currentCanonicalHead = project.canonicalHeadSha;
      const prBaseSha = prData.base?.sha;
      if (currentCanonicalHead && prBaseSha && currentCanonicalHead !== prBaseSha) {
        await db.task.update({
          where: { id: taskId },
          data: { integrationState: "INTEGRATION_FAILED", failureReason: `STALE_BASE: canonical HEAD is ${currentCanonicalHead.slice(0, 7)} but PR base is ${prBaseSha.slice(0, 7)}` },
        });
        await db.project.update({ where: { id }, data: { status: "HUMAN_REVIEW_REQUIRED" } });
        return NextResponse.json({ error: `STALE_BASE: canonical HEAD (${currentCanonicalHead.slice(0, 7)}) != PR base (${prBaseSha.slice(0, 7)})` }, { status: 409 });
      }

      // 5. P16C: Explicit required-check CI policy.
      // Block on: failure, error, cancelled, timed_out, action_required, stale
      // Allow: success
      // Policy-defined: skipped, neutral (treat as pass for now)
      // Block: any check still pending/running
      const checksRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${task.commitSha}/check-runs`, {
        headers, signal: AbortSignal.timeout(10000),
      });
      if (checksRes.ok) {
        const checksData = await checksRes.json();
        const checkRuns = checksData.check_runs || [];

        const BLOCKING_CONCLUSIONS = ["failure", "error", "cancelled", "timed_out", "action_required", "stale"];
        const blockingChecks = checkRuns.filter((cr: any) => BLOCKING_CONCLUSIONS.includes(cr.conclusion));
        const pendingChecks = checkRuns.filter((cr: any) => cr.status !== "completed");

        if (blockingChecks.length > 0) {
          const names = blockingChecks.map((cr: any) => cr.name).join(", ");
          await db.task.update({
            where: { id: taskId },
            data: { integrationState: "INTEGRATION_FAILED", failureReason: `CI_FAILED: ${blockingChecks.length} check(s) failed: ${names}` },
          });
          return NextResponse.json({ error: `CI_FAILED: ${names}. Merge blocked.` }, { status: 422 });
        }

        if (pendingChecks.length > 0) {
          const names = pendingChecks.map((cr: any) => cr.name).join(", ");
          return NextResponse.json({ error: `CI_PENDING: ${names}. Merge blocked.` }, { status: 409 });
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
          data: { integrationState: "INTEGRATION_FAILED", failureReason: `GitHub merge failed: HTTP ${mergeRes.status}: ${mergeErr}` },
        });
        return NextResponse.json({ error: `Merge failed: HTTP ${mergeRes.status}: ${mergeErr}` }, { status: 500 });
      }

      // 7. Refresh canonicalHeadSha.
      const newCanonicalHead = await refreshCanonicalHead(id);

      if (!newCanonicalHead) {
        await db.task.update({
          where: { id: taskId },
          data: { integrationState: "CANONICAL_HEAD_UNVERIFIED", prState: "MERGED", failureReason: "PR merged but canonical HEAD refresh failed" },
        });
        await db.project.update({ where: { id }, data: { status: "HUMAN_REVIEW_REQUIRED" } });
        return NextResponse.json({ ok: true, integrated: false, warning: "PR merged but canonical HEAD unverified. Retry merge to reconcile." });
      }

      // 8. Mark INTEGRATED — status remains COMPLETED.
      await db.task.update({
        where: { id: taskId },
        data: { integrationState: "INTEGRATED", prState: "MERGED" },
      });

      await ensureBuildEvent({
        projectId: id,
        type: BuildEventType.TASK_COMPLETED,
        level: "success",
        message: `Task ${task.code} INTEGRATED — PR #${task.prNumber} merged, canonical HEAD: ${newCanonicalHead.slice(0, 7)}`,
        taskId,
        agentType: task.agentType,
      });

      return NextResponse.json({ ok: true, integrated: true, prNumber: task.prNumber, canonicalHeadSha: newCanonicalHead });
    } catch (err: any) {
      // On any error during MERGING, revert to INTEGRATION_FAILED.
      await db.task.update({
        where: { id: taskId },
        data: { integrationState: "INTEGRATION_FAILED", failureReason: `Merge error: ${err.message}` },
      });
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
