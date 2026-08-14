import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { listEvents } from "@/lib/events";
import { parseTask, parseBuildEvent } from "../../../../_lib";

// GET /api/projects/[id]/build/status
//   Returns: { status, totalTasks, completedTasks, failedTasks, currentTask?, recentEvents: BuildEvent[] }
//   recentEvents = most recent 20 build events.
//   currentTask = the task in RUNNING or REVIEWING state (if any).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const [totalTasks, completedTasks, failedTasks, currentTask, recentEventsRaw] = await Promise.all([
      db.task.count({ where: { projectId: id } }),
      db.task.count({ where: { projectId: id, status: "COMPLETED" } }),
      db.task.count({ where: { projectId: id, status: "FAILED" } }),
      db.task.findFirst({
        where: { projectId: id, status: { in: ["RUNNING", "REVIEWING"] } },
        orderBy: { updatedAt: "desc" },
      }),
      listEvents(id, 20),
    ]);
    return NextResponse.json({
      status: project.status,
      totalTasks,
      completedTasks,
      failedTasks,
      currentTask: currentTask ? parseTask(currentTask) : null,
      recentEvents: recentEventsRaw.map(parseBuildEvent),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch build status" }, { status: 500 });
  }
}
