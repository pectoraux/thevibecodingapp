// Forge Execution Worker — Phase 3
//
// This is the EXECUTION PLANE. It runs as a separate process from the
// Next.js control plane. It receives job requests via HTTP and executes
// commands in isolated filesystem directories with a restricted environment.
//
// CRITICAL SECURITY PROPERTIES:
// 1. This process does NOT inherit the control plane's environment variables.
//    It only receives an explicit allowlist per job.
// 2. It does NOT have access to DATABASE_URL, NEXTAUTH_SECRET,
//    FORGE_MASTER_KEY, GITHUB_PAT, or any other platform credential.
// 3. Each job runs in its own /tmp/forge-exec-{jobId}/ directory.
// 4. Commands are executed with timeout + SIGTERM/SIGKILL escalation.
// 5. Output is captured and returned to the control plane.
//
// ISOLATION LEVEL: Process-level + filesystem-level.
// This is NOT container-level isolation (no Docker available in this env).
// The spec acknowledges this as a limitation — it's real process isolation,
// not simulation, but not as strong as container/microVM isolation.
// FORGE_EXECUTION_MODE=local in dev, =sandbox when a real sandbox is available.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = 3001;
const EXEC_ROOT = "/tmp/forge-exec";

// Ensure exec root exists.
try { mkdirSync(EXEC_ROOT, { recursive: true }); } catch {}

// ---------------------------------------------------------------------------
// ALLOWLIST of environment variables the worker MAY receive.
// The control plane sends these explicitly per job.
// The worker NEVER inherits its own process.env into child processes.
// ---------------------------------------------------------------------------

const ALLOWED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "NODE_ENV",
  // Project-scoped test credentials (injected by control plane):
  "DATABASE_URL_TEST",
  "JWT_SECRET_TEST",
  "STRIPE_SECRET_KEY_TEST",
  "STRIPE_WEBHOOK_SECRET_TEST",
  "SENDGRID_API_KEY_TEST",
  // Package manager registries:
  "npm_config_registry",
  "NPM_CONFIG_REGISTRY",
]);

// FORBIDDEN keys that must NEVER be passed to child processes.
const FORBIDDEN_ENV_KEYS = [
  "DATABASE_URL",
  "DIRECT_URL",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "FORGE_MASTER_KEY",
  "FORGE_SECRET",
  "GITHUB_PAT",
  "GITHUB_TOKEN",
  "GITHUB_USERNAME",
  "VERCEL_TOKEN",
  "FORGE_EXECUTION_WORKER_URL",
];

function buildChildEnv(jobEnv: Record<string, string> | undefined): Record<string, string> {
  // Start with a MINIMAL base — NOT process.env.
  const base: Record<string, string> = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    USER: process.env.USER || "nobody",
    SHELL: process.env.SHELL || "/bin/bash",
    LANG: process.env.LANG || "en_US.UTF-8",
    TERM: process.env.TERM || "xterm-256color",
    TMPDIR: "/tmp",
  };

  // Merge only allowed keys from the job's env.
  if (jobEnv) {
    for (const [key, value] of Object.entries(jobEnv)) {
      if (FORBIDDEN_ENV_KEYS.includes(key)) {
        // Silently drop forbidden keys — never expose platform secrets.
        continue;
      }
      if (ALLOWED_ENV_KEYS.has(key) || key.endsWith("_TEST")) {
        base[key] = value;
      }
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// Command execution with timeout + output capture
// ---------------------------------------------------------------------------

interface ExecutionResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  success: boolean;
}

async function executeCommand(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number = 120000
): Promise<ExecutionResult> {
  const start = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;

    const child = spawn(command, args, {
      cwd,
      env, // ONLY the explicit allowlist — NOT process.env
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
      if (stdout.length > 200000) stdout = stdout.slice(-200000); // keep last 200KB
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      try { child.kill("SIGTERM"); } catch {}
      // Force kill after 5s if still alive.
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 5000);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command,
        args,
        cwd,
        exitCode: code,
        stdout: stdout.slice(0, 100000), // 100KB max for response
        stderr: stderr.slice(0, 100000),
        durationMs: Date.now() - start,
        timedOut,
        success: !timedOut && code === 0,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        command,
        args,
        cwd,
        exitCode: -1,
        stdout,
        stderr: stderr + "\n" + err.message,
        durationMs: Date.now() - start,
        timedOut,
        success: false,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

interface ExecutionJobRequest {
  jobId: string;
  projectId: string;
  commands: { command: string; args: string[]; timeoutMs?: number }[];
  worktreePath?: string; // if provided, use this path; else create ephemeral
  env?: Record<string, string>; // explicit allowlist only
  files?: { path: string; content: string }[]; // files to write before execution
  timeoutMs?: number; // total job timeout
}

interface ExecutionJobResponse {
  jobId: string;
  results: ExecutionResult[];
  success: boolean;
  error?: string;
  workDir: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  // CORS + JSON.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check.
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      service: "forge-execution-worker",
      mode: "isolated",
      envKeys: Object.keys(process.env).length,
      hasPlatformSecrets: FORBIDDEN_ENV_KEYS.some(k => !!process.env[k]),
    }));
    return;
  }

  // Verify env isolation (security test endpoint).
  if (req.url === "/security-audit" && req.method === "GET") {
    const leaked: string[] = [];
    for (const key of FORBIDDEN_ENV_KEYS) {
      if (process.env[key]) leaked.push(key);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      leakedEnvKeys: leaked,
      isIsolated: leaked.length === 0,
      message: leaked.length === 0
        ? "Worker process has no platform secrets in its environment"
        : `WARNING: Worker process has ${leaked.length} platform secret(s) in its environment: ${leaked.join(", ")}`,
    }));
    return;
  }

  // Execute job.
  if (req.url === "/execute" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 10e6) req.destroy(); });
    req.on("end", async () => {
      try {
        const job: ExecutionJobRequest = JSON.parse(body);
        const workDir = job.worktreePath || join(EXEC_ROOT, job.jobId || randomUUID());

        // Create work directory.
        try { mkdirSync(workDir, { recursive: true }); } catch {}

        // Write any provided files.
        if (job.files) {
          for (const f of job.files) {
            const fullPath = join(workDir, f.path);
            try {
              mkdirSync(dirname(fullPath), { recursive: true });
              writeFileSync(fullPath, f.content);
            } catch (err: any) {
              // Continue even if file write fails.
            }
          }
        }

        // Build the restricted environment.
        const childEnv = buildChildEnv(job.env);

        // Execute each command sequentially.
        const results: ExecutionResult[] = [];
        const jobStart = Date.now();
        let jobSuccess = true;

        for (const cmd of job.commands) {
          const result = await executeCommand(
            cmd.command,
            cmd.args,
            workDir,
            childEnv,
            cmd.timeoutMs || 60000
          );
          results.push(result);
          if (!result.success) {
            jobSuccess = false;
            break; // stop on first failure
          }
        }

        const response: ExecutionJobResponse = {
          jobId: job.jobId,
          results,
          success: jobSuccess,
          workDir,
          durationMs: Date.now() - jobStart,
        };

        // Cleanup ephemeral work dir (unless worktreePath was provided).
        if (!job.worktreePath) {
          try { rmSync(workDir, { recursive: true, force: true }); } catch {}
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message, success: false }));
      }
    });
    return;
  }

  // Cleanup endpoint — remove a work directory.
  if (req.url?.startsWith("/cleanup") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { path } = JSON.parse(body);
        if (path && path.startsWith(EXEC_ROOT)) {
          try { rmSync(path, { recursive: true, force: true }); } catch {}
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`[forge-execution-worker] listening on port ${PORT}`);
  console.log(`[forge-execution-worker] exec root: ${EXEC_ROOT}`);
  console.log(`[forge-execution-worker] mode: isolated (process-level)`);
  // Verify isolation on startup.
  const leaked = FORBIDDEN_ENV_KEYS.filter(k => !!process.env[k]);
  if (leaked.length > 0) {
    console.warn(`[forge-execution-worker] WARNING: platform secrets detected in worker env: ${leaked.join(", ")}`);
    console.warn(`[forge-execution-worker] These will NOT be passed to child processes, but their presence indicates the worker was started with the wrong environment.`);
  } else {
    console.log(`[forge-execution-worker] ✓ No platform secrets in worker environment`);
  }
});
