import { NextResponse } from "next/server";
import { runPreflight } from "@/lib/readiness";

// POST /api/projects/[id]/preflight — checks every required credential is configured.
// Returns: { preflight: { passed, total, configured, missing: [{name, purpose, whenRequired}] } }
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const preflight = await runPreflight(id);
    return NextResponse.json({ preflight });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to run preflight" }, { status: 500 });
  }
}
