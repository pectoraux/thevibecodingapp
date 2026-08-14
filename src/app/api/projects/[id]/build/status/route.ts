import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { listEvents } from "@/lib/events";
import { parseTask, parseBuildEvent } from "../../../../_lib";

// GET /api/projects/[id]/build/status
//
// Phase 6: Returns build status including async job queue state.
// The build now runs asynchronously — this endpoint is polled by the UI
// to track progress. When the build is running, the UI should also
// trigger /api/scheduler/tick to process the next job (in local mode).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [totalTasks, completedTasks, failedTasks, currentTask, recentEventsRaw, buildJobs] = await Promise.all([
      db.task.count({ where: { projectId: id } }),
      db.task.count({ where: { projectId: id, status: "COMPLETED" } }),
      db.task.count({ where: { projectId: id, status: "FAILED" } }),
      db.task.findFirst({
        where: { projectId: id, status: { in: ["RUNNING", "REVIEWING"] } },
        orderBy: { updatedAt: "desc" },
      }),
      listEvents(id, 20),
      db.buildJob.findMany({
        where: { projectId: id },
        orderBy: { queuedAt: "desc" },
        take: 5,
      }),
    ]);

    return NextResponse.json({
      status: project.status,
      totalTasks,
      completedTasks,
      failedTasks,
      currentTask: currentTask ? parseTask(currentTask) : null,
      recentEvents: recentEventsRaw.map(parseBuildEvent),
      // Phase 6: async job queue state.
      buildJobs: buildJobs.map((j) => ({
        id: j.id,
        type: j.type,
        status: j.status,
        workerId: j.workerId,
        leaseExpiresAt: j.leaseExpiresAt,
        heartbeatAt: j.heartbeatAt,
        queuedAt: j.queuedAt,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
        errorMessage: j.errorMessage,
      })),
      // Phase 6: when the build is in BUILDING state, trigger a scheduler tick
      // so the async queue is processed (local mode only).
      triggerSchedulerTick: project.status === "BUILDING",
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch build status" }, { status: 500 });
  }
}
