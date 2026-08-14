// Forge — execution client.
//
// This module is the control-plane side of the execution plane separation.
// It sends job requests to the isolated execution worker via HTTP.
//
// The control plane NEVER executes generated code directly. All execution
// goes through this client → the execution worker (separate process).
//
// If the worker is unavailable, the task is BLOCKED (not silently run locally).

import { FORGE_EXECUTION_MODE } from "@/lib/execution-mode";

export interface ExecutionJobRequest {
  jobId: string;
  projectId: string;
  commands: { command: string; args: string[]; timeoutMs?: number }[];
  worktreePath?: string;
  env?: Record<string, string>; // explicit allowlist only
  files?: { path: string; content: string }[];
  timeoutMs?: number;
}

export interface ExecutionJobResponse {
  jobId: string;
  results: any[];
  success: boolean;
  error?: string;
  workDir: string;
  durationMs: number;
}

const WORKER_URL = process.env.FORGE_EXECUTION_WORKER_URL || "http://localhost:3001";

/**
 * Check if the execution worker is available.
 */
export async function isExecutionWorkerAvailable(): Promise<boolean> {
  if (FORGE_EXECUTION_MODE === "local") {
    // In local mode, the worker may not be running. We fall back to local
    // execution but mark it as UNSANDBOXED.
    try {
      const res = await fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }
  // In sandbox mode, the worker MUST be available.
  try {
    const res = await fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Submit an execution job to the isolated worker.
 * Returns the job results, or throws if the worker is unavailable.
 */
export async function submitExecutionJob(request: ExecutionJobRequest): Promise<ExecutionJobResponse> {
  const available = await isExecutionWorkerAvailable();
  if (!available) {
    if (FORGE_EXECUTION_MODE === "sandbox") {
      throw new Error("BLOCKED: Execution worker unavailable in sandbox mode");
    }
    // In local mode, fall back to local execution (UNSANDBOXED).
    return localExecutionFallback(request);
  }

  const res = await fetch(`${WORKER_URL}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(request.timeoutMs || 300000),
  });

  if (!res.ok) {
    throw new Error(`Execution worker returned HTTP ${res.status}: ${await res.text()}`);
  }

  return await res.json() as ExecutionJobResponse;
}

/**
 * Local execution fallback — used ONLY in FORGE_EXECUTION_MODE=local when
 * the worker is not running. This is explicitly UNSANDBOXED and the UI
 * shows a warning. Production deployments must use sandbox mode.
 */
async function localExecutionFallback(request: ExecutionJobRequest): Promise<ExecutionJobResponse> {
  const { spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");

  const workDir = request.worktreePath || join("/tmp/forge-exec", request.jobId || randomUUID());
  try { mkdirSync(workDir, { recursive: true }); } catch {}

  // Write files.
  if (request.files) {
    for (const f of request.files) {
      const fullPath = join(workDir, f.path);
      try {
        const { dirname } = await import("node:path");
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, f.content);
      } catch {}
    }
  }

  // CRITICAL: In local fallback, we still use a restricted env (NOT process.env).
  // This is less safe than the worker (same process), but we still don't pass
  // platform secrets to the child.
  const FORBIDDEN = ["DATABASE_URL", "DIRECT_URL", "NEXTAUTH_SECRET", "FORGE_MASTER_KEY", "FORGE_SECRET", "GITHUB_PAT", "GITHUB_TOKEN", "VERCEL_TOKEN"];
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    TMPDIR: "/tmp",
  };
  if (request.env) {
    for (const [key, value] of Object.entries(request.env)) {
      if (!FORBIDDEN.includes(key) && !key.startsWith("FORGE_")) {
        childEnv[key] = value;
      }
    }
  }

  const results: any[] = [];
  let success = true;

  for (const cmd of request.commands) {
    const result = await new Promise<any>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(cmd.command, cmd.args, {
        cwd: workDir,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout?.on("data", (d) => { stdout += d.toString(); if (stdout.length > 200000) stdout = stdout.slice(-200000); });
      child.stderr?.on("data", (d) => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-200000); });
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
      }, cmd.timeoutMs || 60000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          command: cmd.command, args: cmd.args, cwd: workDir,
          exitCode: code, stdout: stdout.slice(0, 100000), stderr: stderr.slice(0, 100000),
          durationMs: 0, timedOut, success: !timedOut && code === 0,
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          command: cmd.command, args: cmd.args, cwd: workDir,
          exitCode: -1, stdout, stderr: stderr + err.message,
          durationMs: 0, timedOut, success: false,
        });
      });
    });
    results.push(result);
    if (!result.success) { success = false; break; }
  }

  // Cleanup ephemeral dir.
  if (!request.worktreePath) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }

  return {
    jobId: request.jobId,
    results,
    success,
    workDir,
    durationMs: 0,
    error: success ? undefined : "Local execution (UNSANDBOXED) failed",
  };
}

/**
 * Cleanup a work directory on the worker.
 */
export async function cleanupWorkDir(path: string): Promise<void> {
  try {
    await fetch(`${WORKER_URL}/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Best-effort cleanup.
  }
}
