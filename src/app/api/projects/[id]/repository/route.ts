import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { listFiles, listCommits, listPullRequests } from "@/lib/repo";
import {
  parseRepoFile,
  parseRepoCommit,
  parsePullRequest,
} from "../../../_lib";

// GET /api/projects/[id]/repository — return branches, commits, files, pull requests
// File shape includes pre-parsed suspiciousPatterns.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const [branches, commits, files, pullRequests] = await Promise.all([
      db.repoBranch.findMany({
        where: { projectId: id },
        orderBy: { createdAt: "asc" },
      }),
      listCommits(id),
      listFiles(id),
      listPullRequests(id),
    ]);
    return NextResponse.json({
      branches,
      commits: commits.map(parseRepoCommit),
      files: files.map(parseRepoFile),
      pullRequests: pullRequests.map(parsePullRequest),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch repository" }, { status: 500 });
  }
}
