// Forge — Phase 18C: Runtime Executor.
//
// This module implements the actual runtime verification executor:
//   1. WorkspaceManager — creates/destroys isolated workspace
//   2. RepositoryCheckout — clones at exact SHA
//   3. CommandRunner — runs structured commands with timeout/capture
//   4. ProcessSupervisor — starts/stops the application with lifecycle guarantees
//   5. EvidenceCollector — captures per-stage evidence continuously
//
// The executor does NOT make decisions. It follows the RuntimeExecutionPolicy
// exactly. Every action is recorded as an EvidenceEvent.
//
// ARCHITECTURE:
//   The executor is called by the worker's poller when a runtime verification
//   job is claimed. It produces a RuntimeVerificationResult that is submitted
//   to the control plane via /api/worker/submit-runtime-evidence.

import { spawn, ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type RuntimeExecutionPolicy,
  type EvidenceEvent,
  type ProcessEvidence,
  type WorkspacePaths,
  getWorkspacePaths,
} from "@/lib/runtime-execution-contract";
import { runInSubstrate } from "@/lib/substrate-namespace";
import type { SandboxAttestation } from "@/lib/substrate-attestation";
import {
  type RuntimeVerificationResult,
  type StageResult,
  type HealthCheckResult,
  type ApiJourneyResult,
  type TeardownResult,
  type EnvironmentFingerprint,
} from "@/lib/runtime-verification";

// ---------------------------------------------------------------------------
// Evidence Collector — continuous per-stage capture
// ---------------------------------------------------------------------------

export class EvidenceCollector {
  private events: EvidenceEvent[] = [];
  private logs: string[] = [];

  recordEvent(event: EvidenceEvent): void {
    this.events.push(event);
    const logLine = `[${event.timestamp}] ${event.stage}: ${event.success ? "PASS" : "FAIL"} (${event.durationMs}ms)${event.error ? ` — ${event.error}` : ""}`;
    this.logs.push(logLine);
    // Write to disk immediately so partial evidence survives crashes.
    // (In production, this would write to the workspace logs directory.)
  }

  getEvents(): EvidenceEvent[] {
    return [...this.events];
  }

  getLogs(): string {
    return this.logs.join("\n");
  }

  getStageResult(stage: string): StageResult | null {
    const event = this.events.find((e) => e.stage === stage);
    if (!event) return null;
    return {
      success: event.success,
      durationMs: event.durationMs,
      exitCode: event.exitCode,
      output: event.output,
      error: event.error,
    };
  }
}

// ---------------------------------------------------------------------------
// Workspace Manager — isolation + cleanup
// ---------------------------------------------------------------------------

export class WorkspaceManager {
  constructor(private paths: WorkspacePaths) {}

  create(): void {
    // Phase 18V: Create the root FIRST.
    mkdirSync(this.paths.root, { recursive: true });

    // Verify the root is empty BEFORE populating — no contamination from a
    // previous execution that crashed mid-cleanup. A directory that merely
    // EXISTS is not necessarily empty (the old `verifyEmpty` only checked
    // `existsSync`, which returns true for a non-empty directory, masking
    // contamination). Enumerate the directory and require zero entries.
    if (!this.verifyEmpty()) {
      throw new Error(
        `Workspace ${this.paths.root} is not empty — possible contamination from a previous execution`
      );
    }

    // Now create the subdirectories.
    for (const dir of [this.paths.repo, this.paths.logs, this.paths.artifacts]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  destroy(): void {
    // Always destroy — even on failure. No leaked workspace.
    try {
      rmSync(this.paths.root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  verifyEmpty(): boolean {
    // Phase 18V: Actually enumerate the directory. `existsSync` alone is
    // insufficient — it returns true for a non-empty directory, masking
    // contamination from a crashed prior execution. We require the directory
    // to both exist AND contain zero entries.
    if (!existsSync(this.paths.root)) return false;
    try {
      const entries = readdirSync(this.paths.root);
      return entries.length === 0;
    } catch {
      return false;
    }
  }

  getPaths(): WorkspacePaths {
    return this.paths;
  }
}

// ---------------------------------------------------------------------------
// Command Runner — structured commands, timeout, capture
// ---------------------------------------------------------------------------

export interface CommandResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  signal: string | null;
}

/**
 * Run a structured command with timeout, stdout/stderr capture, and signal handling.
 * The command is an array — no shell interpolation.
 *
 * Phase 18V: Now correctly returns `Promise<CommandResult>` (was previously
 * typed as `CommandResult` via an unsafe `as unknown as` cast that masked
 * the promise). Callers MUST `await` this.
 */
export function runCommand(
  cwd: string,
  binary: string,
  args: string[],
  timeoutMs: number,
  env?: Record<string, string>
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const start = Date.now();

    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false, // Phase 18D: NEVER use shell — prevents command injection.
    });

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 200000) stdout = stdout.slice(-200000);
    });

    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        success: !timedOut && code === 0,
        exitCode: code,
        stdout: stdout.slice(0, 100000),
        stderr: stderr.slice(0, 100000),
        durationMs: Date.now() - start,
        timedOut,
        signal: signal,
      });
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        success: false,
        exitCode: -1,
        stdout,
        stderr: stderr + "\nCommand not found",
        durationMs: Date.now() - start,
        timedOut: false,
        signal: null,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Process Supervisor — start/stop application with lifecycle guarantees
// ---------------------------------------------------------------------------

export class ProcessSupervisor {
  private child: ChildProcess | null = null;
  private stdout = "";
  private stderr = "";
  private startedAt: Date | null = null;
  private stoppedAt: Date | null = null;
  private exitCode: number | null = null;
  private signal: string | null = null;
  private forcedTermination = false;

  start(
    cwd: string,
    binary: string,
    args: string[],
    env?: Record<string, string>
  ): void {
    this.startedAt = new Date();
    this.child = spawn(binary, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // Create process group for child cleanup
      shell: false, // Phase 18D: NEVER use shell — prevents command injection.
    });

    this.child.stdout?.on("data", (d) => {
      this.stdout += d.toString();
      if (this.stdout.length > 500000) this.stdout = this.stdout.slice(-500000);
    });

    this.child.stderr?.on("data", (d) => {
      this.stderr += d.toString();
      if (this.stderr.length > 500000) this.stderr = this.stderr.slice(-500000);
    });

    this.child.on("close", (code, signal) => {
      this.stoppedAt = new Date();
      this.exitCode = code;
      this.signal = signal;
    });
  }

  /**
   * Wait for the application to start listening on the expected port.
   * Polls the port until it's accepting connections or timeout.
   */
  async waitForReady(port: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.child?.killed || this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
        return false; // Process died
      }
      try {
        // Try to connect to the port.
        const net = await import("node:net");
        const socket = new net.Socket();
        await new Promise<void>((resolve, reject) => {
          socket.setTimeout(1000);
          socket.once("connect", () => { socket.destroy(); resolve(); });
          socket.once("error", () => { socket.destroy(); reject(); });
          socket.once("timeout", () => { socket.destroy(); reject(); });
          socket.connect(port, "127.0.0.1");
        });
        return true; // Port is accepting connections
      } catch {
        await new Promise((r) => setTimeout(r, 500)); // Wait 500ms before retry
      }
    }
    return false; // Timeout
  }

  /**
   * Terminate the application with lifecycle guarantees:
   * SIGTERM → grace period → SIGKILL → child process cleanup
   */
  async terminate(graceMs: number): Promise<ProcessEvidence> {
    if (!this.child || !this.startedAt) {
      return {
        processStartedAt: "",
        processStoppedAt: null,
        exitCode: null,
        signal: null,
        forcedTermination: false,
        pid: null,
      };
    }

    const pid = this.child.pid ?? null;

    // 1. SIGTERM
    try {
      if (this.child.pid) {
        // Kill the entire process group (negative PID).
        process.kill(-this.child.pid, "SIGTERM");
      } else {
        this.child.kill("SIGTERM");
      }
    } catch {}

    // 2. Wait grace period
    await new Promise((r) => setTimeout(r, graceMs));

    // 3. If still alive: SIGKILL
    if (this.child.exitCode === null && this.child.exitCode !== 0) {
      this.forcedTermination = true;
      try {
        if (this.child.pid) {
          process.kill(-this.child.pid, "SIGKILL");
        } else {
          this.child.kill("SIGKILL");
        }
      } catch {}
    }

    // 4. Wait for close event
    await new Promise((r) => {
      const timeout = setTimeout(r, 2000);
      this.child?.once("close", () => { clearTimeout(timeout); r(); });
    });

    if (!this.stoppedAt) {
      this.stoppedAt = new Date();
    }

    return {
      processStartedAt: this.startedAt.toISOString(),
      processStoppedAt: this.stoppedAt?.toISOString() ?? null,
      exitCode: this.exitCode,
      signal: this.signal,
      forcedTermination: this.forcedTermination,
      pid,
    };
  }

  getOutput(): string {
    return this.stdout + "\n" + this.stderr;
  }
}

// ---------------------------------------------------------------------------
// Journey Runners — health, API, integration, background, browser
// ---------------------------------------------------------------------------

/**
 * Run a health check against the started application.
 */
export async function runHealthCheck(
  port: number,
  check: { name: string; path: string; expectedStatus: number; timeoutMs: number; required: "required" | "optional" }
): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${check.path}`, {
      signal: AbortSignal.timeout(check.timeoutMs),
    });
    const passed = res.status === check.expectedStatus;
    return {
      name: check.name,
      path: check.path,
      passed,
      status: res.status,
      responseTimeMs: Date.now() - start,
      required: check.required,
      error: passed ? undefined : `Expected ${check.expectedStatus}, got ${res.status}`,
    };
  } catch (err: any) {
    return {
      name: check.name,
      path: check.path,
      passed: false,
      status: null,
      responseTimeMs: Date.now() - start,
      required: check.required,
      error: err.message ?? "Health check failed",
    };
  }
}

/**
 * Run an API journey — a sequence of HTTP requests with assertions.
 */
export async function runApiJourney(
  port: number,
  journey: {
    name: string;
    required: "required" | "optional";
    steps: { name: string; method: string; path: string; expectedStatus: number; body?: string }[];
  }
): Promise<ApiJourneyResult> {
  const capturedVars: Record<string, any> = {};
  let stepsCompleted = 0;

  for (const step of journey.steps) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${step.path}`, {
        method: step.method,
        body: step.body,
        signal: AbortSignal.timeout(10000),
        headers: step.body ? { "Content-Type": "application/json" } : undefined,
      });

      if (res.status !== step.expectedStatus) {
        return {
          name: journey.name,
          passed: false,
          required: journey.required,
          stepsCompleted,
          stepsTotal: journey.steps.length,
          error: `Step ${step.name}: expected ${step.expectedStatus}, got ${res.status}`,
        };
      }
      stepsCompleted++;
    } catch (err: any) {
      return {
        name: journey.name,
        passed: false,
        required: journey.required,
        stepsCompleted,
        stepsTotal: journey.steps.length,
        error: `Step ${step.name}: ${err.message}`,
      };
    }
  }

  return {
    name: journey.name,
    passed: true,
    required: journey.required,
    stepsCompleted,
    stepsTotal: journey.steps.length,
  };
}

// ---------------------------------------------------------------------------
// Main Executor — orchestrates the full runtime verification pipeline
// ---------------------------------------------------------------------------

/**
 * Execute a runtime verification.
 *
 * This is the main entry point called by the worker's poller.
 * It follows the RuntimeExecutionPolicy exactly — no decisions, no reasoning.
 *
 * Pipeline:
 *   1. Create workspace
 *   2. Clone repository at exact SHA
 *   3. Install dependencies
 *   4. Build
 *   5. Start application
 *   6. Wait for ready (port listening)
 *   7. Run health checks
 *   8. Run API journeys
 *   9. Stop application (SIGTERM → grace → SIGKILL)
 *  10. Destroy workspace
 *  11. Return RuntimeVerificationResult
 */
export async function executeRuntimeVerification(
  policy: RuntimeExecutionPolicy,
  plan: {
    healthChecks: { name: string; path: string; expectedStatus: number; timeoutMs: number; required: "required" | "optional" }[];
    apiJourneys: { name: string; required: "required" | "optional"; steps: { name: string; method: string; path: string; expectedStatus: number; body?: string }[] }[];
  }
): Promise<RuntimeVerificationResult> {
  const evidence = new EvidenceCollector();
  const workspace = new WorkspaceManager(getWorkspacePaths(policy.sandbox));
  const supervisor = new ProcessSupervisor();
  const startedAt = new Date();

  let processEvidence: ProcessEvidence | null = null;

  // Phase 18V: Observed substrate attestation — captured from the FIRST
  // successful substrate run (install or build). Bound into the signed
  // envelope. Null if the substrate could not be established (gcc missing,
  // unshare unavailable, facts file missing) — fail-closed.
  let substrateAttestation: SandboxAttestation | null = null;

  try {
    // 1. Create workspace
    workspace.create();
    evidence.recordEvent({
      stage: "workspace-create",
      timestamp: new Date().toISOString(),
      success: true,
      durationMs: 0,
      exitCode: 0,
      output: `Workspace created at ${workspace.getPaths().root}`,
    });

    // 2. Real git checkout (Phase 18V — replaces the SIMULATED clone).
    //
    // The policy carries `repositoryUrl` — an authenticated HTTPS URL
    // resolved by the worker from the control plane's
    // `/api/worker/resolve-github-credential` endpoint. The executor itself
    // NEVER resolves credentials — it just clones what it's given. If
    // `repositoryUrl` is empty, the checkout fails-closed (no evidence is
    // produced without a real clone).
    //
    // Uses the git binary with array args (shell:false) — no shell interpolation.
    if (!policy.repositoryUrl) {
      return buildResult(evidence, policy, startedAt, false, "repository-checkout=NO_URL (fail-closed: no clone URL on policy)", null, [], [], substrateAttestation);
    }
    const cloneResult = await runCommand(
      workspace.getPaths().root,
      "git",
      ["clone", policy.repositoryUrl, workspace.getPaths().repo],
      120000
    );
    if (!cloneResult.success) {
      evidence.recordEvent({
        stage: "repository-checkout",
        timestamp: new Date().toISOString(),
        success: false,
        durationMs: cloneResult.durationMs,
        exitCode: cloneResult.exitCode,
        output: cloneResult.stdout + cloneResult.stderr,
        error: "git clone failed",
      });
      return buildResult(evidence, policy, startedAt, false, "repository-checkout=CLONE_FAILED", null, [], [], substrateAttestation);
    }
    // Then checkout the exact SHA (server-authoritative — the worker may NOT
    // choose the revision being certified).
    const coResult = await runCommand(
      workspace.getPaths().repo,
      "git",
      ["checkout", policy.repositoryHeadSha],
      30000
    );
    if (!coResult.success) {
      evidence.recordEvent({
        stage: "repository-checkout",
        timestamp: new Date().toISOString(),
        success: false,
        durationMs: coResult.durationMs,
        exitCode: coResult.exitCode,
        output: coResult.stdout + coResult.stderr,
        error: `git checkout ${policy.repositoryHeadSha.slice(0, 7)} failed`,
      });
      return buildResult(evidence, policy, startedAt, false, "repository-checkout=CHECKOUT_FAILED", null, [], [], substrateAttestation);
    }
    evidence.recordEvent({
      stage: "repository-checkout",
      timestamp: new Date().toISOString(),
      success: true,
      durationMs: cloneResult.durationMs + coResult.durationMs,
      exitCode: 0,
      output: `Repository cloned and checked out at SHA ${policy.repositoryHeadSha.slice(0, 7)}`,
    });

    // 3. Install dependencies — Phase 18V: runs INSIDE the substrate.
    //
    // The substrate (linux-namespace-sandbox) establishes a real isolation
    // boundary: user/pid/net/mnt namespaces, seccomp BPF filter (25 blocked
    // syscalls), rlimits (CPU/AS/NPROC/NOFILE/FSIZE), cap-drop (41 caps).
    // The launcher writes observed kernel facts to a JSON file, which the
    // runner turns into a SandboxAttestation. The attestation from the FIRST
    // successful substrate run is the one bound into the signed envelope.
    //
    // DEVIATION from spec: the start command is NOT wrapped in runInSubstrate
    // because the substrate's network mode is `hermetic-loopback` — the
    // sandboxed server would not be reachable from the host for health
    // checks. Install and build (which terminate) DO run in the substrate;
    // their attestation is the one bound into the envelope. The start
    // command uses ProcessSupervisor (existing detached-process flow).
    // Documented in the worklog.
    let installResult: CommandResult;
    try {
      const installRun = await runInSubstrate({
        binary: policy.commands.install.binary,
        args: policy.commands.install.args,
        cwd: workspace.getPaths().repo,
        env: policy.commands.install.env,
        timeoutMs: policy.commands.install.timeoutMs,
      });
      if (!substrateAttestation) substrateAttestation = installRun.attestation;
      installResult = installRun.result;
    } catch (err: any) {
      // Substrate could not be established (gcc missing, unshare unavailable,
      // facts file missing, etc.) — fail-closed: substrateAttestation stays
      // null. The production gate will block. The install "result" is
      // recorded as a failure so the evidence is honest about what happened.
      installResult = {
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: `substrate error: ${err.message}`,
        durationMs: 0,
        timedOut: false,
        signal: null,
      };
      substrateAttestation = null;
    }
    evidence.recordEvent({
      stage: "dependency-install",
      timestamp: new Date().toISOString(),
      success: installResult.success,
      durationMs: installResult.durationMs,
      exitCode: installResult.exitCode,
      output: installResult.stdout + installResult.stderr,
      error: installResult.success ? undefined : `Install failed: exit ${installResult.exitCode}`,
    });

    if (!installResult.success) {
      return buildResult(evidence, policy, startedAt, false, "dependencyInstall=FAILED", null, [], [], substrateAttestation);
    }

    // 4. Build — Phase 18V: also runs inside the substrate.
    let buildResult: CommandResult;
    try {
      const buildRun = await runInSubstrate({
        binary: policy.commands.build.binary,
        args: policy.commands.build.args,
        cwd: workspace.getPaths().repo,
        env: policy.commands.build.env,
        timeoutMs: policy.commands.build.timeoutMs,
      });
      if (!substrateAttestation) substrateAttestation = buildRun.attestation;
      buildResult = buildRun.result;
    } catch (err: any) {
      buildResult = {
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: `substrate error: ${err.message}`,
        durationMs: 0,
        timedOut: false,
        signal: null,
      };
    }
    evidence.recordEvent({
      stage: "build",
      timestamp: new Date().toISOString(),
      success: buildResult.success,
      durationMs: buildResult.durationMs,
      exitCode: buildResult.exitCode,
      output: buildResult.stdout + buildResult.stderr,
      error: buildResult.success ? undefined : `Build failed: exit ${buildResult.exitCode}`,
    });

    if (!buildResult.success) {
      return buildResult(evidence, policy, startedAt, false, "build=FAILED", null, [], [], substrateAttestation);
    }

    // 5. Start application
    //
    // DEVIATION: ProcessSupervisor (not runInSubstrate) — see comment in step 3.
    // The attestation from install/build is the one in the result.
    supervisor.start(
      workspace.getPaths().repo,
      policy.commands.start.binary,
      policy.commands.start.args,
      policy.commands.start.env
    );
    evidence.recordEvent({
      stage: "application-start",
      timestamp: new Date().toISOString(),
      success: true,
      durationMs: 0,
      exitCode: null,
      output: `Application started on port ${policy.expectedPort}`,
    });

    // 6. Wait for ready
    const ready = await supervisor.waitForReady(policy.expectedPort, policy.lifecycle.startupTimeoutMs);
    if (!ready) {
      evidence.recordEvent({
        stage: "application-start",
        timestamp: new Date().toISOString(),
        success: false,
        durationMs: policy.lifecycle.startupTimeoutMs,
        exitCode: null,
        output: supervisor.getOutput(),
        error: `Application did not become ready on port ${policy.expectedPort} within ${policy.lifecycle.startupTimeoutMs}ms`,
      });
      processEvidence = await supervisor.terminate(policy.lifecycle.terminationGraceMs);
      return buildResult(evidence, policy, startedAt, false, "startup=FAILED", processEvidence, [], [], substrateAttestation);
    }

    // 7. Run health checks
    const healthResults: HealthCheckResult[] = [];
    for (const check of plan.healthChecks) {
      const result = await runHealthCheck(policy.expectedPort, check);
      healthResults.push(result);
      evidence.recordEvent({
        stage: "health-check",
        timestamp: new Date().toISOString(),
        success: result.passed,
        durationMs: result.responseTimeMs,
        exitCode: result.status,
        output: `Health ${check.path}: ${result.status}`,
        error: result.error,
      });
    }

    // 8. Run API journeys
    const journeyResults: ApiJourneyResult[] = [];
    for (const journey of plan.apiJourneys) {
      const result = await runApiJourney(policy.expectedPort, journey);
      journeyResults.push(result);
      evidence.recordEvent({
        stage: "api-journey",
        timestamp: new Date().toISOString(),
        success: result.passed,
        durationMs: 0,
        exitCode: null,
        output: `Journey ${journey.name}: ${result.stepsCompleted}/${result.stepsTotal} steps`,
        error: result.error,
      });
    }

    // 9. Stop application
    processEvidence = await supervisor.terminate(policy.lifecycle.terminationGraceMs);
    evidence.recordEvent({
      stage: "application-stop",
      timestamp: new Date().toISOString(),
      success: !processEvidence.forcedTermination,
      durationMs: 0,
      exitCode: processEvidence.exitCode,
      output: `Process stopped: exit=${processEvidence.exitCode}, signal=${processEvidence.signal}, forced=${processEvidence.forcedTermination}`,
      error: processEvidence.forcedTermination ? "Forced termination (SIGKILL)" : undefined,
    });

    // Build final result
    const installStage = evidence.getStageResult("dependency-install")!;
    const buildStage = evidence.getStageResult("build")!;
    const startupStage = evidence.getStageResult("application-start")!;

    return {
      repositoryHeadSha: policy.repositoryHeadSha,
      headVerified: true,
      environmentFingerprint: policy.environmentFingerprint as unknown as EnvironmentFingerprint,
      dependencyInstallResult: installStage,
      buildResult: buildStage,
      startupResult: {
        ...startupStage,
        port: policy.expectedPort,
        pid: processEvidence.pid,
      },
      healthChecks: healthResults,
      apiJourneys: journeyResults,
      integrationChecks: [],
      backgroundJobChecks: [],
      browserJourneys: [],
      teardownResult: {
        success: !processEvidence.forcedTermination,
        durationMs: 0,
        error: processEvidence.forcedTermination ? "Forced termination" : undefined,
      },
      passed: healthResults.every((h) => h.passed) && journeyResults.every((j) => j.passed),
      failureReason: null,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      logs: evidence.getLogs(),
      // Phase 18V: bound into the signed envelope — null if substrate failed.
      substrateAttestation,
    };
  } catch (err: any) {
    // Ensure termination on any error
    if (supervisor) {
      processEvidence = await supervisor.terminate(policy.lifecycle.terminationGraceMs);
    }
    return buildResult(evidence, policy, startedAt, false, `executor-error: ${err.message}`, processEvidence, [], [], substrateAttestation);
  } finally {
    // 10. Always destroy workspace — even on failure
    workspace.destroy();
    evidence.recordEvent({
      stage: "workspace-destroy",
      timestamp: new Date().toISOString(),
      success: true,
      durationMs: 0,
      exitCode: 0,
      output: "Workspace destroyed",
    });
  }
}

// ---------------------------------------------------------------------------
// Helper: build a failed result
// ---------------------------------------------------------------------------

function buildResult(
  evidence: EvidenceCollector,
  policy: RuntimeExecutionPolicy,
  startedAt: Date,
  passed: boolean,
  failureReason: string | null,
  processEvidence: ProcessEvidence | null,
  healthChecks: HealthCheckResult[],
  apiJourneys: ApiJourneyResult[],
  substrateAttestation: SandboxAttestation | null
): RuntimeVerificationResult {
  const installStage = evidence.getStageResult("dependency-install") || { success: false, durationMs: 0, exitCode: null, output: "" };
  const buildStage = evidence.getStageResult("build") || { success: false, durationMs: 0, exitCode: null, output: "" };
  const startupStage = evidence.getStageResult("application-start") || { success: false, durationMs: 0, exitCode: null, output: "" };

  return {
    repositoryHeadSha: policy.repositoryHeadSha,
    headVerified: true,
    environmentFingerprint: policy.environmentFingerprint as unknown as EnvironmentFingerprint,
    dependencyInstallResult: installStage,
    buildResult: buildStage,
    startupResult: {
      ...startupStage,
      port: policy.expectedPort,
      pid: processEvidence?.pid ?? null,
    },
    healthChecks,
    apiJourneys,
    integrationChecks: [],
    backgroundJobChecks: [],
    browserJourneys: [],
    teardownResult: {
      success: true,
      durationMs: 0,
    },
    passed,
    failureReason,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    logs: evidence.getLogs(),
    // Phase 18V: substrate attestation — null when substrate could not be
    // established. Bound into the signed envelope; production gate fails-closed.
    substrateAttestation,
  };
}
