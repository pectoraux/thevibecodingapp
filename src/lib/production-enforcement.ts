// Forge — production enforcement.
//
// In production, the platform MUST refuse to start in LOCAL_UNSANDBOXED mode.
// This is enforced by architecture, not by UI warnings.
//
// Call enforceProductionMode() at startup (or in middleware) to verify.

import { FORGE_EXECUTION_MODE } from "@/lib/execution-mode";

export interface ProductionCheckResult {
  allowed: boolean;
  reason: string;
  mode: string;
  environment: string;
}

/**
 * Verify that the current configuration is allowed for the environment.
 * In production (NODE_ENV=production), LOCAL_UNSANDBOXED is forbidden.
 */
export function enforceProductionMode(): ProductionCheckResult {
  const isProd = process.env.NODE_ENV === "production";
  const mode = FORGE_EXECUTION_MODE;

  if (isProd && mode !== "sandbox") {
    return {
      allowed: false,
      reason: `Production environment requires FORGE_EXECUTION_MODE=sandbox, but got '${mode}'. Refusing to start in LOCAL_UNSANDBOXED mode.`,
      mode,
      environment: "production",
    };
  }

  return {
    allowed: true,
    reason: `Mode '${mode}' is allowed in ${isProd ? "production" : "development"} environment.`,
    mode,
    environment: isProd ? "production" : "development",
  };
}

/**
 * Check if the production readiness gate should refuse based on execution mode.
 * LOCAL_UNSANDBOXED can never reach PRODUCTION_READY.
 *
 * Phase 17A: Also blocks LOCAL_ONLY projects — the worker's /tmp checkout is
 * ephemeral and file contents are not persisted, so content-based readiness
 * checks cannot verify the actual repository. A GitHub connection is required
 * for PRODUCTION_READY.
 */
export function canReachProductionReady(projectMode?: "LOCAL_ONLY" | "GITHUB_BACKED"): boolean {
  // Execution mode must be sandboxed.
  if (FORGE_EXECUTION_MODE !== "sandbox") return false;

  // Project mode must be GITHUB_BACKED (Phase 17A).
  // LOCAL_ONLY cannot reach PRODUCTION_READY — no persistent repository.
  if (projectMode === "LOCAL_ONLY") return false;

  return true;
}

/**
 * Phase 17A: Explicit LOCAL_ONLY production-ready policy.
 *
 * LOCAL_ONLY projects:
 *   ✅ can develop and test
 *   ✅ can complete tasks
 *   ❌ cannot reach PRODUCTION_READY
 *
 * This is enforced structurally in the readiness gate (a dedicated check
 * fails for LOCAL_ONLY) AND here as a policy function.
 */
export function getLocalOnlyPolicyReason(): string {
  return "LOCAL_ONLY projects cannot reach PRODUCTION_READY — the worker's /tmp checkout is ephemeral and file contents are not persisted. Connect a GitHub repository to enable production readiness verification.";
}
