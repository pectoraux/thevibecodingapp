import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { parseReadinessCheck } from "../../../_lib";

// GET /api/projects/[id]/verification — list readiness checks + summary counts
//   Returns: { checks, passed, total, passedCount, failedCount }
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const checks = await db.readinessCheck.findMany({
      where: { projectId: id },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
    const parsed = checks.map(parseReadinessCheck);
    const total = parsed.length;
    const passedCount = parsed.filter((c) => c.status === "PASSED").length;
    const failedCount = parsed.filter((c) => c.status === "FAILED").length;
    return NextResponse.json({
      checks: parsed,
      passed: failedCount === 0 && total > 0,
      total,
      passedCount,
      failedCount,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch verification" }, { status: 500 });
  }
}
