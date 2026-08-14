// Forge — Phase 6 Async Scheduler
//
// This module replaces the synchronous execution RPC with a genuine
// asynchronous durable worker scheduler.
//
// Flow:
//   Task created → BuildJob QUEUED → Scheduler claims → Worker executes
//   → Heartbeat → Result persisted → Job completed
//
// The control-plane request that starts a build returns quickly after
// enqueueing. The build runs asynchronously.
//
// CRITICAL INVARIANTS:
// 1. Starting a build creates a QUEUED BuildJob and returns.
// 2. The control-plane request does NOT wait for build completion.
// 3. Workers claim jobs via atomic lease acquisition.
// 4. If a worker crashes, its lease expires and the job is requeued.
// 5. Duplicate results are idempotent (idempotency key).

import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import type { BuildJob, Task } from "@prisma/client";
import {
  createJob,
  updateJobStatus,
  getJob,
  getIncompleteJobs,
  claimNextJob,
  heartbeat,
  recoverExpiredJobs,
} from "@/lib/job-queue";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType, TaskStatus, ProjectStatus } from "@/lib/types";

const LEASE_DURATION_MS = 300000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 60000; // 1 minute
const MAX_BUILD_LOOP_ITERATIONS = 60;

// ---------------------------------------------------------------------------
// Enqueue a build — creates a QUEUED BuildJob and returns immediately.
// The actual execution happens via processBuildQueue().
// ---------------------------------------------------------------------------

export async function enqueueBuild(projectId: string): Promise<BuildJob> {
  const job = await createJob({
    projectId,
    type: "BUILD",
    timeoutMs: 600000, // 10 minutes total
  });

  await ensureBuildEvent({
    projectId,
    type: BuildEventType.BUILD_STARTED,
    level: "success",
    message: `Build job ${job.id} queued (async)`,
    payload: JSON.stringify({ jobId: job.id, status: job.status }),
  });

  return job;
}

// ---------------------------------------------------------------------------
// Process the build queue — called by the scheduler tick.
// This is the ASYNC execution path. It does NOT block the HTTP request.
//
// In a full deployment, this would be called by:
// - A cron job / Vercel Cron endpoint
// - A worker polling loop
// - A scheduler service
//
// For now, it's called by the /api/scheduler/tick endpoint, which can be
// triggered by cron or by the build status polling.
// ---------------------------------------------------------------------------

export async function processBuildQueue(): Promise<{
  processed: number;
  recovered: number;
  remaining: number;
}> {
  // 1. Recover expired jobs (workers that crashed).
  const recovered = await recoverExpiredJobs();
  if (recovered > 0) {
    console.log(`[scheduler] recovered ${recovered} expired job(s)`);
  }

  // 2. Find projects with QUEUED build jobs.
  const queuedJobs = await db.buildJob.findMany({
    where: { status: "QUEUED", type: "BUILD" },
    orderBy: { queuedAt: "asc" },
    take: 1, // Process one at a time for correctness.
  });

  let processed = 0;
  for (const job of queuedJobs) {
    await processBuildJob(job);
    processed++;
  }

  // 3. Count remaining jobs.
  const remaining = await db.buildJob.count({
    where: { status: { in: ["QUEUED", "CLAIMED", "RUNNING"] } },
  });

  return { processed, recovered, remaining };
}

// ---------------------------------------------------------------------------
// Process a single build job — the full autonomous build loop.
// This is the same logic that was previously in startBuild(), but now
// it's driven by the job queue, not by an HTTP request.
// ---------------------------------------------------------------------------

async function processBuildJob(job: BuildJob): Promise<void> {
  const projectId = job.projectId;

  // Claim the job atomically (race-safe).
  const claimed = await claimNextJob(`scheduler-${randomUUID()}`);
  if (!claimed || claimed.id !== job.id) {
    // Another worker claimed it first, or job was cancelled.
    return;
  }

  try {
    await updateJobStatus(job.id, "RUNNING");

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) {
      await updateJobStatus(job.id, "FAILED", { errorMessage: "Project not found" });
      return;
    }

    await db.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.BUILDING },
    });

    // Run the autonomous build loop (bounded iterations).
    for (let i = 0; i < MAX_BUILD_LOOP_ITERATIONS; i++) {
      // Heartbeat on each iteration.
      await heartbeat(job.id, claimed.workerId || "scheduler");

      const shouldStop = await tickOnce(projectId);
      if (shouldStop) break;
    }

    // Final verification.
    await db.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.VERIFYING },
    });

    // Run readiness gate.
    const { runReadinessGate } = await import("@/lib/readiness");
    const gate = await runReadinessGate(projectId);

    if (gate.passed) {
      await db.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.PRODUCTION_READY },
      });
      await ensureBuildEvent({
        projectId,
        type: BuildEventType.PRODUCTION_READY,
        level: "success",
        message: `PRODUCTION READY — ${gate.passedCount}/${gate.total} readiness checks passed`,
      });
      await updateJobStatus(job.id, "SUCCEEDED", {
        results: JSON.stringify(gate),
      });
    } else {
      await db.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.HUMAN_REVIEW_REQUIRED },
      });
      await ensureBuildEvent({
        projectId,
        type: BuildEventType.HUMAN_REVIEW_REQUIRED,
        level: "warn",
        message: `Human review required — ${gate.failedCount} readiness check(s) failed`,
      });
      await updateJobStatus(job.id, "BLOCKED", {
        errorMessage: `${gate.failedCount} readiness checks failed`,
        results: JSON.stringify(gate.results.filter((r: any) => r.status !== "PASSED")),
      });
    }
  } catch (err: any) {
    await updateJobStatus(job.id, "FAILED", { errorMessage: err.message });
    await ensureBuildEvent({
      projectId,
      type: BuildEventType.TASK_FAILED,
      level: "error",
      message: `Build job ${job.id} failed: ${err.message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// One tick of the autonomous loop — imported from orchestrator.
// Returns true if the loop should stop.
// ---------------------------------------------------------------------------

async function tickOnce(projectId: string): Promise<boolean> {
  // Dynamic import to avoid circular dependency with orchestrator.ts.
  const { executeTask } = await import("@/lib/orchestrator");
  const tasks = await db.task.findMany({ where: { projectId }, orderBy: { priority: "asc" } });
  const byCode = new Map(tasks.map((t) => [t.code, t]));

  let next: Task | null = null;
  for (const t of tasks) {
    if ([TaskStatus.RUNNING, TaskStatus.REVIEWING, TaskStatus.COMPLETED].includes(t.status as any)) continue;
    if (t.status === TaskStatus.FAILED && t.attempts >= t.maxAttempts) continue;
    const deps = JSON.parse(t.dependencies || "[]") as string[];
    const allDepsDone = deps.every((d) => {
      const dep = byCode.get(d);
      return dep?.status === TaskStatus.COMPLETED;
    });
    if (!allDepsDone) continue;
    next = t;
    break;
  }

  if (!next) {
    const pending = tasks.filter((t) => t.status !== TaskStatus.COMPLETED);
    if (pending.length === 0) return true;
    if (tasks.some((t) => t.status === TaskStatus.FAILED && t.attempts >= t.maxAttempts)) {
      await db.project.update({ where: { id: projectId }, data: { status: ProjectStatus.HUMAN_REVIEW_REQUIRED } });
      return true;
    }
    return true;
  }

  await executeTask(projectId, next.id);
  return false;
}

// ---------------------------------------------------------------------------
// Scheduler status — for monitoring.
// ---------------------------------------------------------------------------

export async function getSchedulerStatus(): Promise<{
  queuedJobs: number;
  runningJobs: number;
  claimedJobs: number;
  totalJobs: number;
  lastRecoveryAt: number | null;
}> {
  const [queued, running, claimed, total] = await Promise.all([
    db.buildJob.count({ where: { status: "QUEUED" } }),
    db.buildJob.count({ where: { status: "RUNNING" } }),
    db.buildJob.count({ where: { status: "CLAIMED" } }),
    db.buildJob.count({}),
  ]);

  return {
    queuedJobs: queued,
    runningJobs: running,
    claimedJobs: claimed,
    totalJobs: total,
    lastRecoveryAt: null, // Could track this in a metadata table.
  };
}
