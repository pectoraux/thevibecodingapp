import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";

// POST /api/worker/resolve-github-credential
//
// Phase 12: Per-project GitHub authorization.
// Verifies that:
//   1. The worker is authenticated (execution token)
//   2. The execution belongs to the claimed project
//   3. The project is GitHub-connected
//   4. The requesting execution's project matches the requested projectId
//
// Returns a scoped GitHub token for the specific project's repository.
// The token is NEVER sent to the LLM or browser.
// After clone/push, the worker removes the credential from .git/config.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req);
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    if (!token.executionId) {
      return NextResponse.json({ error: "Execution token required" }, { status: 403 });
    }

    const { projectId } = await req.json();

    if (!projectId) {
      return NextResponse.json({ error: "projectId required" }, { status: 400 });
    }

    // Verify the execution job belongs to this project.
    const job = await db.executionJob.findUnique({
      where: { executionId: token.executionId },
      select: { projectId: true },
    });

    if (!job || job.projectId !== projectId) {
      return NextResponse.json({ error: "Execution does not belong to this project" }, { status: 403 });
    }

    // Verify the project is GitHub-connected.
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { githubConnected: true, githubRepo: true, userId: true },
    });

    if (!project || !project.githubConnected || !project.githubRepo) {
      return NextResponse.json({ error: "Project is not GitHub-connected" }, { status: 404 });
    }

    // P12: Per-project credential resolution.
    // In production, this would use GitHub App installation tokens or
    // user-scoped OAuth tokens stored in the secret store.
    // For now, we use the platform GITHUB_PAT but verify project ownership.
    const githubPat = process.env.GITHUB_PAT;

    if (!githubPat) {
      // P12: No anonymous fallback — BLOCKED.
      return NextResponse.json(
        { error: "BLOCKED: No GitHub credential configured for this project" },
        { status: 403 }
      );
    }

    return NextResponse.json({
      token: githubPat,
      repo: project.githubRepo,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
