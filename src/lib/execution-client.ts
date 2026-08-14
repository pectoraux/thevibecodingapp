// Forge — execution client (Phase 4: authenticated).
//
// The control plane signs job tokens with HMAC-SHA256 using FORGE_WORKER_SECRET.
// The worker verifies the signature before executing anything.
//
// Flow:
//   1. Control plane creates a sandbox via POST /sandbox (gets sandboxId)
//   2. Control plane submits execution via POST /execute (with sandboxId + signed token)
//   3. Control plane destroys sandbox via DELETE /sandbox/{id}
//
// The client NEVER specifies a filesystem path. The worker controls paths.

import { createHmac, randomUUID } from "node:crypto";
import { FORGE_EXECUTION_MODE } from "@/lib/execution-mode";

const WORKER_URL = process.env.FORGE_EXECUTION_WORKER_URL || "http://localhost:3001";
const WORKER_SECRET = process.env.FORGE_WORKER_SECRET;

if (!WORKER_SECRET && FORGE_EXECUTION_MODE === "sandbox") {
  console.error("[forge-execution-client] FATAL: FORGE_WORKER_SECRET not set in sandbox mode");
}

interface JobToken {
  jobId: string;
  projectId: string;
  attempt: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
}

function signToken(payload: Omit<JobToken, "signature">): string {
  const data = `${payload.jobId}.${payload.projectId}.${payload.attempt}.${payload.issuedAt}.${payload.expiresAt}.${payload.nonce}`;
  return createHmac("sha256", WORKER_SECRET || "").update(data).digest("hex");
}

function createToken(jobId: string, projectId: string, attempt: number): JobToken {
  const now = Date.now();
  const payload: Omit<JobToken, "signature"> = {
    jobId,
    projectId,
    attempt,
    issuedAt: now,
    expiresAt: now + 300000, // 5-minute validity
    nonce: randomUUID(),
  };
  return { ...payload, signature: signToken(payload) };
}

function tokenToHeader(token: JobToken): string {
  const encoded = Buffer.from(JSON.stringify(token)).toString("base64");
  return `Bearer ${encoded}`;
}

/**
 * Check if the execution worker is available and authenticated.
 */
export async function isExecutionWorkerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Create a sandbox on the worker. Returns the sandboxId.
 * The workspace path is server-controlled — the client cannot specify it.
 */
export async function createSandbox(projectId: string, jobId: string, attempt: number): Promise<{ sandboxId: string; workspacePath: string }> {
  const token = createToken(jobId, projectId, attempt);
  const res = await fetch(`${WORKER_URL}/sandbox`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": tokenToHeader(token),
    },
    body: JSON.stringify({ projectId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Failed to create sandbox: HTTP ${res.status}: ${await res.text()}`);
  }
  return await res.json() as any;
}

/**
 * Destroy a sandbox on the worker.
 */
export async function destroySandbox(sandboxId: string, projectId: string, jobId: string, attempt: number): Promise<void> {
  const token = createToken(jobId, projectId, attempt);
  try {
    await fetch(`${WORKER_URL}/sandbox/${sandboxId}`, {
      method: "DELETE",
      headers: { "Authorization": tokenToHeader(token) },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Best-effort cleanup.
  }
}

export interface ExecutionJobRequest {
  jobId: string;
  projectId: string;
  attempt: number;
  sandboxId: string; // REQUIRED — created via createSandbox()
  commands: { command: string; args: string[]; timeoutMs?: number }[];
  env?: Record<string, string>;
  files?: { path: string; content: string }[]; // paths are contained by the worker
  timeoutMs?: number;
}

export interface ExecutionJobResponse {
  jobId: string;
  sandboxId: string;
  results: any[];
  success: boolean;
  error?: string;
  workDir: string;
  durationMs: number;
}

/**
 * Submit an execution job to the isolated, authenticated worker.
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

  const token = createToken(request.jobId, request.projectId, request.attempt);
  const res = await fetch(`${WORKER_URL}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": tokenToHeader(token),
    },
    body: JSON.stringify({
      sandboxId: request.sandboxId,
      commands: request.commands,
      env: request.env,
      files: request.files,
    }),
    signal: AbortSignal.timeout(request.timeoutMs || 300000),
  });

  if (res.status === 401) throw new Error("Worker rejected token: unauthorized");
  if (res.status === 403) throw new Error(`Worker rejected token: ${await res.text()}`);
  if (!res.ok) throw new Error(`Execution worker HTTP ${res.status}: ${await res.text()}`);

  return await res.json() as ExecutionJobResponse;
}

/**
 * Local execution fallback — UNSANDBOXED, dev only.
 * Production must use sandbox mode.
 */
async function localExecutionFallback(request: ExecutionJobRequest): Promise<ExecutionJobResponse> {
  const { spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");

  const workDir = join("/tmp/forge-exec-local", request.jobId || randomUUID());
  try { mkdirSync(workDir, { recursive: true }); } catch {}

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

  const FORBIDDEN = ["DATABASE_URL", "DIRECT_URL", "NEXTAUTH_SECRET", "FORGE_MASTER_KEY", "FORGE_SECRET", "FORGE_WORKER_SECRET", "GITHUB_PAT", "GITHUB_TOKEN", "VERCEL_TOKEN"];
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
      const child = spawn(cmd.command, cmd.args, { cwd: workDir, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout?.on("data", (d) => { stdout += d.toString(); if (stdout.length > 200000) stdout = stdout.slice(-200000); });
      child.stderr?.on("data", (d) => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-200000); });
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
      }, cmd.timeoutMs || 60000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ command: cmd.command, args: cmd.args, cwd: workDir, exitCode: code, stdout: stdout.slice(0, 100000), stderr: stderr.slice(0, 100000), durationMs: 0, timedOut, success: !timedOut && code === 0 });
      });
      child.on("error", (err) => { clearTimeout(timer); resolve({ command: cmd.command, args: cmd.args, cwd: workDir, exitCode: -1, stdout, stderr: stderr + err.message, durationMs: 0, timedOut, success: false }); });
    });
    results.push(result);
    if (!result.success) { success = false; break; }
  }

  if (!request.sandboxId) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }

  return { jobId: request.jobId, sandboxId: "local", results, success, workDir, durationMs: 0, error: success ? undefined : "Local execution (UNSANDBOXED) failed" };
}
