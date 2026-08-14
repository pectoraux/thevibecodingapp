import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseTask } from "../../../../_lib";
import { TaskStatus } from "@/lib/types";

// GET /api/projects/[id]/tasks/[taskId] — full task detail with implementationLog
// and full guardianResult/reviewResult (parsed from JSON).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  try {
    const { id, taskId } = await params;
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
