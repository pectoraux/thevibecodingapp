import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { runPreflight } from "@/lib/readiness";

// POST /api/projects/[id]/preflight — checks every required credential is configured.
// Returns: { preflight: { passed, total, configured, missing: [{name, purpose, whenRequired}] } }
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const preflight = await runPreflight(id);
    return NextResponse.json({ preflight });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to run preflight" }, { status: 500 });
  }
}
