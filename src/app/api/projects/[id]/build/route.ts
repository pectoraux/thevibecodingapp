import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { startBuild } from "@/lib/orchestrator";

// POST /api/projects/[id]/build
//   Runs the full autonomous build loop. May take 1–5 minutes.
//   Frontend shows a loading spinner; we await completion and return the updated project.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    await startBuild(id);
    const updated = await db.project.findUnique({ where: { id } });
    return NextResponse.json({ project: updated });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Build failed" }, { status: 500 });
  }
}
