import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { parseAgentAssignment } from "../../../_lib";

// GET /api/projects/[id]/agents — list agent assignments with their assigned provider (apiKey stripped)
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const agents = await db.agentAssignment.findMany({
      where: { projectId: id },
      include: { provider: true },
      orderBy: { agentType: "asc" },
    });
    return NextResponse.json({ agents: agents.map(parseAgentAssignment) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to list agents" }, { status: 500 });
  }
}
