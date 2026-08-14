import { NextResponse } from "next/server";
import { runArchitect } from "@/lib/orchestrator";
import { parseArchitecture } from "../../../../_lib";

// POST /api/projects/[id]/architecture/generate — long-running; runs the Architect agent.
// Sets project to AWAITING_ARCHITECTURE_APPROVAL on success. May take 10–30s.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const architecture = await runArchitect(id);
    return NextResponse.json({ architecture: parseArchitecture(architecture) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to generate architecture" }, { status: 500 });
  }
}
