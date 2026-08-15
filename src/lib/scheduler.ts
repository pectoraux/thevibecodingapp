// Forge — Phase 7 Scheduler
//
// The scheduler creates ExecutionJobs for each task in the build graph.
// The WORKER (not the scheduler) claims and executes these jobs.
//
// Flow:
//   BuildJob QUEUED → Scheduler creates ExecutionJobs → Workers claim → Workers execute
//   → Workers report results → Scheduler monitors → BuildJob completes
//
// The scheduler does NOT execute tasks. It only:
// - Creates ExecutionJobs for runnable tasks
// - Monitors job completion
// - Runs the readiness gate when all tasks are done

import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import type { BuildJob } from "@prisma/client";
import { createJob, updateJobStatus, recoverExpiredJobs } from "@/lib/job-queue";
import { createExecutionJob, recoverExpiredExecutionJobs } from "@/lib/execution-jobs";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType, TaskStatus, ProjectStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// Enqueue a build — creates a QUEUED BuildJob and returns immediately.
// ---------------------------------------------------------------------------

export async function enqueueBuild(projectId: string): Promise<BuildJob> {
  const job = await createJob({
    projectId,
    type: "BUILD",
    timeoutMs: 600000,
  });

  await ensureBuildEvent({
    projectId,
    type: BuildEventType.BUILD_STARTED,
    level: "success",
    message: `Build job ${job.id} queued (async, worker-driven)`,
    payload: JSON.stringify({ jobId: job.id, status: job.status }),
  });

  return job;
}

// ---------------------------------------------------------------------------
// Process the build queue — creates ExecutionJobs for runnable tasks.
//
// This is called by the /api/scheduler/tick endpoint (for dev mode) or
// by a periodic recovery process. It does NOT execute tasks — it only
// creates ExecutionJobs that workers will claim.
// ---------------------------------------------------------------------------

export async function processBuildQueue(): Promise<{
  processed: number;
  recovered: number;
  remaining: number;
  executionJobsCreated: number;
}> {
  // 1. Recover expired jobs (workers that crashed).
  const recoveredBuildJobs = await recoverExpiredJobs();
  const recoveredExecJobs = await recoverExpiredExecutionJobs();
  const recovered = recoveredBuildJobs + recoveredExecJobs;
  if (recovered > 0) {
    console.log(`[scheduler] recovered ${recovered} expired job(s)`);
  }

  let executionJobsCreated = 0;

  // 2. Find QUEUED build jobs and create ExecutionJobs for their tasks.
  const queuedBuildJobs = await db.buildJob.findMany({
    where: { status: "QUEUED", type: "BUILD" },
    orderBy: { queuedAt: "asc" },
  });

  let processed = 0;
  for (const buildJob of queuedBuildJobs) {
    // Claim the build job.
    const claimed = await claimBuildJob(buildJob.id);
    if (!claimed) continue;

    await updateJobStatus(buildJob.id, "RUNNING");
    await db.project.update({
      where: { id: buildJob.projectId },
      data: { status: ProjectStatus.BUILDING },
    });

    // Create ExecutionJobs for all PLANNED tasks whose dependencies are met.
    const tasks = await db.task.findMany({
      where: { projectId: buildJob.projectId },
      orderBy: { priority: "asc" },
    });
    const byCode = new Map(tasks.map((t) => [t.code, t]));

    for (const task of tasks) {
      // P16: Skip tasks that are already done, integration-pending, or integrated.
      if ([TaskStatus.COMPLETED, TaskStatus.INTEGRATION_PENDING, TaskStatus.INTEGRATED].includes(task.status as any)) continue;

      // P16: Check dependencies — must be INTEGRATED (not just COMPLETED).
      // This ensures dependency changes are in the canonical HEAD before
      // dependent tasks can run.
      const deps = JSON.parse(task.dependencies || "[]") as string[];
      const allDepsIntegrated = deps.every((d) => {
        const dep = byCode.get(d);
        return dep?.status === TaskStatus.INTEGRATED;
      });
      if (!allDepsIntegrated) continue;

      // Create an ExecutionJob for this task (idempotent).
      const execJob = await createExecutionJob({
        projectId: buildJob.projectId,
        taskId: task.id,
        attempt: task.attempts + 1,
        buildJobId: buildJob.id,
        requiredCapabilities: ["node", "git", "test", "build"],
      });

      // Only count as "created" if it's new (not already existed).
      if (execJob.status === "QUEUED") {
        executionJobsCreated++;
      }
    }

    processed++;
  }

  // 3. Check for completed builds (all tasks done).
  await checkCompletedBuilds();

  // 4. Count remaining.
  const remaining = await db.buildJob.count({
    where: { status: { in: ["QUEUED", "CLAIMED", "RUNNING"] } },
  });

  return { processed, recovered, remaining, executionJobsCreated };
}

// ---------------------------------------------------------------------------
// Claim a build job atomically.
// ---------------------------------------------------------------------------

async function claimBuildJob(buildJobId: string): Promise<boolean> {
  const result = await db.buildJob.updateMany({
    where: { id: buildJobId, status: "QUEUED" },
    data: {
      status: "RUNNING",
      workerId: `scheduler-${randomUUID()}`,
      leaseExpiresAt: new Date(Date.now() + 600000),
      startedAt: new Date(),
    },
  });
  return result.count > 0;
}

// ---------------------------------------------------------------------------
// Check for builds where all tasks are completed → run readiness gate.
// ---------------------------------------------------------------------------

async function checkCompletedBuilds(): Promise<void> {
  const runningBuildJobs = await db.buildJob.findMany({
    where: { status: "RUNNING", type: "BUILD" },
  });

  for (const buildJob of runningBuildJobs) {
    const tasks = await db.task.findMany({
      where: { projectId: buildJob.projectId },
    });

    // P16A: Check for failed tasks first.
    if (tasks.some((t) => t.status === TaskStatus.FAILED && t.attempts >= t.maxAttempts)) {
      await db.project.update({
        where: { id: buildJob.projectId },
        data: { status: ProjectStatus.HUMAN_REVIEW_REQUIRED },
      });
      await updateJobStatus(buildJob.id, "BLOCKED", {
        errorMessage: "Task exhausted retries",
      });
      continue;
    }

    // P16A: Build completion requires ALL tasks to be COMPLETED.
    const pendingTasks = tasks.filter((t) => t.status !== TaskStatus.COMPLETED);
    if (pendingTasks.length > 0) continue;

    // P16A: For GITHUB_BACKED projects, ALL tasks must also be INTEGRATED.
    // COMPLETED alone is NOT sufficient — the PR must be merged.
    const project = await db.project.findUnique({
      where: { id: buildJob.projectId },
      select: { githubConnected: true, githubRepo: true },
    });
    const isGithubBacked = project?.githubConnected && !!project.githubRepo;

    if (isGithubBacked) {
      const unintegratedTasks = tasks.filter(
        (t) => t.integrationState !== "INTEGRATED"
      );
      if (unintegratedTasks.length > 0) {
        // Some tasks are COMPLETED but not INTEGRATED — build cannot finalize.
        continue;
      }
    }

    // All tasks completed AND integrated (for GitHub-backed) — run readiness gate.
    await finalizeBuild(buildJob);
  }
}

// ---------------------------------------------------------------------------
// Finalize a build — run the readiness gate and update project status.
// ---------------------------------------------------------------------------

async function finalizeBuild(buildJob: BuildJob): Promise<void> {
  await db.project.update({
    where: { id: buildJob.projectId },
    data: { status: ProjectStatus.VERIFYING },
  });

  const { runReadinessGate } = await import("@/lib/readiness");
  const gate = await runReadinessGate(buildJob.projectId);

  if (gate.passed) {
    await db.project.update({
      where: { id: buildJob.projectId },
      data: { status: ProjectStatus.PRODUCTION_READY },
    });
    await ensureBuildEvent({
      projectId: buildJob.projectId,
      type: BuildEventType.PRODUCTION_READY,
      level: "success",
      message: `PRODUCTION READY — ${gate.passedCount}/${gate.total} checks passed`,
    });
    await updateJobStatus(buildJob.id, "SUCCEEDED", { results: JSON.stringify(gate) });
  } else {
    await db.project.update({
      where: { id: buildJob.projectId },
      data: { status: ProjectStatus.HUMAN_REVIEW_REQUIRED },
    });
    await ensureBuildEvent({
      projectId: buildJob.projectId,
      type: BuildEventType.HUMAN_REVIEW_REQUIRED,
      level: "warn",
      message: `Human review required — ${gate.failedCount} checks failed`,
    });
    await updateJobStatus(buildJob.id, "BLOCKED", {
      errorMessage: `${gate.failedCount} readiness checks failed`,
    });
  }
}

// ---------------------------------------------------------------------------
// Scheduler status — for monitoring.
// ---------------------------------------------------------------------------

export async function getSchedulerStatus(): Promise<{
  queuedBuildJobs: number;
  runningBuildJobs: number;
  queuedExecutionJobs: number;
  runningExecutionJobs: number;
  activeWorkers: number;
  totalJobs: number;
}> {
  const [
    queuedBuildJobs,
    runningBuildJobs,
    queuedExecutionJobs,
    runningExecutionJobs,
    activeWorkers,
    totalJobs,
  ] = await Promise.all([
    db.buildJob.count({ where: { status: "QUEUED" } }),
    db.buildJob.count({ where: { status: "RUNNING" } }),
    db.executionJob.count({ where: { status: "QUEUED" } }),
    db.executionJob.count({ where: { status: { in: ["CLAIMED", "RUNNING"] } } }),
    db.workerRegistry.count({ where: { status: { in: ["READY", "BUSY"] } } }),
    db.buildJob.count({}),
  ]);

  return {
    queuedBuildJobs,
    runningBuildJobs,
    queuedExecutionJobs,
    runningExecutionJobs,
    activeWorkers,
    totalJobs,
  };
}
