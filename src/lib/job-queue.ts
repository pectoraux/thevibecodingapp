// Forge — durable job queue (Phase 4: leases, heartbeats, recovery).
//
// Jobs persist in the database. A server restart does NOT lose the job.
// Workers claim jobs using a lease. If the worker dies, the lease expires
// and the job can be reclaimed.
//
// Semantics: at-least-once execution + idempotent side effects.
// Git commits, PR creation, and deployment actions must be protected
// with idempotency keys (projectId+taskId+attempt).

import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import type { BuildJob } from "@prisma/client";

export type JobType = "BUILD" | "EXECUTION" | "VERIFICATION";
export type JobStatus =
  | "QUEUED"
  | "CLAIMED"
  | "RUNNING"
  | "WAITING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "BLOCKED";

const LEASE_DURATION_MS = 300000; // 5 minutes

export async function createJob(input: {
  projectId: string;
  type: JobType;
  taskId?: string;
  attempt?: number;
  timeoutMs?: number;
}): Promise<BuildJob> {
  const idempotencyKey = `${input.projectId}:${input.taskId || "none"}:${input.attempt || 0}`;
  // Upsert by idempotency key — if the same job is created twice, return the existing one.
  const existing = await db.buildJob.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;

  return db.buildJob.create({
    data: {
      projectId: input.projectId,
      type: input.type,
      taskId: input.taskId,
      attempt: input.attempt || 0,
      timeoutMs: input.timeoutMs || 300000,
      status: "QUEUED",
      idempotencyKey,
    },
  });
}

/**
 * Claim a job for execution. Returns the job if claimed, null if no job available.
 * Sets the lease expiry — if the worker dies, the lease expires and the job
 * can be reclaimed.
 */
export async function claimNextJob(workerId: string): Promise<BuildJob | null> {
  // Find a QUEUED job (or a CLAIMED/RUNNING job whose lease has expired).
  const now = new Date();
  const expiredJobs = await db.buildJob.findMany({
    where: {
      status: { in: ["CLAIMED", "RUNNING"] },
      leaseExpiresAt: { lt: now },
    },
    take: 1,
  });

  let job: BuildJob | null = null;

  if (expiredJobs.length > 0) {
    // Reclaim an expired job.
    const expired = expiredJobs[0];
    job = await db.buildJob.update({
      where: { id: expired.id },
      data: {
        status: "CLAIMED",
        workerId,
        leaseId: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
        heartbeatAt: new Date(),
        attempt: { increment: 1 },
      },
    });
  } else {
    // Find a QUEUED job.
    const queued = await db.buildJob.findFirst({
      where: { status: "QUEUED" },
      orderBy: { queuedAt: "asc" },
    });
    if (!queued) return null;

    job = await db.buildJob.update({
      where: { id: queued.id },
      data: {
        status: "CLAIMED",
        workerId,
        leaseId: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
        heartbeatAt: new Date(),
        startedAt: new Date(),
      },
    });
  }

  return job;
}

/**
 * Update job heartbeat — the worker calls this periodically to indicate
 * it's still alive. Extends the lease.
 */
export async function heartbeat(jobId: string, workerId: string): Promise<void> {
  await db.buildJob.updateMany({
    where: { id: jobId, workerId },
    data: {
      heartbeatAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
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
    ...(status === "RUNNING" ? {} : {}),
    ...(["SUCCEEDED", "FAILED", "BLOCKED", "TIMED_OUT", "CANCELLED"].includes(status)
      ? { completedAt: new Date(), leaseExpiresAt: null }
      : {}),
    ...extra,
  };
  await db.buildJob.update({ where: { id: jobId }, data: updates });
}

/**
 * Recover expired jobs — called on startup or periodically.
 * Any job that is CLAIMED/RUNNING with an expired lease gets requeued.
 */
export async function recoverExpiredJobs(): Promise<number> {
  const now = new Date();
  const result = await db.buildJob.updateMany({
    where: {
      status: { in: ["CLAIMED", "RUNNING"] },
      leaseExpiresAt: { lt: now },
    },
    data: { status: "QUEUED", workerId: null, leaseId: null, leaseExpiresAt: null },
  });
  return result.count;
}

export async function getJob(jobId: string): Promise<BuildJob | null> {
  return db.buildJob.findUnique({ where: { id: jobId } });
}

export async function getIncompleteJobs(projectId: string): Promise<BuildJob[]> {
  return db.buildJob.findMany({
    where: {
      projectId,
      status: { in: ["QUEUED", "CLAIMED", "RUNNING", "WAITING"] },
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
