// Forge Execution Worker — Phase 4 (Hardened)
//
// SECURITY PROPERTIES (enforced by architecture, not by UI warnings):
//
// 1. AUTHENTICATION: Every /execute request must carry an HMAC-SHA256 signed
//    job token. The worker verifies the signature using a shared secret
//    (FORGE_WORKER_SECRET). Unauthenticated requests get 401.
//
// 2. NO CORS: The worker sets NO Access-Control-Allow-Origin header. It is a
//    backend service, not a browser API. Browser clients cannot call it.
//
// 3. SERVER-CONTROLLED WORKSPACES: The client CANNOT specify worktreePath.
//    The worker generates a sandboxId and workspacePath internally. The
//    client only sends a sandboxId (which the worker validates).
//
// 4. PATH CONTAINEMENT: All file writes are contained within the sandbox
//    root. Path traversal (../), absolute paths, and symlink escapes are
//    rejected.
//
// 5. ENV ALLOWLIST: Child processes receive ONLY an explicit allowlist of
//    env vars. Platform secrets (DATABASE_URL, FORGE_MASTER_KEY, etc.) are
//    forbidden and silently dropped.
//
// 6. COMMAND POLICY: Commands are validated against a blocklist (fork bombs,
//    shutdown/reboot, mount, kernel manipulation, device access).
//
// ISOLATION LEVEL: Process-level + filesystem-level.
// This is NOT container-level isolation. The worker documents this honestly.
// Production should use a stronger substrate (Vercel Sandbox, containers,
// microVMs). This worker is suitable for LOCAL_UNSANDBOXED dev mode only.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, realpathSync, existsSync, lstatSync } from "node:fs";
import { join, dirname, resolve, normalize, isAbsolute } from "node:path";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";

const PORT = parseInt(process.env.FORGE_WORKER_PORT || "3001", 10);
const EXEC_ROOT = process.env.FORGE_EXEC_ROOT || "/tmp/forge-exec";
const WORKER_SECRET = process.env.FORGE_WORKER_SECRET;

if (!WORKER_SECRET) {
  console.error("[forge-execution-worker] FATAL: FORGE_WORKER_SECRET is not set.");
  console.error("[forge-execution-worker] The worker cannot start without a shared secret for authentication.");
  console.error("[forge-execution-worker] Set FORGE_WORKER_SECRET in the worker's environment (not the control plane's).");
  process.exit(1);
}

// Ensure exec root exists.
try { mkdirSync(EXEC_ROOT, { recursive: true }); } catch {}

// ---------------------------------------------------------------------------
// Token verification — HMAC-SHA256 signed job tokens
// ---------------------------------------------------------------------------

interface JobToken {
  jobId: string;
  projectId: string;
  attempt: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
}

function signToken(token: Omit<JobToken, "signature">): string {
  const payload = `${token.jobId}.${token.projectId}.${token.attempt}.${token.issuedAt}.${token.expiresAt}.${token.nonce}`;
  return createHmac("sha256", WORKER_SECRET).update(payload).digest("hex");
}

function verifyToken(token: JobToken): { valid: boolean; reason?: string } {
  // Check expiry.
  const now = Date.now();
  if (now > token.expiresAt) {
    return { valid: false, reason: "Token expired" };
  }
  // Check signature.
  const expectedSignature = signToken({
    jobId: token.jobId,
    projectId: token.projectId,
    attempt: token.attempt,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
    nonce: token.nonce,
  });
  const a = Buffer.from(token.signature, "hex");
  const b = Buffer.from(expectedSignature, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "Invalid signature" };
  }
  return { valid: true };
}

function extractToken(req: IncomingMessage): JobToken | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const tokenStr = auth.slice(7);
  try {
    const token = JSON.parse(Buffer.from(tokenStr, "base64").toString("utf-8"));
    if (!token.jobId || !token.projectId || !token.signature) return null;
    return token as JobToken;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sandbox management — server-controlled workspace paths
// ---------------------------------------------------------------------------

interface Sandbox {
  id: string;
  projectId: string;
  workspacePath: string;
  createdAt: number;
}

const activeSandboxes = new Map<string, Sandbox>();

function createSandbox(sandboxId: string, projectId: string): Sandbox {
  // Server-generated path — client cannot control this.
  const workspacePath = join(EXEC_ROOT, projectId, sandboxId);
  mkdirSync(workspacePath, { recursive: true });
  const sandbox: Sandbox = { id: sandboxId, projectId, workspacePath, createdAt: Date.now() };
  activeSandboxes.set(sandboxId, sandbox);
  return sandbox;
}

function getSandbox(sandboxId: string, projectId: string): Sandbox | null {
  const sandbox = activeSandboxes.get(sandboxId);
  if (!sandbox) return null;
  // Verify the sandbox belongs to the claimed project (tenant isolation).
  if (sandbox.projectId !== projectId) return null;
  return sandbox;
}

function destroySandbox(sandboxId: string): void {
  const sandbox = activeSandboxes.get(sandboxId);
  if (sandbox) {
    try { rmSync(sandbox.workspacePath, { recursive: true, force: true }); } catch {}
    activeSandboxes.delete(sandboxId);
  }
}

// ---------------------------------------------------------------------------
// Path containment — prevent traversal, absolute paths, symlink escapes
// ---------------------------------------------------------------------------

function isPathSafe(sandboxRoot: string, requestedPath: string): { safe: boolean; resolved?: string; reason?: string } {
  // Reject absolute paths.
  if (isAbsolute(requestedPath)) {
    return { safe: false, reason: "Absolute paths are not allowed" };
  }
  // Reject null bytes.
  if (requestedPath.includes("\0")) {
    return { safe: false, reason: "Null bytes in path" };
  }
  // Resolve the full path.
  const fullResolved = resolve(sandboxRoot, requestedPath);
  const rootResolved = resolve(sandboxRoot);
  // Check containment.
  if (!fullResolved.startsWith(rootResolved + "/") && fullResolved !== rootResolved) {
    return { safe: false, reason: "Path escapes sandbox root" };
  }
  // Check for symlink escape — if the file exists and is a symlink, resolve it
  // and verify the target is still inside the sandbox.
  try {
    if (existsSync(fullResolved)) {
      const real = realpathSync(fullResolved);
      const realRoot = realpathSync(rootResolved);
      if (!real.startsWith(realRoot + "/") && real !== realRoot) {
        return { safe: false, reason: "Symlink escape detected" };
      }
    }
  } catch {
    // File doesn't exist yet — that's fine for writes.
  }
  return { safe: true, resolved: fullResolved };
}

// ---------------------------------------------------------------------------
// Environment allowlist — child processes never get platform secrets
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

const FORBIDDEN_ENV_KEYS = [
  "DATABASE_URL",
  "DIRECT_URL",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "FORGE_MASTER_KEY",
  "FORGE_SECRET",
  "FORGE_WORKER_SECRET",
  "GITHUB_PAT",
  "GITHUB_TOKEN",
  "GITHUB_USERNAME",
  "VERCEL_TOKEN",
  "FORGE_EXECUTION_WORKER_URL",
];

function buildChildEnv(jobEnv: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    USER: process.env.USER || "nobody",
    SHELL: process.env.SHELL || "/bin/bash",
    LANG: process.env.LANG || "en_US.UTF-8",
    TERM: process.env.TERM || "xterm-256color",
    TMPDIR: "/tmp",
  };
  if (jobEnv) {
    for (const [key, value] of Object.entries(jobEnv)) {
      if (FORBIDDEN_ENV_KEYS.includes(key)) continue;
      if (key.startsWith("FORGE_")) continue;
      if (ALLOWED_ENV_KEYS.has(key) || key.endsWith("_TEST")) {
        base[key] = value;
      }
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Command policy — reject dangerous commands (defense in depth)
// ---------------------------------------------------------------------------

const FORBIDDEN_COMMANDS = [
  "shutdown", "reboot", "halt", "poweroff", "init",
  "mount", "umount",
  "mkfs", "fdisk", "parted",
  "dd",  // can overwrite disks
  "sysctl",
  "modprobe", "insmod", "rmmod",
  "systemctl", "service",
  "chmod", // can change permissions to escape
];

const FORBIDDEN_ARG_PATTERNS = [
  /:\s*\(\s*\)\s*\{/,  // fork bomb :(){:|:&};:
  /fork\s+bomb/i,
  /:\s*\{\s*:.*\&/,  // another fork bomb variant
  /\/dev\/sd[a-z]/,  // raw disk access
  /\/dev\/mem/,
  /\/dev\/kmem/,
  /\/proc\/sys/,
  /\/sys\/(?!class\/)/,  // sysfs (but allow /sys/class for hardware info)
  /rm\s+-rf\s+\//,  // recursive delete from root
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\binit\s+[06]\b/,
];

function validateCommand(command: string, args: string[]): { allowed: boolean; reason?: string } {
  // Check command against blocklist.
  const baseCmd = command.split("/").pop() || command;
  if (FORBIDDEN_COMMANDS.includes(baseCmd)) {
    return { allowed: false, reason: `Command '${baseCmd}' is blocked by policy` };
  }
  // Check args for dangerous patterns.
  const argStr = args.join(" ");
  for (const pattern of FORBIDDEN_ARG_PATTERNS) {
    if (pattern.test(argStr)) {
      return { allowed: false, reason: `Command args match blocked pattern: ${pattern.source}` };
    }
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Command execution with timeout + output capture + resource limits
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

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      // Resource limits (where supported by the OS):
      // Note: Node doesn't expose rlimit directly; these are best-effort.
    });

    let stdoutLen = 0;
    let stderrLen = 0;
    const MAX_OUTPUT = 200000; // 200KB per stream

    child.stdout?.on("data", (data) => {
      stdoutLen += data.length;
      if (stdoutLen <= MAX_OUTPUT) stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderrLen += data.length;
      if (stderrLen <= MAX_OUTPUT) stderr += data.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
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
        stdout: stdout.slice(0, 100000),
        stderr: stderr.slice(0, 100000),
        durationMs: Date.now() - start,
        timedOut,
        success: !timedOut && code === 0,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        command, args, cwd,
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
// HTTP server — authenticated, no CORS
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: any) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  // NO CORS HEADERS. This is a backend service, not a browser API.
  // Browser clients cannot call this worker.

  const url = req.url || "";

  // Public health check (no secrets exposed).
  if (url === "/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      service: "forge-execution-worker",
      version: "phase4",
      mode: "authenticated",
    });
    return;
  }

  // Security audit — REQUIRES AUTHENTICATION (was public in Phase 3).
  if (url === "/security-audit" && req.method === "GET") {
    const token = extractToken(req);
    if (!token) return sendJson(res, 401, { error: "Authentication required" });
    const verification = verifyToken(token);
    if (!verification.valid) return sendJson(res, 403, { error: verification.reason });

    const leaked = FORBIDDEN_ENV_KEYS.filter(k => !!process.env[k]);
    sendJson(res, 200, {
      leakedEnvKeys: leaked,
      isIsolated: leaked.length === 0,
      activeSandboxes: activeSandboxes.size,
      message: leaked.length === 0
        ? "Worker process has no platform secrets"
        : `WARNING: ${leaked.length} platform secret(s) detected: ${leaked.join(", ")}`,
    });
    return;
  }

  // Create sandbox — REQUIRES AUTHENTICATION.
  if (url === "/sandbox" && req.method === "POST") {
    const token = extractToken(req);
    if (!token) return sendJson(res, 401, { error: "Authentication required" });
    const verification = verifyToken(token);
    if (!verification.valid) return sendJson(res, 403, { error: verification.reason });

    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try {
        const { projectId } = JSON.parse(body);
        if (!projectId) return sendJson(res, 400, { error: "projectId required" });
        const sandboxId = randomUUID();
        const sandbox = createSandbox(sandboxId, projectId);
        sendJson(res, 200, { sandboxId, workspacePath: sandbox.workspacePath });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  // Execute job — REQUIRES AUTHENTICATION.
  if (url === "/execute" && req.method === "POST") {
    const token = extractToken(req);
    if (!token) return sendJson(res, 401, { error: "Authentication required" });
    const verification = verifyToken(token);
    if (!verification.valid) return sendJson(res, 403, { error: verification.reason });

    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 50e6) req.destroy(); }); // 50MB max
    req.on("end", async () => {
      try {
        const job = JSON.parse(body);

        // Validate sandboxId — the client must provide a sandbox created via /sandbox.
        // The client CANNOT specify worktreePath.
        if (!job.sandboxId) {
          return sendJson(res, 400, { error: "sandboxId required (create a sandbox first via POST /sandbox)" });
        }
        const sandbox = getSandbox(job.sandboxId, token.projectId);
        if (!sandbox) {
          return sendJson(res, 403, { error: "Sandbox not found or does not belong to this project" });
        }

        // Write files (with path containment).
        if (job.files) {
          for (const f of job.files) {
            const pathCheck = isPathSafe(sandbox.workspacePath, f.path);
            if (!pathCheck.safe) {
              return sendJson(res, 400, { error: `Path rejected: ${f.path} — ${pathCheck.reason}` });
            }
            try {
              mkdirSync(dirname(pathCheck.resolved!), { recursive: true });
              writeFileSync(pathCheck.resolved!, f.content);
            } catch (err: any) {
              return sendJson(res, 500, { error: `Failed to write ${f.path}: ${err.message}` });
            }
          }
        }

        // Validate + execute commands.
        const childEnv = buildChildEnv(job.env);
        const results: ExecutionResult[] = [];
        let jobSuccess = true;

        for (const cmd of job.commands || []) {
          // Command policy validation.
          const cmdCheck = validateCommand(cmd.command, cmd.args || []);
          if (!cmdCheck.allowed) {
            results.push({
              command: cmd.command, args: cmd.args || [], cwd: sandbox.workspacePath,
              exitCode: -1, stdout: "", stderr: `Command blocked: ${cmdCheck.reason}`,
              durationMs: 0, timedOut: false, success: false,
            });
            jobSuccess = false;
            break;
          }

          const result = await executeCommand(
            cmd.command, cmd.args || [], sandbox.workspacePath, childEnv,
            cmd.timeoutMs || 60000
          );
          results.push(result);
          if (!result.success) { jobSuccess = false; break; }
        }

        sendJson(res, 200, {
          jobId: token.jobId,
          sandboxId: sandbox.id,
          results,
          success: jobSuccess,
          workDir: sandbox.workspacePath,
          durationMs: results.reduce((s, r) => s + r.durationMs, 0),
        });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  // Destroy sandbox — REQUIRES AUTHENTICATION.
  if (url.startsWith("/sandbox/") && req.method === "DELETE") {
    const token = extractToken(req);
    if (!token) return sendJson(res, 401, { error: "Authentication required" });
    const verification = verifyToken(token);
    if (!verification.valid) return sendJson(res, 403, { error: verification.reason });

    const sandboxId = url.split("/sandbox/")[1];
    const sandbox = getSandbox(sandboxId, token.projectId);
    if (!sandbox) return sendJson(res, 404, { error: "Sandbox not found" });
    destroySandbox(sandboxId);
    sendJson(res, 200, { ok: true });
    return;
  }

  // All other routes → 404.
  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[forge-execution-worker] listening on port ${PORT}`);
  console.log(`[forge-execution-worker] version: phase4 (authenticated)`);
  console.log(`[forge-execution-worker] exec root: ${EXEC_ROOT}`);
  console.log(`[forge-execution-worker] authentication: HMAC-SHA256 signed job tokens`);
  console.log(`[forge-execution-worker] CORS: disabled (backend service only)`);
  console.log(`[forge-execution-worker] server-controlled workspaces: enabled`);
  console.log(`[forge-execution-worker] path containment: enabled`);

  const leaked = FORBIDDEN_ENV_KEYS.filter(k => !!process.env[k]);
  if (leaked.length > 0) {
    console.warn(`[forge-execution-worker] WARNING: platform secrets in worker env: ${leaked.join(", ")}`);
  } else {
    console.log(`[forge-execution-worker] ✓ No platform secrets in worker environment`);
  }
});
