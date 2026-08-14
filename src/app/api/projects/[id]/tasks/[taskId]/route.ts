import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { parseTask } from "../../../../_lib";

// GET /api/projects/[id]/tasks/[taskId] — full task detail with implementationLog
// and full guardianResult/reviewResult (parsed from JSON).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id, taskId } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const task = await db.task.findFirst({ where: { id: taskId, projectId: id } });
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    const parsed = parseTask(task);
    return NextResponse.json({ task: parsed });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch task" }, { status: 500 });
  }
}
