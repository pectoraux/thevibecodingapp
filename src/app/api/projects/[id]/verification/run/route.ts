import { NextResponse } from "next/server";
import { runReadinessGate } from "@/lib/readiness";

// POST /api/projects/[id]/verification/run — run the 12-category readiness gate
//   Returns: { result: { passed, total, passedCount, failedCount, results: any[] } }
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await runReadinessGate(id);
    return NextResponse.json({ result });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to run readiness gate" }, { status: 500 });
  }
}
