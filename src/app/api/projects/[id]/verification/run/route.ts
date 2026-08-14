import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { runReadinessGate } from "@/lib/readiness";

// POST /api/projects/[id]/verification/run — run the 12-category readiness gate
//   Returns: { result: { passed, total, passedCount, failedCount, results: any[] } }
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const result = await runReadinessGate(id);
    return NextResponse.json({ result });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to run readiness gate" }, { status: 500 });
  }
}
