import { NextResponse } from "next/server";
import { FORGE_EXECUTION_MODE, executionModeLabel, isExecutionSandboxed } from "@/lib/execution-mode";
import { isExecutionWorkerAvailable } from "@/lib/execution-client";

// GET /api/execution-mode — returns the current execution mode and worker status.
// This is used by the UI to show the LOCAL UNSANDBOXED / SANDBOXED badge.
export async function GET() {
  const workerAvailable = await isExecutionWorkerAvailable();
  return NextResponse.json({
    mode: FORGE_EXECUTION_MODE,
    label: executionModeLabel(),
    sandboxed: isExecutionSandboxed(),
    workerAvailable,
    description: FORGE_EXECUTION_MODE === "sandbox"
      ? "Generated code executes in an isolated worker process. Platform secrets are not accessible."
      : "Generated code executes locally (subprocess). Not suitable for production. Start the execution worker for isolation.",
  });
}
