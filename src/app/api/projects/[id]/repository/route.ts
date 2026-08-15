import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { getRepositorySnapshot } from "@/lib/repository-reader";

// GET /api/projects/[id]/repository
//
// Phase 17: Returns the ACTUAL Git/GitHub repository state via the canonical
// repository read adapter. Does NOT read the legacy DB Repo* models.
//
// For GITHUB_BACKED: reads the real GitHub repository (integration branch).
// For LOCAL_ONLY: derives a best-available view from TaskEvidence.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const project = await db.project.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        githubConnected: true,
        githubRepo: true,
        githubDefaultBranch: true,
        canonicalHeadSha: true,
      },
    });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Fetch snapshot WITHOUT content (UI list view — file content fetched on demand
    // via the /repository/files route when a user opens a file).
    const snapshot = await getRepositorySnapshot(project, false);

    return NextResponse.json({
      mode: snapshot.mode,
      head: snapshot.head,
      branches: snapshot.branches,
      commits: snapshot.commits,
      files: snapshot.files,
      pullRequests: snapshot.pullRequests,
      unreadable: snapshot.unreadable,
      unreadableReason: snapshot.unreadableReason,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch repository" }, { status: 500 });
  }
}
