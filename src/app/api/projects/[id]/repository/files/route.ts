import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { getFileContent } from "@/lib/repository-reader";

// GET /api/projects/[id]/repository/files?path=...
//
// Phase 17: Returns a single file's content from the CANONICAL repository source
// (real GitHub for GITHUB_BACKED; evidence-derived for LOCAL_ONLY).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
    const url = new URL(req.url);
    const path = url.searchParams.get("path");
    if (!path) {
      return NextResponse.json({ error: "Missing query parameter: path" }, { status: 400 });
    }
    const file = await getFileContent(project, path);
    if (!file) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    return NextResponse.json({ file });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch file" }, { status: 500 });
  }
}
