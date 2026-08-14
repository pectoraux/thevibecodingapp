import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType } from "@/lib/types";
import { parseAgentAssignment, readJsonBody } from "../../../../_lib";

// POST /api/projects/[id]/agents/assign
//   Body: { agentType, providerId }
//   Upserts AgentAssignment for the given agentType on this project.
//   The providerId (if provided) must belong to the authenticated user.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const body = await readJsonBody(req);
    const { agentType, providerId } = body || {};
    if (!agentType) {
      return NextResponse.json({ error: "Missing required field: agentType" }, { status: 400 });
    }
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // If a providerId is given, verify it exists AND belongs to the user.
    if (providerId) {
      const prov = await db.llmProvider.findUnique({ where: { id: providerId } });
      if (!prov) {
        return NextResponse.json({ error: "Provider not found" }, { status: 404 });
      }
      if (prov.userId !== userId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    // Upsert by (projectId, agentType)
    const existing = await db.agentAssignment.findFirst({
      where: { projectId: id, agentType },
    });
    let assignment;
    if (existing) {
      assignment = await db.agentAssignment.update({
        where: { id: existing.id },
        data: { providerId: providerId ?? null },
        include: { provider: true },
      });
    } else {
      assignment = await db.agentAssignment.create({
        data: {
          projectId: id,
          agentType,
          providerId: providerId ?? null,
        },
        include: { provider: true },
      });
    }

    await ensureBuildEvent({
      projectId: id,
      type: BuildEventType.PROVIDER_CONFIGURED,
      level: "info",
      message: `Agent ${agentType} assigned to ${assignment.provider?.name ?? "default sandbox LLM"}`,
      agentType,
      payload: JSON.stringify({ providerId: providerId ?? null }),
    });

    return NextResponse.json({ assignment: parseAgentAssignment(assignment) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to assign agent" }, { status: 500 });
  }
}
