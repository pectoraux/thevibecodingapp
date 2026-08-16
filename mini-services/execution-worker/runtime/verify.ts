// Forge — Phase 18W-B: Worker runtime verification module.
//
// This module is called by the poller when runtime verification is needed.
// It does NOT use the control-plane's runtime-executor (which lives in the
// main project and imports from @/lib/db). Instead it runs the in-substrate
// orchestrator script (runtime/orchestrator.js) via runInSubstrate, reads
// the results.json the orchestrator writes, and constructs a signed
// ExecutionEvidenceEnvelope.
//
// FLOW:
//   1. Create a temp workspace at /tmp/forge-runtime-<executionId>.
//   2. Clone the repository at the exact SHA (git clone <url> <ws>/repo &&
//      git -C <ws>/repo checkout <sha>).
//   3. Write plan.json to <ws>/plan.json (the orchestrator reads this).
//   4. Copy the orchestrator script to <ws>/orchestrator.js.
//   5. runInSubstrate({ binary: "node", args: ["/workspace/orchestrator.js"],
//      cwd: workspace, timeoutMs, nonce, executionId, launcherKeyFile }).
//      `node` is bind-mounted into the rootfs via /usr.
//   6. Read <ws>/results.json (the orchestrator's output).
//   7. Use the attestation returned by runInSubstrate as the envelope's
//      substrateAttestation (NEVER null — fail-closed: if runInSubstrate
//      throws, propagate the throw).
//   8. Construct the ExecutionEvidenceEnvelope from results.json + attestation.
//      Compute resultHash, envelopeHash, sign with the worker's Ed25519
//      private key.
//   9. Return the signed envelope.
//
// IMPORTANT: this module MUST NOT import from @/lib/db (the worker is a
// standalone bun project with no Prisma client). It only imports:
//   - @/lib/runtime-execution-contract (signEvidenceEnvelope, computeEnvelopeHash,
//     computeResultHash, verifyEvidenceEnvelope, types)
//   - @/lib/substrate-namespace (runInSubstrate)
//   - @/lib/substrate-attestation (types)
// None of these have @/lib/db dependencies (verified by reading).

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sign as cryptoSign, randomUUID } from "node:crypto";

import {
  computeEnvelopeHash,
  computeResultHash,
  signEvidenceEnvelope,
  captureEnvironmentFingerprint,
  type ExecutionEvidenceEnvelope,
} from "@/lib/runtime-execution-contract";
import { runInSubstrate } from "@/lib/substrate-namespace";
import type { SandboxAttestation } from "@/lib/substrate-attestation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The plan as the orchestrator reads it. This is the JSON shape written to
 * /workspace/plan.json. Matches the orchestrator's expectations.
 */
export interface OrchestratorPlan {
  install: { binary: string; args: string[]; env?: Record<string, string>; timeoutMs?: number };
  build: { binary: string; args: string[]; env?: Record<string, string>; timeoutMs?: number };
  start: { binary: string; args: string[]; env?: Record<string, string>; timeoutMs?: number };
  port: number;
  startupTimeoutMs: number;
  healthChecks: Array<{
    name: string;
    path: string;
    expectedStatus: number;
    timeoutMs?: number;
    required: "required" | "optional";
  }>;
  apiJourneys: Array<{
    name: string;
    required?: "required" | "optional";
    steps: Array<{
      name: string;
      method: string;
      path: string;
      expectedStatus: number;
      body?: string;
    }>;
  }>;
}

/**
 * The job the poller hands to executeRuntimeVerificationInWorker.
 */
export interface RuntimeVerificationJob {
  /** Stable id for this execution (bound into the launcher signature). */
  executionId: string;
  /** Worker identity (bound into the envelope signature). */
  workerId: string;
  /** Lease id (bound into the envelope signature). */
  leaseId: string;
  /** The exact SHA the runtime verification must execute. */
  repositoryHeadSha: string;
  /** Authenticated URL for `git clone` (https://x-access-token:...@github.com/...). */
  repositoryUrl: string;
  /** Architecture hash (for evidence binding). */
  architectureHash: string | null;
  /** Runtime plan hash (for evidence binding). */
  runtimePlanHash: string;
  /** The plan to write to /workspace/plan.json. */
  plan: OrchestratorPlan;
  /** The nonce the control plane issued for this execution. */
  nonce: string;
  /** Path to the launcher's Ed25519 private key (PEM). The launcher reads this. */
  launcherKeyFile: string;
  /** Total substrate timeout for the whole pipeline. */
  totalTimeoutMs?: number;
  /** The worker's Ed25519 private key (PEM), used to sign the envelope. */
  workerPrivateKeyPem: string;
}

/**
 * The results.json shape the orchestrator writes.
 */
interface OrchestratorResults {
  installResult: {
    success: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    error?: string | null;
  } | null;
  buildResult: {
    success: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    error?: string | null;
  } | null;
  startupResult: {
    success: boolean;
    port: number;
    pid: number | null;
    durationMs: number;
    exitCode: number | null;
    output: string;
    error?: string | null;
  } | null;
  healthChecks: Array<{
    name: string;
    path: string;
    passed: boolean;
    status: number | null;
    responseTimeMs: number;
    required?: string;
    error?: string | null;
  }>;
  apiJourneys: Array<{
    name: string;
    passed: boolean;
    stepsCompleted: number;
    stepsTotal: number;
    required?: string;
  }>;
  teardownResult: { success: boolean; durationMs: number; forced?: boolean };
  passed: boolean;
  failureReason: string | null;
  startedAt: string;
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Orchestrator script location
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the orchestrator.js script.
 *
 * The script is committed at mini-services/execution-worker/runtime/orchestrator.js.
 * When this verify.ts module is loaded via Bun, `import.meta.url` is the file:// URL
 * of verify.ts itself. We resolve the orchestrator path relative to that.
 */
function getOrchestratorScriptPath(): string {
  // import.meta.url is available in ESM. Bun supports it.
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), "orchestrator.js");
}

// ---------------------------------------------------------------------------
// Git clone at exact SHA
// ---------------------------------------------------------------------------

function gitCloneAtSha(repositoryUrl: string, targetPath: string, sha: string): void {
  // Use execFileSync with arg array — NO shell interpolation. The URL may
  // contain a token; that token is passed as an argv element, which is not
  // visible to other processes via /proc/<pid>/cmdline on most systems (the
  // worker runs as a non-root user). The token is never logged.
  execFileSync("git", ["clone", repositoryUrl, targetPath], {
    cwd: "/tmp",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
  // Checkout the exact SHA. Use -f to discard any local state (shouldn't be any).
  execFileSync("git", ["-C", targetPath, "checkout", "-f", sha], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    timeout: 30000,
  });
  // Verify the checkout produced the expected SHA.
  const rev = execFileSync("git", ["-C", targetPath, "rev-parse", "HEAD"], {
    encoding: "utf-8",
    shell: false,
    timeout: 10000,
  }).trim();
  if (rev !== sha) {
    throw new Error(
      `git checkout at SHA ${sha} produced HEAD ${rev} — repository SHA mismatch`
    );
  }
}

// ---------------------------------------------------------------------------
// Main entry — executeRuntimeVerificationInWorker
// ---------------------------------------------------------------------------

/**
 * Execute runtime verification inside the substrate and return a signed
 * ExecutionEvidenceEnvelope.
 *
 * FAIL-CLOSED: if the substrate cannot be established (gcc missing, unshare
 * fails, launcher won't compile, facts file missing/empty), this function
 * THROWS. It NEVER returns an envelope with substrateAttestation: null.
 *
 * If the workload itself fails (install fails, app doesn't start, health
 * check fails), the function returns an envelope with passed: false but the
 * attestation is STILL present (the substrate ran, the workload just failed).
 */
export async function executeRuntimeVerificationInWorker(
  job: RuntimeVerificationJob
): Promise<ExecutionEvidenceEnvelope> {
  if (!job.executionId) throw new Error("executeRuntimeVerificationInWorker: executionId is required");
  if (!job.workerId) throw new Error("executeRuntimeVerificationInWorker: workerId is required");
  if (!job.nonce) throw new Error("executeRuntimeVerificationInWorker: nonce is required");
  if (!job.launcherKeyFile) throw new Error("executeRuntimeVerificationInWorker: launcherKeyFile is required (Phase 18W)");
  if (!job.workerPrivateKeyPem) throw new Error("executeRuntimeVerificationInWorker: workerPrivateKeyPem is required");
  if (!job.repositoryUrl) throw new Error("executeRuntimeVerificationInWorker: repositoryUrl is required (no anonymous clone)");
  if (!job.repositoryHeadSha) throw new Error("executeRuntimeVerificationInWorker: repositoryHeadSha is required");

  const workspace = `/tmp/forge-runtime-${job.executionId}`;
  mkdirSync(workspace, { recursive: true });
  const repoPath = join(workspace, "repo");
  const planPath = join(workspace, "plan.json");
  const resultsPath = join(workspace, "results.json");
  const orchestratorPath = join(workspace, "orchestrator.js");

  try {
    // 1. Clone the repository at the exact SHA.
    gitCloneAtSha(job.repositoryUrl, repoPath, job.repositoryHeadSha);

    // 2. Write plan.json.
    writeFileSync(planPath, JSON.stringify(job.plan, null, 2));

    // 3. Copy the orchestrator script into the workspace.
    const orchestratorSrc = getOrchestratorScriptPath();
    if (!existsSync(orchestratorSrc)) {
      throw new Error(`orchestrator script not found at ${orchestratorSrc}`);
    }
    copyFileSync(orchestratorSrc, orchestratorPath);

    // 4. Run the orchestrator INSIDE the substrate.
    // The launcher bind-mounts `workspace` into rootfs/workspace. The orchestrator
    // reads /workspace/plan.json (bind-mounted) and writes /workspace/results.json
    // (also bind-mounted, RW).
    //
    // FAIL-CLOSED: runInSubstrate throws if the substrate cannot be established
    // (no gcc, unshare fails, launcher won't compile, facts file missing). We
    // propagate the throw — NO null attestation.
    const totalTimeoutMs = job.totalTimeoutMs ?? 1800000; // 30 min default
    const { result, attestation } = await runInSubstrate({
      binary: "node",
      args: ["/workspace/orchestrator.js"],
      cwd: workspace,
      timeoutMs: totalTimeoutMs,
      nonce: job.nonce,
      executionId: job.executionId,
      launcherKeyFile: job.launcherKeyFile,
    });

    // 5. Read results.json. The orchestrator MUST have written it.
    let results: OrchestratorResults;
    try {
      const raw = readFileSync(resultsPath, "utf-8");
      results = JSON.parse(raw) as OrchestratorResults;
    } catch (err) {
      // The orchestrator crashed before writing results.json. Synthesize a
      // failed result from the substrate run's stdout/stderr. The attestation
      // is still present (the substrate ran).
      const completedAt = new Date().toISOString();
      results = {
        installResult: null,
        buildResult: null,
        startupResult: null,
        healthChecks: [],
        apiJourneys: [],
        teardownResult: { success: false, durationMs: 0 },
        passed: false,
        failureReason: `orchestrator did not write results.json: ${err instanceof Error ? err.message : String(err)}. Substrate stdout: ${result.stdout.slice(0, 500)}`,
        startedAt: completedAt,
        completedAt,
      };
    }

    // 6. Construct the envelope.
    const envelope = buildEnvelopeFromResults(job, results, attestation, result.stdout);
    return envelope;
  } finally {
    // Clean up the workspace (best-effort — the substrate's mount namespace
    // already died with the unshare process; we're just removing the host-side
    // dir that held the plan + repo + orchestrator copy).
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Build the envelope from results + attestation
// ---------------------------------------------------------------------------

function buildEnvelopeFromResults(
  job: RuntimeVerificationJob,
  results: OrchestratorResults,
  attestation: SandboxAttestation,
  orchestratorStdout: string
): ExecutionEvidenceEnvelope {
  // Map orchestrator results → envelope contract fields.
  const dependencyInstallResult = results.installResult
    ? {
        success: results.installResult.success,
        durationMs: results.installResult.durationMs,
        exitCode: results.installResult.exitCode,
        output: (results.installResult.stdout + "\n" + results.installResult.stderr).slice(0, 50000),
      }
    : { success: false, durationMs: 0, exitCode: null, output: "install stage did not run" };

  const buildResult = results.buildResult
    ? {
        success: results.buildResult.success,
        durationMs: results.buildResult.durationMs,
        exitCode: results.buildResult.exitCode,
        output: (results.buildResult.stdout + "\n" + results.buildResult.stderr).slice(0, 50000),
      }
    : { success: false, durationMs: 0, exitCode: null, output: "build stage did not run" };

  const startupResult = results.startupResult
    ? {
        success: results.startupResult.success,
        durationMs: results.startupResult.durationMs,
        exitCode: results.startupResult.exitCode,
        output: (results.startupResult.output || "").slice(0, 50000),
        port: results.startupResult.port,
        pid: results.startupResult.pid,
      }
    : { success: false, durationMs: 0, exitCode: null, output: "startup stage did not run", port: job.plan.port, pid: null };

  const healthChecks = (results.healthChecks || []).map((hc) => ({
    name: hc.name,
    path: hc.path,
    passed: hc.passed,
    status: hc.status,
    responseTimeMs: hc.responseTimeMs,
  }));

  const apiJourneys = (results.apiJourneys || []).map((j) => ({
    name: j.name,
    passed: j.passed,
    stepsCompleted: j.stepsCompleted,
    stepsTotal: j.stepsTotal,
  }));

  const teardownResult = results.teardownResult
    ? { success: results.teardownResult.success, durationMs: results.teardownResult.durationMs }
    : { success: false, durationMs: 0 };

  // Environment fingerprint — captured at execution time in the worker process.
  const environmentFingerprint = captureEnvironmentFingerprint("unknown", null);

  // Build the envelope WITHOUT resultHash/envelopeHash/signature first.
  const envelopeWithoutHash: Omit<ExecutionEvidenceEnvelope, "resultHash" | "envelopeHash" | "signature"> = {
    executionId: job.executionId,
    workerId: job.workerId,
    leaseId: job.leaseId,
    repositoryHeadSha: job.repositoryHeadSha,
    architectureHash: job.architectureHash,
    runtimePlanHash: job.runtimePlanHash,
    environmentFingerprint,
    dependencyInstallResult,
    buildResult,
    startupResult,
    healthChecks,
    apiJourneys,
    integrationChecks: [],
    backgroundJobChecks: [],
    browserJourneys: [],
    teardownResult,
    passed: results.passed,
    failureReason: results.failureReason,
    startedAt: results.startedAt,
    completedAt: results.completedAt,
    logs: orchestratorStdout.slice(0, 50000),
    // The REAL attestation from runInSubstrate — NEVER null.
    substrateAttestation: attestation,
  };

  // Compute canonical hashes.
  const resultHash = computeResultHash(envelopeWithoutHash);
  const envelopeHash = computeEnvelopeHash({ ...envelopeWithoutHash, resultHash });

  // Sign with the worker's Ed25519 private key.
  const signature = signEvidenceEnvelope(
    { ...envelopeWithoutHash, resultHash, envelopeHash },
    job.workerPrivateKeyPem
  );

  return {
    ...envelopeWithoutHash,
    resultHash,
    envelopeHash,
    signature,
  };
}

// ---------------------------------------------------------------------------
// Helper: generate a launcher nonce (used by tests + the poller fallback)
// ---------------------------------------------------------------------------

/**
 * Generate a random nonce for the launcher signature. Uses crypto.randomUUID
 * for unpredictability. The control plane MUST issue this nonce (Phase 18W-C
 * will verify at submission time). For tests / local runs where the control
 * plane is unavailable, the poller can generate one directly.
 */
export function generateSubstrateNonce(): string {
  // crypto.randomUUID is unpredictable. The control plane MUST issue this
  // nonce (Phase 18W-C will verify at submission time). For tests / local
  // runs where the control plane is unavailable, the poller can generate one
  // directly.
  return randomUUID();
}

// Re-export cryptoSign for callers that want to verify the envelope signature
// against a public key.
export { cryptoSign };
