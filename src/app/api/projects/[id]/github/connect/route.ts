import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { initRepository } from "@/lib/repo";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType } from "@/lib/types";
import { readJsonBody } from "../../../../_lib";

// POST /api/projects/[id]/github/connect
//
// Phase 16: Initializes canonicalHeadSha from the actual GitHub default branch HEAD.
// For existing repositories, this ensures tasks branch from the real codebase state.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const body = await readJsonBody(req);
    const { repoName } = body || {};
    if (!repoName || typeof repoName !== "string") {
      return NextResponse.json({ error: "Missing required field: repoName" }, { status: 400 });
    }
    const existing = await db.project.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const project = await db.project.update({
      where: { id },
      data: {
        githubConnected: true,
        githubRepo: repoName,
      },
    });

    // If the repo has no commits yet, initialize it.
    const commitCount = await db.repoCommit.count({ where: { projectId: id } });
    if (commitCount === 0) {
      try {
        await initRepository(id, repoName);
      } catch (initErr: any) {
        console.error("[initRepository] failed:", initErr);
      }
    }

    // P16: Initialize canonicalHeadSha from the actual GitHub default branch HEAD.
    let canonicalHeadSha = existing.canonicalHeadSha;
    try {
      const githubPat = process.env.GITHUB_PAT;
      if (githubPat) {
        const [owner, repo] = repoName.split("/");
        const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${project.githubDefaultBranch}`, {
          headers: {
            "Authorization": `token ${githubPat}`,
            "Accept": "application/vnd.github+json",
            "User-Agent": "Forge-Control-Plane",
          },
          signal: AbortSignal.timeout(10000),
        });
        if (branchRes.ok) {
          const branchData = await branchRes.json();
          canonicalHeadSha = branchData.commit?.sha || null;
          if (canonicalHeadSha) {
            await db.project.update({
              where: { id },
              data: { canonicalHeadSha },
            });
          }
        }
      }
    } catch (err: any) {
      console.error("[github/connect] canonicalHeadSha initialization failed:", err.message);
    }

    await ensureBuildEvent({
      projectId: id,
      type: BuildEventType.GITHUB_CONNECTED,
      level: "success",
      message: `Connected GitHub repository: ${repoName}${canonicalHeadSha ? ` (canonical HEAD: ${canonicalHeadSha.slice(0, 7)})` : ""}`,
      payload: JSON.stringify({ repoName, canonicalHeadSha }),
    });

    return NextResponse.json({ project });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to connect GitHub" }, { status: 500 });
  }
}
