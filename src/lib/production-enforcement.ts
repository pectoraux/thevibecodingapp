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
 */
export function canReachProductionReady(): boolean {
  return FORGE_EXECUTION_MODE === "sandbox";
}
