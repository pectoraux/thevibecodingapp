import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType, TaskStatus } from "@/lib/types";
import { parseTask } from "../../../../../_lib";

// POST /api/projects/[id]/tasks/[taskId]/retry — reset task to PLANNED, clear failureReason
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; taskId: string }> }) {
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
    const updated = await db.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.PLANNED,
        failureReason: null,
        blockedReason: null,
      },
    });
    await ensureBuildEvent({
      projectId: id,
      type: BuildEventType.TASK_QUEUED,
      level: "info",
      message: `Task ${task.code} reset to PLANNED for retry`,
      taskId: task.id,
      agentType: task.agentType,
    });
    return NextResponse.json({ task: parseTask(updated) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to retry task" }, { status: 500 });
  }
}
