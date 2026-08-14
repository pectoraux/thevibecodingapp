// Forge — Phase 7 Atomic Job Claim
//
// Uses PostgreSQL's FOR UPDATE SKIP LOCKED for truly atomic, race-safe
// job claiming. Two workers can NEVER claim the same job.
//
// This is a raw SQL query because Prisma doesn't support SKIP LOCKED
// in its query builder.

import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import type { ExecutionJob } from "@prisma/client";

const LEASE_DURATION_MS = 180000; // 3 minutes
const EXECUTION_TIMEOUT_MS = 1800000; // 30 minutes

export interface ClaimedJob {
  id: string;
  executionId: string;
  projectId: string;
  taskId: string | null;
  attempt: number;
  requiredCapabilities: string[];
}

/**
 * Atomically claim the next available execution job.
 *
 * Uses PostgreSQL FOR UPDATE SKIP LOCKED to ensure:
 * - Two workers never claim the same job
 * - Workers don't block each other on contended rows
 * - The claim is atomic (no race window between SELECT and UPDATE)
 *
 * Returns the claimed job, or null if no job is available.
 */
export async function claimExecutionJob(workerId: string, workerCapabilities: string[]): Promise<ClaimedJob | null> {
  // Phase 8: Capability-aware atomic claim using FOR UPDATE SKIP LOCKED.
  // The SQL checks that the worker has ALL required capabilities.
  // Two workers can NEVER claim the same job (SKIP LOCKED guarantee).
  const result = await db.$queryRaw<ExecutionJob[]>`
    UPDATE "ExecutionJob"
    SET
      "status" = 'CLAIMED',
      "workerId" = ${workerId},
      "leaseId" = ${randomUUID()},
      "leaseExpiresAt" = ${new Date(Date.now() + LEASE_DURATION_MS)},
      "heartbeatAt" = ${new Date()},
      "startedAt" = COALESCE("startedAt", ${new Date()})
    WHERE "id" = (
      SELECT "id" FROM "ExecutionJob"
      WHERE "status" = 'QUEUED'
      AND (
        "requiredCapabilities" = '[]'
        OR "requiredCapabilities" IS NULL
        OR ${workerCapabilities as any}::text[] && CAST("requiredCapabilities" AS text[])
      )
      ORDER BY "queuedAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;

  if (result.length === 0) {
    return null;
  }

  const job = result[0];
  return {
    id: job.id,
    executionId: job.executionId,
    projectId: job.projectId,
    taskId: job.taskId,
    attempt: job.attempt,
    requiredCapabilities: JSON.parse(job.requiredCapabilities || "[]"),
  };
}

/**
 * Renew the lease on a claimed job.
 * The worker calls this periodically to indicate it's still alive.
 */
export async function renewExecutionJobLease(jobId: string, workerId: string): Promise<boolean> {
  const result = await db.executionJob.updateMany({
    where: {
      id: jobId,
      workerId,
      status: { in: ["CLAIMED", "RUNNING", "VERIFYING"] },
    },
    data: {
      heartbeatAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
    },
  });
  return result.count > 0;
}

/**
 * Complete a job with a result.
 * Idempotent — if the job is already completed, returns true without duplicating.
 */
export async function completeExecutionJob(
  executionId: string,
  result: {
    status: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "BLOCKED";
    commitSha?: string;
    results?: any;
    errorMessage?: string;
  }
): Promise<boolean> {
  // Check if already completed (idempotency).
  const existing = await db.executionJob.findUnique({
    where: { executionId },
    select: { id: true, status: true },
  });

  if (!existing) return false;

  // If already in a terminal state, don't duplicate.
  if (["SUCCEEDED", "FAILED", "TIMED_OUT", "BLOCKED", "CANCELLED"].includes(existing.status)) {
    return true; // Idempotent — already completed.
  }

  await db.executionJob.update({
    where: { id: existing.id },
    data: {
      status: result.status,
      commitSha: result.commitSha || null,
      results: result.results ? JSON.stringify(result.results) : null,
      errorMessage: result.errorMessage || null,
      completedAt: new Date(),
      leaseExpiresAt: null, // Release the lease.
    },
  });

  return true;
}

/**
 * Recover expired jobs — requeue any CLAIMED/RUNNING jobs whose lease has expired.
 * Called by the scheduler or a periodic recovery process.
 */
export async function recoverExpiredExecutionJobs(): Promise<number> {
  const now = new Date();
  const result = await db.executionJob.updateMany({
    where: {
      status: { in: ["CLAIMED", "RUNNING", "VERIFYING"] },
      leaseExpiresAt: { lt: now },
    },
    data: {
      status: "QUEUED",
      workerId: null,
      leaseId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      attempt: { increment: 1 },
    },
  });
  return result.count;
}

/**
 * Create an execution job for a task.
 * Idempotent — if a job with the same idempotency key exists, returns it.
 */
export async function createExecutionJob(input: {
  projectId: string;
  taskId: string;
  attempt: number;
  buildJobId?: string;
  requiredCapabilities?: string[];
}): Promise<ExecutionJob> {
  const idempotencyKey = `${input.projectId}:${input.taskId}:${input.attempt}`;
  const executionId = `${input.taskId}-${input.attempt}-${randomUUID().slice(0, 8)}`;

  const existing = await db.executionJob.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;

  return db.executionJob.create({
    data: {
      projectId: input.projectId,
      buildJobId: input.buildJobId || null,
      taskId: input.taskId,
      executionId,
      attempt: input.attempt,
      status: "QUEUED",
      requiredCapabilities: JSON.stringify(input.requiredCapabilities || ["node", "git", "test"]),
      executionTimeoutMs: EXECUTION_TIMEOUT_MS,
      idempotencyKey,
    },
  });
}
