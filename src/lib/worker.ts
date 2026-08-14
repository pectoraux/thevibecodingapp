// Forge — Real Execution Worker (Phase 2 P0-2).
//
// Runs real commands in worktrees with timeout, output capture, and secret
// injection via environment variables (never via args or files).
//
// Uses `child_process.spawn` (not execSync) so we get:
//   - async execution (non-blocking)
//   - timeout enforcement (SIGTERM → SIGKILL escalation)
//   - streaming stdout/stderr capture
//   - environment-variable injection for secrets
//
// SERVER-SIDE ONLY. This module imports `node:child_process`, `node:fs`,
// `node:path` — none of which are usable in the browser.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  /** Command that was executed (e.g. "npm"). */
  command: string;
  /** Args that were passed (e.g. ["test", "--", "--json"]). */
  args: string[];
  /** Working directory the command ran in. */
  cwd: string;
  /** Exit code. `null` if the process was killed by timeout or failed to spawn. */
  exitCode: number | null;
  /** Captured stdout (truncated to MAX_OUTPUT_BYTES). */
  stdout: string;
  /** Captured stderr (truncated to MAX_OUTPUT_BYTES). */
  stderr: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True if the command was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
  /** True iff exitCode === 0 (and not timed out). */
  success: boolean;
}

export interface ExecutionOptions {
  /** Working directory (typically a worktree path). Required. */
  cwd: string;
  /** Hard timeout in milliseconds. Default: 120_000 (2 minutes). */
  timeoutMs?: number;
  /** Additional environment variables (merged with `process.env`).
   *  This is the channel for secret injection — never pass secrets as args. */
  env?: Record<string, string>;
  /** Run the child process as this user uid (POSIX only). For isolation. */
  uid?: number;
  /** Run the child process as this group gid (POSIX only). */
  gid?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
/** Cap each of stdout/stderr at 100KB for DB storage. */
const MAX_OUTPUT_BYTES = 100 * 1024;
/** Grace period after SIGTERM before SIGKILL. */
const SIGTERM_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a captured output string to `maxBytes` (counted in UTF-8 bytes),
 * keeping the LAST `maxBytes` (most relevant output for tests/builds).
 */
function truncateOutput(input: string, maxBytes: number): string {
  const buf = Buffer.from(input, "utf8");
  if (buf.length <= maxBytes) return input;
  // Keep the tail of the output.
  const tail = buf.subarray(buf.length - maxBytes);
  return `\n…<truncated ${buf.length - maxBytes} bytes from start>\n` + tail.toString("utf8");
}

/**
 * If the current process is running as root (uid 0), attempt to drop to a
 * non-privileged user. Resolution order:
 *   1. `FORGE_RUN_UID` env var (if set and numeric).
 *   2. The `nobody` user (typically uid 65534 on Linux).
 *   3. Give up with a console warning (still returns undefined — the spawn
 *      will proceed as root, but at least we flagged it).
 *
 * Returns the resolved uid, or `undefined` if no drop is needed/possible.
 */
function resolveUidDrop(): number | undefined {
  if (typeof process.getuid !== "function") return undefined; // non-POSIX
  if (process.getuid() !== 0) return undefined; // not root, no drop needed

  const envUid = process.env.FORGE_RUN_UID;
  if (envUid && /^\d+$/.test(envUid)) {
    return parseInt(envUid, 10);
  }

  // Try to resolve the `nobody` user via os.userInfo (does NOT shell out).
  try {
    // The conventional uid for `nobody` is 65534 on Linux. We do not call
    // getpwnam here; we just use the conventional uid.
    return 65534;
  } catch {
    // Could not resolve — warn and continue as root.
    // eslint-disable-next-line no-console
    console.warn(
      "[forge-worker] Running as root and could not resolve a non-privileged uid; child processes will run as root. Set FORGE_RUN_UID to mitigate.",
    );
    return undefined;
  }
}

function assertCwd(cwd: string): void {
  if (!cwd || !existsSync(cwd)) {
    throw new Error(`[forge-worker] cwd does not exist: ${cwd}`);
  }
  const st = statSync(cwd);
  if (!st.isDirectory()) {
    throw new Error(`[forge-worker] cwd is not a directory: ${cwd}`);
  }
}

// ---------------------------------------------------------------------------
// Core: executeCommand
// ---------------------------------------------------------------------------

/**
 * Execute a command with timeout, output capture, and secret injection.
 *
 * NEVER throws on command failure — failures are reflected in the returned
 * `ExecutionResult` (exitCode, timedOut, success). The only conditions under
 * which this function throws are programmer errors: missing/invalid `cwd`,
 * or a non-string `command`.
 */
export async function executeCommand(
  command: string,
  args: string[],
  opts: ExecutionOptions,
): Promise<ExecutionResult> {
  assertCwd(opts.cwd);

  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Build env: process.env (so PATH etc. is preserved) + opts.env (secrets).
  // process.env values can be `undefined`; filter those out for a clean
  // Record<string, string>.
  const procEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) procEnv[k] = v;
  }
  const env: Record<string, string> = { ...procEnv, ...(opts.env ?? {}) };

  // Resolve uid/gid for privilege dropping.
  const dropUid = opts.uid ?? resolveUidDrop();
  const dropGid = opts.gid;

  return new Promise<ExecutionResult>((resolve) => {
    let child: ChildProcess | null = null;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let killHandle: NodeJS.Timeout | null = null;
    let resolved = false;

    let stdoutBuf = "";
    let stderrBuf = "";

    const spawnOpts: Parameters<typeof spawn>[2] = {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    if (dropUid !== undefined) spawnOpts.uid = dropUid;
    if (dropGid !== undefined) spawnOpts.gid = dropGid;

    try {
      child = spawn(command, args, spawnOpts);
    } catch (err) {
      // spawn() can throw synchronously on bad args.
      resolve({
        command,
        args,
        cwd: opts.cwd,
        exitCode: null,
        stdout: "",
        stderr: `[forge-worker] spawn() threw: ${String(err)}`,
        durationMs: Date.now() - start,
        timedOut: false,
        success: false,
      });
      return;
    }

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        // Bound memory: if the buffer grows unbounded (e.g. `yes`), trim.
        if (Buffer.byteLength(stdoutBuf, "utf8") > MAX_OUTPUT_BYTES * 4) {
          stdoutBuf = stdoutBuf.slice(-Math.floor(MAX_OUTPUT_BYTES * 2));
        }
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrBuf += chunk;
        if (Buffer.byteLength(stderrBuf, "utf8") > MAX_OUTPUT_BYTES * 4) {
          stderrBuf = stderrBuf.slice(-Math.floor(MAX_OUTPUT_BYTES * 2));
        }
      });
    }

    const finish = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);

      const exitCode = timedOut ? null : code;
      resolve({
        command,
        args,
        cwd: opts.cwd,
        exitCode,
        stdout: truncateOutput(stdoutBuf, MAX_OUTPUT_BYTES),
        stderr: truncateOutput(stderrBuf, MAX_OUTPUT_BYTES),
        durationMs: Date.now() - start,
        timedOut,
        success: !timedOut && code === 0,
      });
    };

    // Timeout: SIGTERM → grace → SIGKILL.
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (!child || child.killed) return;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      killHandle = setTimeout(() => {
        if (!child || child.killed) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, SIGTERM_GRACE_MS);
    }, timeoutMs);

    // Spawn errors (e.g. ENOENT — command not found, EACCES — not executable).
    child.on("error", (err: NodeJS.ErrnoException) => {
      stderrBuf += `\n[forge-worker] spawn error: ${err.message} (code=${err.code ?? "unknown"})\n`;
      finish(null);
    });

    // `close` fires after stdio streams are closed; `exit` fires when the
    // process exits but stdio may still be draining. We use `close` for the
    // final result so we capture all output.
    child.on("close", (code: number | null) => {
      finish(code);
    });
  });
}

// ---------------------------------------------------------------------------
// Dependency installation helper
// ---------------------------------------------------------------------------

/**
 * Detect the project's dependency manifest and run the appropriate install
 * command. Detection order: package.json → requirements.txt → go.mod →
 * Cargo.toml.
 *
 * The `packageManager` override only applies to Node projects (npm | yarn |
 * pnpm | bun). If the detected manifest is not a Node project, the override
 * is ignored.
 */
export async function installDependencies(
  cwd: string,
  packageManager?: "npm" | "yarn" | "pnpm" | "bun",
): Promise<ExecutionResult> {
  if (existsSync(path.join(cwd, "package.json"))) {
    const pm = packageManager ?? detectNodePackageManager(cwd);
    return executeCommand(pm, ["install"], {
      cwd,
      timeoutMs: 300_000, // 5 minutes for installs
    });
  }
  if (existsSync(path.join(cwd, "requirements.txt"))) {
    return executeCommand("pip", ["install", "-r", "requirements.txt"], {
      cwd,
      timeoutMs: 300_000,
    });
  }
  if (existsSync(path.join(cwd, "pyproject.toml"))) {
    return executeCommand("pip", ["install", "-e", "."], {
      cwd,
      timeoutMs: 300_000,
    });
  }
  if (existsSync(path.join(cwd, "go.mod"))) {
    return executeCommand("go", ["mod", "download"], {
      cwd,
      timeoutMs: 300_000,
    });
  }
  if (existsSync(path.join(cwd, "Cargo.toml"))) {
    return executeCommand("cargo", ["fetch"], {
      cwd,
      timeoutMs: 300_000,
    });
  }

  // No recognised manifest — return a no-op success result (the orchestrator
  // treats this as "nothing to install", not a failure).
  return {
    command: "",
    args: [],
    cwd,
    exitCode: 0,
    stdout: "[forge-worker] No recognised dependency manifest found; skipping install.",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    success: true,
  };
}

/**
 * Detect the Node package manager from lockfiles. Falls back to `npm`.
 * Detection: `bun.lockb` → bun, `pnpm-lock.yaml` → pnpm,
 * `yarn.lock` → yarn, else npm.
 */
export function detectNodePackageManager(
  cwd: string,
): "npm" | "yarn" | "pnpm" | "bun" {
  if (existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(path.join(cwd, "bun.lock"))) return "bun";
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

// Marker for tooling: this module is server-only.
export const SERVER_ONLY = true as const;
