import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { startBuild } from "@/lib/orchestrator";
import { enforceProductionMode } from "@/lib/production-enforcement";

// POST /api/projects/[id]/build
//
// Phase 6: This endpoint ENQUEUES a build job and returns immediately.
// The build runs asynchronously via the scheduler/worker.
// The frontend polls /api/projects/[id]/build/status for progress.
//
// In production, this endpoint enforces the execution mode policy:
// if FORGE_EXECUTION_MODE != sandbox, the build is refused.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Phase 6: Enforce production execution mode.
    // In production, LOCAL_UNSANDBOXED is forbidden — builds cannot start.
    const enforcement = enforceProductionMode();
    if (!enforcement.allowed) {
      return NextResponse.json(
        { error: `Build refused: ${enforcement.reason}` },
        { status: 403 }
      );
    }

    // Phase 6: Enqueue the build job and return immediately.
    // The actual execution happens asynchronously via the scheduler.
    await startBuild(id);

    const updated = await db.project.findUnique({ where: { id } });
    return NextResponse.json({ project: updated });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Build failed" }, { status: 500 });
  }
}
