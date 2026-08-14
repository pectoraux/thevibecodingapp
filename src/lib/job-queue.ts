// Forge — durable job queue.
//
// Jobs persist in the database. A server restart does NOT lose the job.
// The orchestrator creates a BuildJob record, then processes it. If
// interrupted, the job can be resumed by checking for incomplete jobs.

import { db } from "@/lib/db";
import type { BuildJob } from "@prisma/client";

export type JobType = "BUILD" | "EXECUTION" | "VERIFICATION";
export type JobStatus =
  | "QUEUED"
  | "DISPATCHING"
  | "RUNNING"
  | "WAITING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "BLOCKED";

export async function createJob(input: {
  projectId: string;
  type: JobType;
  taskId?: string;
  attempt?: number;
  timeoutMs?: number;
}): Promise<BuildJob> {
  return db.buildJob.create({
    data: {
      projectId: input.projectId,
      type: input.type,
      taskId: input.taskId,
      attempt: input.attempt || 0,
      timeoutMs: input.timeoutMs || 300000,
      status: "QUEUED",
    },
  });
}

export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  extra?: Partial<BuildJob>
): Promise<void> {
  const updates: any = {
    status,
    ...(status === "DISPATCHING" || status === "RUNNING" ? { startedAt: new Date() } : {}),
    ...(status === "SUCCEEDED" || status === "FAILED" || status === "BLOCKED" || status === "TIMED_OUT" || status === "CANCELLED" ? { completedAt: new Date() } : {}),
    ...extra,
  };
  await db.buildJob.update({ where: { id: jobId }, data: updates });
}

export async function getJob(jobId: string): Promise<BuildJob | null> {
  return db.buildJob.findUnique({ where: { id: jobId } });
}

export async function getIncompleteJobs(projectId: string): Promise<BuildJob[]> {
  return db.buildJob.findMany({
    where: {
      projectId,
      status: { in: ["QUEUED", "DISPATCHING", "RUNNING", "WAITING"] },
    },
    orderBy: { queuedAt: "asc" },
  });
}

export async function getProjectJobs(projectId: string, limit = 50): Promise<BuildJob[]> {
  return db.buildJob.findMany({
    where: { projectId },
    orderBy: { queuedAt: "desc" },
    take: limit,
  });
}
