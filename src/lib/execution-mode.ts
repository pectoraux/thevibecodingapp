// Forge — execution mode configuration.
//
// FORGE_EXECUTION_MODE controls how generated code is executed:
// - "local": subprocess execution inside the control plane (UNSANDBOXED, dev only)
// - "sandbox": isolated execution worker (production)
//
// The UI displays the current mode so users know whether execution is isolated.

export type ExecutionMode = "local" | "sandbox";

export const FORGE_EXECUTION_MODE: ExecutionMode =
  process.env.FORGE_EXECUTION_MODE === "sandbox" ? "sandbox" : "local";

export function isExecutionSandboxed(): boolean {
  return FORGE_EXECUTION_MODE === "sandbox";
}

export function executionModeLabel(): string {
  return FORGE_EXECUTION_MODE === "sandbox"
    ? "SANDBOXED EXECUTION"
    : "LOCAL UNSANDBOXED EXECUTION";
}

export function executionModeBadge(): { label: string; variant: "default" | "warning" | "destructive" } {
  if (FORGE_EXECUTION_MODE === "sandbox") {
    return { label: "SANDBOXED", variant: "default" };
  }
  return { label: "LOCAL UNSANDBOXED", variant: "warning" };
}
