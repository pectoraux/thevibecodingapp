import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { freezeArchitecture } from "@/lib/orchestrator";
import { parseArchitecture } from "../../../../_lib";

// POST /api/projects/[id]/architecture/freeze — locks the architecture; sets status ARCHITECTURE_FROZEN
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const architecture = await freezeArchitecture(id);
    return NextResponse.json({ architecture: parseArchitecture(architecture) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to freeze architecture" }, { status: 500 });
  }
}
