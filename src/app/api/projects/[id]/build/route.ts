import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { startBuild } from "@/lib/orchestrator";

// POST /api/projects/[id]/build
//   Runs the full autonomous build loop. May take 1–5 minutes.
//   Frontend shows a loading spinner; we await completion and return the updated project.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await startBuild(id);
    const project = await db.project.findUnique({ where: { id } });
    return NextResponse.json({ project });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Build failed" }, { status: 500 });
  }
}
