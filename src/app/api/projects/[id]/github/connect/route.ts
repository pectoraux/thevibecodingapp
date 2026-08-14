import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { initRepository } from "@/lib/repo";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType } from "@/lib/types";
import { readJsonBody } from "../../../../_lib";

// POST /api/projects/[id]/github/connect
//   Body: { repoName }
//   Side effect: sets githubConnected=true, githubRepo=repoName, calls initRepository
//   if repo not yet initialized.
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

    await ensureBuildEvent({
      projectId: id,
      type: BuildEventType.GITHUB_CONNECTED,
      level: "success",
      message: `Connected GitHub repository: ${repoName}`,
      payload: JSON.stringify({ repoName }),
    });

    return NextResponse.json({ project });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to connect GitHub" }, { status: 500 });
  }
}
