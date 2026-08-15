// Forge — Phase 16D: Integration state helpers.
//
// ONE canonical function for checking whether a task is integrated.
// Used by: scheduler (dependency readiness), scheduler (build completion),
// readiness gate, and any code that needs to know if a task is integrated.

import type { Task } from "@prisma/client";

export type ProjectMode = "LOCAL_ONLY" | "GITHUB_BACKED";

/**
 * Check if a task's execution is complete (regardless of integration state).
 */
export function isTaskCompleted(task: { status: string }): boolean {
  return task.status === "COMPLETED";
}

/**
 * Check if a task is fully integrated into the canonical repository.
 *
 * For LOCAL_ONLY: COMPLETED is sufficient (no PR/merge needed).
 * For GITHUB_BACKED: must be COMPLETED AND integrationState === "INTEGRATED".
 *
 * States that block integration:
 *   NONE                  — not yet started
 *   INTEGRATION_PENDING   — PR created but not merged
 *   MERGING               — merge in progress
 *   INTEGRATION_FAILED    — PR creation or merge failed
 *   CANONICAL_HEAD_UNVERIFIED — merged but canonical HEAD refresh failed
 */
export function isTaskIntegrated(task: { status: string; integrationState: string }, mode: ProjectMode): boolean {
  if (task.status !== "COMPLETED") return false;

  if (mode === "LOCAL_ONLY") {
    // Local-only: COMPLETED is sufficient (auto-integrated on completion).
    return true;
  }

  // GITHUB_BACKED: requires explicit INTEGRATED state.
  return task.integrationState === "INTEGRATED";
}

/**
 * Check if a task is in a blocking integration state.
 * These states prevent build finalization for GITHUB_BACKED projects.
 */
export function isIntegrationBlocking(task: { integrationState: string }): boolean {
  const blockingStates = [
    "INTEGRATION_PENDING",
    "MERGING",
    "INTEGRATION_FAILED",
    "CANONICAL_HEAD_UNVERIFIED",
  ];
  return blockingStates.includes(task.integrationState);
}

/**
 * Check if ALL tasks in a project are ready for build finalization.
 *
 * For LOCAL_ONLY: all tasks must be COMPLETED.
 * For GITHUB_BACKED: all tasks must be COMPLETED AND INTEGRATED.
 */
export function areAllTasksReady(tasks: Array<{ status: string; integrationState: string }>, mode: ProjectMode): boolean {
  return tasks.every((t) => isTaskIntegrated(t, mode));
}
