// Forge — Phase 18X / 18Y: Worker runtime verification module.
//
// This module is called by the poller when runtime verification is needed.
// It does NOT use the control-plane's runtime-executor (which lives in the
// main project and imports from @/lib/db). Instead it:
//
//   1. Resolves the GitHub credential and clones the repo at the exact SHA.
//   2. POSTs { capability, repoPath } to the substrate supervisor
//      (mini-services/substrate-supervisor, port 3004). The supervisor — a
//      TRUSTED process that holds the launcher key IN MEMORY — DERIVES the
//      workload from cap.runtimePlan (Phase 18Y — the worker does NOT
//      supply the workload), runs the substrate, writes plan.json +
//      orchestrator.js, runs the substrate, and returns the signed
//      attestation.
//   3. Reads results.json (the orchestrator's output) — written by the
//      supervisor to a workspace dir that the supervisor cleans up.
//      IMPORTANT: in Phase 18Y the worker no longer has the workspace
//      dir (the supervisor owns it). The supervisor returns `results` in
//      the response body; the worker uses that if present. If absent
//      (orchestrator crashed), the worker synthesizes a failed result from
//      the substrate's stdout/stderr.
//   4. Constructs the ExecutionEvidenceEnvelope (signed with the WORKER's
//      Ed25519 private key).
//
// PHASE 18Y — EXECUTION CAPABILITY CLOSURE:
//   The worker NEVER supplies the workload. It supplies:
//     - capability (control-plane-signed; carries runtimePlan + workloadHash)
//     - repoPath (host-side path where the worker cloned the repo)
//   The supervisor:
//     - verifies the capability signature
//     - calls /api/supervisor/consume-capability (atomic nonce consumption)
//     - derives the workload from cap.runtimePlan (binary="node",
//       args=["/workspace/orchestrator.js"], cwd="/workspace/repo")
//     - verifies workloadHash matches cap.workloadHash
//     - verifies git rev-parse HEAD === cap.repositoryHeadSha
//     - verifies the working tree is clean
//     - writes plan.json + copies orchestrator.js to a workspace
//     - runs the substrate
//     - returns { attestation, result, results }
//
// PHASE 18X — LAUNCHER KEY ISOLATION (still enforced):
//   The worker NEVER has the launcher private key. It does NOT have:
//     - The launcher key file path.
//     - The launcher key file content.
//     - Any env var pointing to the launcher key.
//     - Any way to invoke the launcher directly.
//   The worker ONLY has:
//     - An ExecutionCapability (signed by the control plane) that authorizes
//       the supervisor to run this specific workload.
//     - The supervisor's URL (default http://localhost:3004).
//
// FAIL-CLOSED: if the substrate cannot be established (supervisor down,
// capability invalid, substrate setup failure), this function THROWS. It
// NEVER returns an envelope with substrateAttestation: null.
//
// IMPORTANT: this module MUST NOT import from @/lib/db (the worker is a
// standalone bun project with no Prisma client). It imports:
//   - @/lib/runtime-execution-contract (signEvidenceEnvelope, computeEnvelopeHash,
//     computeResultHash, verifyEvidenceEnvelope, types)
//   - @/lib/substrate-attestation (types only)
//   - @/lib/execution-capability (types only — for the request body shape)
// None of these have @/lib/db dependencies.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  computeEnvelopeHash,
  computeResultHash,
  signEvidenceEnvelope,
  captureEnvironmentFingerprint,
  type ExecutionEvidenceEnvelope,
} from "@/lib/runtime-execution-contract";
import type { SandboxAttestation } from "@/lib/substrate-attestation";
import type { ExecutionCapability } from "@/lib/execution-capability";
import type { CommandResult } from "@/lib/runtime-executor";

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
 *
 * Phase 18X: the job no longer carries `launcherKeyFile`. Instead it carries:
 *   - `capability`: the control-plane-signed ExecutionCapability that
 *     authorizes the supervisor to run this workload.
 *   - `supervisorUrl`: the URL of the substrate supervisor (default
 *     http://localhost:3004).
 */
export interface RuntimeVerificationJob {
  /** Stable id for this execution (informational — the real binding is in the capability). */
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
  /** The nonce bound into the launcher signature (informational — comes from the capability). */
  nonce: string;
  /**
   * Phase 18X: The control-plane-signed ExecutionCapability. The supervisor
   * verifies this before running the substrate. The capability carries the
   * authoritative nonce + executionId (the worker cannot override them).
   *
   * Phase 18Y: The capability ALSO carries the full runtimePlan +
   * workloadHash. The supervisor DERIVES the workload from cap.runtimePlan
   * — the worker does NOT supply the workload.
   */
  capability: ExecutionCapability;
  /**
   * Phase 18X: The URL of the substrate supervisor. Default
   * http://localhost:3004. The worker POSTs { capability, repoPath }
   * here and receives { attestation, result, results }.
   */
  supervisorUrl?: string;
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
// Substrate supervisor client — POST /execute
// ---------------------------------------------------------------------------

/**
 * Phase 18Y: The request body the worker POSTs to the supervisor.
 *
 * The worker supplies ONLY:
 *   - capability: the control-plane-signed ExecutionCapability (carries the
 *     full runtimePlan + workloadHash — the supervisor derives the workload).
 *   - repoPath: the host-side path where the worker cloned the repo.
 *
 * The worker does NOT supply:
 *   - workload (binary, args, cwd, env, timeoutMs)
 *   - plan
 *   - any execution recipe
 *
 * The supervisor derives the workload from cap.runtimePlan, verifies
 * workloadHash, verifies the repo SHA + clean tree, writes plan.json +
 * copies orchestrator.js, and runs the substrate.
 */
interface SupervisorExecuteRequest {
  capability: ExecutionCapability;
  repoPath: string;
}

interface SupervisorExecuteResponse {
  attestation: SandboxAttestation;
  result: CommandResult;
  /** Phase 18Y: the orchestrator's results.json (if the orchestrator wrote it). */
  results?: unknown | null;
}

/**
 * Call the substrate supervisor's /execute endpoint.
 *
 * The supervisor verifies the capability signature, calls
 * /api/supervisor/consume-capability (atomic nonce consumption), derives
 * the workload from cap.runtimePlan, verifies workloadHash, verifies the
 * repo SHA + clean tree, runs the substrate (with the launcher key it
 * holds in memory), and returns the signed attestation + workload result.
 *
 * The supervisor NEVER returns the launcher key — only the signed attestation.
 * If the supervisor is unreachable or returns a non-200 response, this
 * function throws (fail-closed).
 */
async function callSupervisorExecute(
  supervisorUrl: string,
  reqBody: SupervisorExecuteRequest
): Promise<SupervisorExecuteResponse> {
  const url = `${supervisorUrl.replace(/\/+$/, "")}/execute`;
  const bodyJson = JSON.stringify(reqBody);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyJson,
    });
  } catch (err) {
    throw new Error(
      `Failed to reach substrate supervisor at ${url}: ${err instanceof Error ? err.message : String(err)}. ` +
        "Ensure the supervisor mini-service is running (bun run mini-services/substrate-supervisor/index.ts)."
    );
  }
  if (!resp.ok) {
    let detail = "";
    try {
      const errBody = await resp.json() as { error?: string; reasons?: string[] };
      detail = errBody.error
        ? `${errBody.error}${errBody.reasons ? `: ${errBody.reasons.join("; ")}` : ""}`
        : JSON.stringify(errBody);
    } catch {
      try { detail = await resp.text(); } catch { /* ignore */ }
    }
    throw new Error(
      `Substrate supervisor rejected the request (HTTP ${resp.status}): ${detail}`
    );
  }
  let parsed: SupervisorExecuteResponse;
  try {
    parsed = (await resp.json()) as SupervisorExecuteResponse;
  } catch (err) {
    throw new Error(
      `Substrate supervisor returned non-JSON response: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed.attestation) {
    throw new Error(
      "Substrate supervisor returned a response with no attestation — fail-closed (this is a CRITICAL invariant violation)."
    );
  }
  if (!parsed.result) {
    throw new Error(
      "Substrate supervisor returned a response with no result — fail-closed."
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Main entry — executeRuntimeVerificationInWorker
// ---------------------------------------------------------------------------

/**
 * Execute runtime verification inside the substrate and return a signed
 * ExecutionEvidenceEnvelope.
 *
 * FAIL-CLOSED: if the substrate cannot be established (supervisor down,
 * capability invalid, substrate setup failure), this function THROWS. It
 * NEVER returns an envelope with substrateAttestation: null.
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
  if (!job.capability) throw new Error("executeRuntimeVerificationInWorker: capability is required (Phase 18X — the supervisor verifies the capability before running the substrate)");
  if (!job.workerPrivateKeyPem) throw new Error("executeRuntimeVerificationInWorker: workerPrivateKeyPem is required");
  if (!job.repositoryUrl) throw new Error("executeRuntimeVerificationInWorker: repositoryUrl is required (no anonymous clone)");
  if (!job.repositoryHeadSha) throw new Error("executeRuntimeVerificationInWorker: repositoryHeadSha is required");

  const supervisorUrl = (job.supervisorUrl ?? "http://localhost:3004").trim();
  if (!supervisorUrl) {
    throw new Error("executeRuntimeVerificationInWorker: supervisorUrl is empty (set SUBSTRATE_SUPERVISOR_URL or pass supervisorUrl in the job)");
  }

  // Phase 18Y: the worker only needs a workspace for cloning the repo. The
  // supervisor owns the plan.json + orchestrator.js + results.json (it
  // derives them from cap.runtimePlan and cleans up its own workspace). The
  // worker's workspace is just the cloned repo + a workspace dir name to
  // hand to the supervisor as repoPath.
  const workspace = `/tmp/forge-runtime-${job.executionId}-${randomUUID()}`;
  mkdirSync(workspace, { recursive: true });
  const repoPath = join(workspace, "repo");

  try {
    // 1. Clone the repository at the exact SHA. The worker is the ONLY
    //    party with the GitHub credential — it clones the repo on the host.
    //    The supervisor (and the substrate) NEVER sees the GitHub
    //    credential; they receive the cloned repoPath.
    gitCloneAtSha(job.repositoryUrl, repoPath, job.repositoryHeadSha);

    // 2. POST { capability, repoPath } to the substrate supervisor.
    //    Phase 18Y: the worker does NOT supply the workload. The supervisor
    //    derives it from cap.runtimePlan, verifies workloadHash, verifies
    //    git rev-parse HEAD === cap.repositoryHeadSha, verifies the working
    //    tree is clean, writes plan.json + copies orchestrator.js, calls
    //    /api/supervisor/consume-capability (atomic nonce consumption),
    //    runs the substrate, and returns { attestation, result, results }.
    //
    //    The nonce + executionId come from the capability (the worker cannot
    //    override them — they're cryptographically bound).
    //
    //    FAIL-CLOSED: if the supervisor is down, rejects the capability, or
    //    runInSubstrate inside the supervisor throws — callSupervisorExecute
    //    throws and we propagate.
    console.log(
      `[worker] Starting runtime verification via supervisor at ${supervisorUrl} ` +
        `(executionId=${job.executionId}, nonce=${job.nonce.slice(0, 8)}..., sha=${job.repositoryHeadSha.slice(0, 7)})`
    );
    const { result, attestation, results: supervisorResults } = await callSupervisorExecute(supervisorUrl, {
      capability: job.capability,
      repoPath,
    });

    // 3. Use the results the supervisor returned. The supervisor owns the
    //    workspace now (it wrote plan.json + orchestrator.js + results.json
    //    and cleaned them up). The worker can't read the supervisor's
    //    workspace; the supervisor returns results.json in the response body.
    let results: OrchestratorResults;
    if (
      supervisorResults &&
      typeof supervisorResults === "object" &&
      "passed" in supervisorResults
    ) {
      results = supervisorResults as OrchestratorResults;
    } else {
      // The orchestrator crashed before writing results.json (or the
      // supervisor failed to read it). Synthesize a failed result from
      // the substrate run's stdout/stderr. The attestation is still
      // present (the substrate ran).
      const completedAt = new Date().toISOString();
      results = {
        installResult: null,
        buildResult: null,
        startupResult: null,
        healthChecks: [],
        apiJourneys: [],
        teardownResult: { success: false, durationMs: 0 },
        passed: false,
        failureReason: `orchestrator did not produce results.json (supervisor returned no results). Substrate stdout: ${result.stdout.slice(0, 500)}`,
        startedAt: completedAt,
        completedAt,
      };
    }

    // 4. Construct the envelope.
    const envelope = buildEnvelopeFromResults(job, results, attestation, result.stdout);
    return envelope;
  } finally {
    // Clean up the worker's workspace (the cloned repo). The supervisor's
    // workspace (plan.json + orchestrator.js + results.json) is cleaned up
    // by the supervisor itself.
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
    // The REAL attestation from the supervisor — NEVER null.
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
