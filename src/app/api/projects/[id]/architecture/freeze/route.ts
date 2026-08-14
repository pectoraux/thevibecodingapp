import { NextResponse } from "next/server";
import { freezeArchitecture } from "@/lib/orchestrator";
import { parseArchitecture } from "../../../../_lib";

// POST /api/projects/[id]/architecture/freeze — locks the architecture; sets status ARCHITECTURE_FROZEN
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const architecture = await freezeArchitecture(id);
    return NextResponse.json({ architecture: parseArchitecture(architecture) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to freeze architecture" }, { status: 500 });
  }
}
