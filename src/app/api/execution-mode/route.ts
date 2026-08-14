import { NextResponse } from "next/server";
import { FORGE_EXECUTION_MODE, executionModeLabel, isExecutionSandboxed } from "@/lib/execution-mode";
import { isExecutionWorkerAvailable } from "@/lib/execution-client";
import { enforceProductionMode, canReachProductionReady } from "@/lib/production-enforcement";

// GET /api/execution-mode — returns the current execution mode and worker status.
// This is used by the UI to show the LOCAL UNSANDBOXED / SANDBOXED badge.
// In production, this endpoint ALSO enforces the execution mode policy:
// if FORGE_EXECUTION_MODE != sandbox in production, the build endpoint will refuse.
export async function GET() {
  const workerAvailable = await isExecutionWorkerAvailable();
  const enforcement = enforceProductionMode();

  return NextResponse.json({
    mode: FORGE_EXECUTION_MODE,
    label: executionModeLabel(),
    sandboxed: isExecutionSandboxed(),
    workerAvailable,
    productionEnforced: enforcement.allowed,
    productionEnforcementReason: enforcement.reason,
    canReachProductionReady: canReachProductionReady(),
    description: FORGE_EXECUTION_MODE === "sandbox"
      ? "Generated code executes in an isolated worker process. Platform secrets are not accessible."
      : "Generated code executes locally (subprocess). Not suitable for production. Start the execution worker for isolation.",
  });
}
