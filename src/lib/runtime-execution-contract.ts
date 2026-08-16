// Forge — Phase 18C: Runtime Execution Contract.
//
// This module defines the EXECUTION CONTRACT for runtime verification.
// It is the boundary between "what should be verified" (the plan) and
// "how to verify it" (the executor).
//
// The contract freezes:
//   1. SANDBOX MODEL — where execution happens, isolation guarantees, cleanup.
//   2. COMMAND MODEL — commands as structured data, not strings. The executor
//      does not reason; it executes what the plan declares.
//   3. PROCESS LIFECYCLE — spawn, timeout, SIGTERM, grace, SIGKILL, cleanup.
//   4. NETWORK POLICY — hermetic vs integration mode. Never silently allow network.
//   5. ENVIRONMENT FINGERPRINT — full reproducibility without secrets.
//   6. EVIDENCE CAPTURE — continuous per-stage capture, not just final result.
//
// ARCHITECTURE:
//   RuntimeVerificationJob
//         ↓
//   RuntimeExecutor
//         ├── WorkspaceManager (isolation, cleanup)
//         ├── RepositoryCheckout (clone at exact SHA)
//         ├── CommandRunner (structured commands, timeout, capture)
//         ├── ProcessSupervisor (start, waitForReady, terminate)
//         ├── HealthRunner
//         ├── ApiJourneyRunner
//         ├── IntegrationRunner
//         ├── BackgroundJobRunner
//         ├── BrowserRunner
//         └── EvidenceCollector (continuous capture)
//         ↓
//   RuntimeEvidenceSubmission

import { createHash } from "node:crypto";
import type { SandboxAttestation } from "@/lib/substrate-attestation";
import type { ArtifactManifest } from "@/lib/artifact-manifest";

/**
 * Recursive canonical serialization for stable hashing/signing.
 * Object keys sorted recursively; arrays preserve order.
 */
function canonicalSerialize(value: any): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value.toString();
  if (typeof value === "number") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalSerialize).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalSerialize(value[k]));
    return "{" + pairs.join(",") + "}";
  }
  return "null";
}

// ---------------------------------------------------------------------------
// 1. SANDBOX MODEL
// ---------------------------------------------------------------------------

/**
 * The sandbox model defines filesystem isolation for runtime verification.
 *
 * Each execution gets a dedicated workspace:
 *   /sandbox/runtime/{executionId}/
 *     ├── repo/          — cloned repository at exact SHA
 *     ├── install/        — dependency installation target
 *     ├── build/          — build output
 *     ├── logs/           — captured stdout/stderr per stage
 *     └── artifacts/      — screenshots, dumps, etc.
 *
 * Guarantees:
 *   - No shared mutable workspace between executions.
 *   - Workspace is destroyed after execution (always — even on failure).
 *   - No caches that could contaminate reproducibility.
 */
/**
 * Phase 18D: Sandbox isolation level.
 *
 * The current implementation provides FILESYSTEM isolation only (dedicated
 * directory per execution, destroyed after execution).
 *
 * Production-grade isolation requires container/microVM enforcement:
 *   - Docker container with resource quotas (CPU, memory)
 *   - Network namespace (no route in hermetic mode)
 *   - Syscall restrictions (seccomp)
 *   - User namespace (non-root)
 *
 * The isolation level is recorded in evidence so consumers know what
 * guarantees the evidence actually carries.
 */
export type SandboxIsolationLevel =
  | "filesystem-only"    // Current: mkdir + rmSync. No process/network isolation.
  | "container"          // Docker container with resource quotas.
  | "microvm";           // Firecracker/gVisor microVM.

export interface SandboxModel {
  /** Root directory for all runtime verification sandboxes. */
  sandboxRoot: string;
  /** Per-execution workspace path: {sandboxRoot}/{executionId}/ */
  workspacePath: string;
  /** Whether the workspace is destroyed after execution. */
  destroyAfterExecution: boolean;
  /** Whether caches are allowed (default: false for reproducibility). */
  cachesAllowed: boolean;
  /** Whether caches are included in evidence (default: false). */
  cachesInEvidence: boolean;
  /** Phase 18D: Isolation level — records what guarantees the sandbox provides. */
  isolationLevel: SandboxIsolationLevel;
  /** Phase 18D: Whether network is physically enforced (not just policy). */
  networkEnforced: boolean;
}

/**
 * Create a sandbox model for an execution.
 * The workspace path is deterministic: {sandboxRoot}/{executionId}/
 */
export function createSandboxModel(
  executionId: string,
  sandboxRoot: string = "/tmp/forge-runtime"
): SandboxModel {
  return {
    sandboxRoot,
    workspacePath: `${sandboxRoot}/${executionId}`,
    destroyAfterExecution: true,
    cachesAllowed: false,
    cachesInEvidence: false,
    // Phase 18D: Current implementation is filesystem-only.
    // Production deployment must upgrade to "container" or "microvm".
    isolationLevel: "filesystem-only",
    // Phase 18D: Network is NOT physically enforced in filesystem-only mode.
    // The network policy is recorded but not physically blocked.
    // Container mode would enforce via network namespace.
    networkEnforced: false,
  };
}

// ---------------------------------------------------------------------------
// 2. COMMAND MODEL — commands as data, not strings
// ---------------------------------------------------------------------------

/**
 * A structured command for the executor to run.
 * The executor does NOT reason about commands — it executes them as-is.
 *
 * The command is an array (like execFileSync) to prevent shell injection.
 * No string splitting, no shell interpolation.
 */
export interface RuntimeCommand {
  /** Command binary (e.g., "npm", "pnpm", "python", "go"). */
  binary: string;
  /** Arguments array (never a single string). */
  args: string[];
  /** Working directory (relative to workspace). */
  cwd: string;
  /** Timeout in milliseconds. The executor enforces this. */
  timeoutMs: number;
  /** Environment variables to set (merged with sandbox environment). */
  env?: Record<string, string>;
}

/**
 * The full command set for a runtime verification execution.
 * Each stage has its own command — the executor runs them in sequence.
 */
export interface RuntimeCommandSet {
  install: RuntimeCommand;
  build: RuntimeCommand;
  start: RuntimeCommand;
}

// ---------------------------------------------------------------------------
// 3. PROCESS LIFECYCLE
// ---------------------------------------------------------------------------

/**
 * Process lifecycle guarantees for the application server.
 *
 * The executor must:
 *   1. spawn the start command
 *   2. capture stdout/stderr continuously
 *   3. enforce startup timeout
 *   4. on timeout/teardown: SIGTERM
 *   5. wait grace period
 *   6. if still alive: SIGKILL
 *   7. clean up child processes
 */
export interface ProcessLifecycle {
  /** Timeout for the server to start listening on the expected port. */
  startupTimeoutMs: number;
  /** Grace period between SIGTERM and SIGKILL. */
  terminationGraceMs: number;
  /** Whether to kill child processes (process groups). */
  killChildProcesses: boolean;
}

export interface ProcessEvidence {
  processStartedAt: string;
  processStoppedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  forcedTermination: boolean;
  pid: number | null;
}

// ---------------------------------------------------------------------------
// 4. NETWORK POLICY
// ---------------------------------------------------------------------------

/**
 * Network policy for runtime verification.
 *
 * The architecture MUST declare which mode is used. Never silently allow network.
 *
 * HERMETIC: Internet disabled. Only local services allowed. Best reproducibility.
 * INTEGRATION: Internet allowed. External dependencies recorded. Better realism.
 */
export type NetworkMode = "hermetic" | "integration";

export interface NetworkPolicy {
  mode: NetworkMode;
  /** Allowed hosts (for integration mode). Empty = all blocked. */
  allowedHosts: string[];
  /** Whether to record all outbound network calls in evidence. */
  recordOutbound: boolean;
}

// ---------------------------------------------------------------------------
// 5. ENVIRONMENT FINGERPRINT
// ---------------------------------------------------------------------------

/**
 * Full environment fingerprint for reproducibility.
 * NEVER stores secrets — only hashes of environment variable names.
 */
export interface EnvironmentFingerprintFull {
  os: string;
  architecture: string;
  nodeVersion: string;
  /** Package manager detected (npm, pnpm, yarn, pip, go, cargo). */
  packageManager: string;
  /** Container image hash if running in a container (null if bare metal). */
  containerImageHash: string | null;
  /** Hash of environment variable NAMES (not values — never secrets). */
  environmentVariablesHash: string;
  /** Timestamp the fingerprint was captured. */
  timestamp: string;
}

/**
 * Capture the environment fingerprint.
 * This runs in the worker process, so it reflects the actual execution environment.
 */
export function captureEnvironmentFingerprint(
  packageManager: string = "unknown",
  containerImageHash: string | null = null
): EnvironmentFingerprintFull {
  // Hash environment variable NAMES only (not values — never secrets).
  const envNames = Object.keys(process.env).sort().join(",");
  const envHash = createHash("sha256").update(envNames).digest("hex");

  return {
    os: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    packageManager,
    containerImageHash,
    environmentVariablesHash: envHash,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 6. EVIDENCE CAPTURE — continuous per-stage
// ---------------------------------------------------------------------------

/**
 * A single evidence event captured during execution.
 * Evidence is captured continuously — not just at the end.
 * If the worker crashes, partial evidence survives.
 */
export interface EvidenceEvent {
  stage: RuntimeStage;
  timestamp: string;
  success: boolean;
  durationMs: number;
  exitCode: number | null;
  output: string; // truncated stdout+stderr
  error?: string;
}

export type RuntimeStage =
  | "workspace-create"
  | "repository-checkout"
  | "dependency-install"
  | "build"
  | "application-start"
  | "health-check"
  | "api-journey"
  | "integration-check"
  | "background-job-check"
  | "browser-journey"
  | "application-stop"
  | "workspace-destroy";

// ---------------------------------------------------------------------------
// 7. RUNTIME EXECUTION POLICY — the full contract
// ---------------------------------------------------------------------------

/**
 * The complete execution contract for a runtime verification.
 *
 * This is derived from the RuntimeVerificationPlan + the frozen architecture's
 * deployment model. It contains everything the executor needs to run without
 * making any decisions.
 */
export interface RuntimeExecutionPolicy {
  /** The exact SHA to checkout and verify. */
  repositoryHeadSha: string;
  /** The GitHub repo slug (owner/name) for identity binding. */
  githubRepo: string;
  /**
   * Phase 18V: The fully-qualified repository URL used by `git clone`.
   *
   * In production this is an authenticated HTTPS URL
   * (`https://x-access-token:<token>@github.com/<owner>/<repo>.git`)
   * resolved by the worker from the control plane's
   * `/api/worker/resolve-github-credential` endpoint. The worker passes the
   * URL into `executeRuntimeVerification` so the executor itself never
   * resolves credentials — it just clones what it's given.
   *
   * For local/dev runs this may be a filesystem path.
   */
  repositoryUrl: string;

  /** Sandbox isolation model. */
  sandbox: SandboxModel;

  /** Structured commands (no strings, no reasoning). */
  commands: RuntimeCommandSet;

  /** Process lifecycle guarantees. */
  lifecycle: ProcessLifecycle;

  /** Network policy (hermetic or integration). */
  network: NetworkPolicy;

  /** Expected port the application will listen on. */
  expectedPort: number;

  /** Environment fingerprint (captured at execution time). */
  environmentFingerprint: EnvironmentFingerprintFull;

  /** The plan hash (from Phase 18B) for evidence binding. */
  runtimePlanHash: string;

  /** The architecture hash for evidence binding. */
  architectureHash: string | null;

  /**
   * Phase 18W: The executionId bound into the launcher signature. The
   * control plane verifies this matches the executionId in canonicalFactsJson.
   * Binds the substrate attestation to a specific execution.
   */
  executionId: string;
}

// ---------------------------------------------------------------------------
// Execution policy derivation — from plan + architecture
// ---------------------------------------------------------------------------

/**
 * Derive a RuntimeExecutionPolicy from a RuntimeVerificationPlan.
 *
 * The policy is the frozen contract the executor uses. The executor does NOT
 * make decisions — it follows the policy exactly.
 *
 * This function converts the plan's command arrays into structured RuntimeCommand
 * objects with explicit timeouts, cwds, and env.
 */
export function deriveRuntimeExecutionPolicy(
  plan: {
    repositoryHeadSha: string;
    githubRepo: string;
    githubDefaultBranch: string;
    installCommands: string[];
    buildCommands: string[];
    startCommand: string;
    expectedPort: number;
    startupTimeoutMs: number;
    teardownTimeoutMs: number;
  },
  options: {
    executionId: string;
    sandboxRoot?: string;
    networkMode?: NetworkMode;
    packageManager?: string;
    containerImageHash?: string | null;
    runtimePlanHash: string;
    architectureHash: string | null;
    /**
     * Phase 18V: Fully-qualified URL for `git clone`. In production this is
     * the authenticated `https://x-access-token:<token>@github.com/...` URL
     * resolved by the worker. Required for real checkout (no simulated clone).
     * If omitted, the policy's repositoryUrl is empty and the executor will
     * fail the checkout step (fail-closed).
     */
    repositoryUrl?: string;
  }
): RuntimeExecutionPolicy {
  const sandbox = createSandboxModel(options.executionId, options.sandboxRoot);

  // Parse command strings into structured RuntimeCommand objects.
  // The plan declares commands as string arrays — we split into binary + args.
  const parseCommand = (cmd: string, cwd: string, timeoutMs: number): RuntimeCommand => {
    const parts = cmd.split(/\s+/).filter(Boolean);
    return {
      binary: parts[0] || "",
      args: parts.slice(1),
      cwd,
      timeoutMs,
    };
  };

  const commands: RuntimeCommandSet = {
    install: parseCommand(plan.installCommands[0], "repo", 600000),
    build: parseCommand(plan.buildCommands[0], "repo", 600000),
    start: parseCommand(plan.startCommand, "repo", plan.startupTimeoutMs),
  };

  const lifecycle: ProcessLifecycle = {
    startupTimeoutMs: plan.startupTimeoutMs,
    terminationGraceMs: 5000, // 5 second grace period between SIGTERM and SIGKILL
    killChildProcesses: true,
  };

  const network: NetworkPolicy = {
    mode: options.networkMode || "hermetic", // Default: hermetic (no network)
    allowedHosts: [],
    recordOutbound: true,
  };

  const environmentFingerprint = captureEnvironmentFingerprint(
    options.packageManager,
    options.containerImageHash ?? null
  );

  return {
    repositoryHeadSha: plan.repositoryHeadSha,
    githubRepo: plan.githubRepo,
    repositoryUrl: options.repositoryUrl ?? "",
    sandbox,
    commands,
    lifecycle,
    network,
    expectedPort: plan.expectedPort,
    environmentFingerprint,
    runtimePlanHash: options.runtimePlanHash,
    architectureHash: options.architectureHash,
    // Phase 18W: launcher trust fields.
    executionId: options.executionId,
  };
}

// ---------------------------------------------------------------------------
// Workspace paths — deterministic per execution
// ---------------------------------------------------------------------------

export interface WorkspacePaths {
  root: string;
  repo: string;
  logs: string;
  artifacts: string;
}

/**
 * Get the deterministic workspace paths for an execution.
 */
export function getWorkspacePaths(sandbox: SandboxModel): WorkspacePaths {
  return {
    root: sandbox.workspacePath,
    repo: `${sandbox.workspacePath}/repo`,
    logs: `${sandbox.workspacePath}/logs`,
    artifacts: `${sandbox.workspacePath}/artifacts`,
  };
}

// ---------------------------------------------------------------------------
// Phase 18F: Complete Evidence Envelope + Asymmetric Signing
// ---------------------------------------------------------------------------
//
// Phase 18E implemented Ed25519 signing but:
//   1. The endpoint never called verifyEvidenceSignature() — unused primitive.
//   2. Only high-level verdict was signed, not the complete stage evidence.
//   3. workerId/executionId/leaseId were not cryptographically bound.
//
// Phase 18F fixes all three:
//   - ExecutionEvidenceEnvelope covers ALL stage results + metadata.
//   - resultHash = SHA-256(canonical complete result).
//   - envelopeHash = SHA-256(canonical complete envelope including metadata).
//   - signature = Ed25519(workerPrivateKey, envelopeHash).
//   - The control plane MUST verify the signature before persisting evidence.
//

import { sign as cryptoSign, verify as cryptoVerify, generateKeyPairSync } from "node:crypto";

/**
 * Phase 18F: The COMPLETE evidence envelope.
 *
 * This is what gets signed. Every field is included in the canonical
 * serialization. A valid signature proves:
 *   - This worker signed this exact execution evidence.
 *   - The stage results (install/build/startup/health/API/teardown) are
 *     cryptographically bound to the verdict.
 *   - workerId, executionId, leaseId are bound to the evidence.
 *
 * A compromised worker cannot tamper with any field without invalidating
 * the signature.
 */
export interface ExecutionEvidenceEnvelope {
  // Identity (bound into signature)
  executionId: string;
  workerId: string;
  leaseId: string;

  // Canonical state (bound into signature)
  repositoryHeadSha: string;
  architectureHash: string | null;
  runtimePlanHash: string;

  // Environment (bound into signature)
  environmentFingerprint: {
    os: string;
    architecture: string;
    nodeVersion: string;
    packageManager: string;
    containerImageHash: string | null;
    environmentVariablesHash: string;
    timestamp: string;
  };

  // COMPLETE stage evidence (bound into signature — not just high-level verdict)
  dependencyInstallResult: { success: boolean; durationMs: number; exitCode: number | null; output: string };
  buildResult: { success: boolean; durationMs: number; exitCode: number | null; output: string };
  startupResult: { success: boolean; durationMs: number; exitCode: number | null; output: string; port: number; pid: number | null };
  healthChecks: { name: string; path: string; passed: boolean; status: number | null; responseTimeMs: number }[];
  apiJourneys: { name: string; passed: boolean; stepsCompleted: number; stepsTotal: number }[];
  integrationChecks: { name: string; type: string; passed: boolean }[];
  backgroundJobChecks: { name: string; type: string; passed: boolean }[];
  browserJourneys: { name: string; url: string; passed: boolean }[];
  teardownResult: { success: boolean; durationMs: number };

  // Overall verdict (bound into signature)
  passed: boolean;
  failureReason: string | null;

  // Timing (bound into signature)
  startedAt: string;
  completedAt: string;

  // Phase 18G: Logs are INSIDE the signed envelope (not a separate unsigned field).
  logs: string;

  // Phase 18V: Observed substrate attestation — proves the execution ran
  // inside a real isolation boundary. Bound into the result hash AND the
  // envelope hash (so it is Ed25519-authenticated). Null =>
  // executionEnvironmentSandboxed is false => PRODUCTION_READY blocked.
  // Fail-closed: no attestation = no production.
  substrateAttestation: SandboxAttestation | null;

  /**
   * Phase 18Z-A: Content-addressed artifact manifest. Binds ALL execution
   * artifacts (install.log, build.log, runtime-stdout, runtime-stderr, health
   * traces, the substrate attestation itself, ...) via SHA-256 content hashes.
   *
   * The manifest is signed by the LAUNCHER (inside the substrate, with the
   * launcher key — the SAME key that signs the attestation). It is bound into
   * the result hash AND the envelope hash, so the worker's Ed25519 signature
   * covers it.
   *
   * Fail-closed: null manifest => artifactManifestVerified is false =>
   * PRODUCTION_READY blocked. Forge never trusts "build.log exists" — it
   * trusts `sha256(build.log) === <signed manifest hash>`.
   */
  artifactManifest: ArtifactManifest | null;

  // Derived hashes (computed from the above, included in envelope)
  resultHash: string;
  envelopeHash: string;

  // Signature over envelopeHash
  signature: EvidenceSignature;
}

/**
 * Phase 18F: Asymmetric evidence signature (Ed25519).
 */
export interface EvidenceSignature {
  /** Digital signature (hex) over the envelope hash. */
  signature: string;
  /** Signing algorithm used. */
  algorithm: "ed25519";
  /** The worker ID that signed the evidence. */
  workerId: string;
  /** The execution ID the evidence belongs to. */
  executionId: string;
  /** Timestamp the signature was created. */
  signedAt: string;
}

/**
 * Phase 18E: Worker key pair for evidence signing.
 */
export interface WorkerKeyPair {
  workerId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

/**
 * Generate an Ed25519 key pair for a worker.
 */
export function generateWorkerKeyPair(workerId: string): WorkerKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    workerId,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/**
 * Phase 18F: Compute the result hash — SHA-256 of the canonical complete result.
 *
 * This covers ALL stage evidence, not just the high-level verdict.
 */
export function computeResultHash(result: Omit<ExecutionEvidenceEnvelope, "resultHash" | "envelopeHash" | "signature">): string {
  // Extract only the result fields (exclude metadata that goes into envelopeHash).
  const resultFields = {
    apiJourneys: result.apiJourneys,
    artifactManifest: result.artifactManifest, // Phase 18Z-A
    backgroundJobChecks: result.backgroundJobChecks,
    browserJourneys: result.browserJourneys,
    buildResult: result.buildResult,
    completedAt: result.completedAt,
    dependencyInstallResult: result.dependencyInstallResult,
    failureReason: result.failureReason,
    healthChecks: result.healthChecks,
    integrationChecks: result.integrationChecks,
    passed: result.passed,
    startedAt: result.startedAt,
    startupResult: result.startupResult,
    substrateAttestation: result.substrateAttestation, // Phase 18V
    teardownResult: result.teardownResult,
  };
  return createHash("sha256").update(canonicalSerialize(resultFields)).digest("hex");
}

/**
 * Phase 18F: Compute the envelope hash — SHA-256 of the canonical complete envelope
 * (including identity, state, environment, result hash, but excluding the signature itself).
 */
export function computeEnvelopeHash(
  envelope: Omit<ExecutionEvidenceEnvelope, "signature">
): string {
  const envelopeFields = {
    architectureHash: envelope.architectureHash,
    artifactManifest: envelope.artifactManifest, // Phase 18Z-A
    completedAt: envelope.completedAt,
    dependencyInstallResult: envelope.dependencyInstallResult,
    environmentFingerprint: envelope.environmentFingerprint,
    executionId: envelope.executionId,
    failureReason: envelope.failureReason,
    leaseId: envelope.leaseId,
    logs: envelope.logs, // Phase 18G: logs are INSIDE the signed envelope.
    passed: envelope.passed,
    repositoryHeadSha: envelope.repositoryHeadSha,
    resultHash: envelope.resultHash,
    runtimePlanHash: envelope.runtimePlanHash,
    startedAt: envelope.startedAt,
    substrateAttestation: envelope.substrateAttestation, // Phase 18V
    workerId: envelope.workerId,
    // Include all stage results in the envelope hash too.
    apiJourneys: envelope.apiJourneys,
    backgroundJobChecks: envelope.backgroundJobChecks,
    browserJourneys: envelope.browserJourneys,
    buildResult: envelope.buildResult,
    healthChecks: envelope.healthChecks,
    integrationChecks: envelope.integrationChecks,
    startupResult: envelope.startupResult,
    teardownResult: envelope.teardownResult,
  };
  return createHash("sha256").update(canonicalSerialize(envelopeFields)).digest("hex");
}

/**
 * Phase 18F: Sign the COMPLETE evidence envelope.
 *
 * The signature covers:
 *   - Identity: executionId, workerId, leaseId
 *   - State: repositoryHeadSha, architectureHash, runtimePlanHash
 *   - Environment: full fingerprint
 *   - Results: ALL stage evidence (install, build, startup, health, API, teardown)
 *   - Verdict: passed, failureReason
 *   - Timing: startedAt, completedAt
 *   - Derived: resultHash, envelopeHash
 *
 * A valid signature proves the worker attests to the COMPLETE evidence,
 * not just a high-level verdict.
 */
export function signEvidenceEnvelope(
  envelope: Omit<ExecutionEvidenceEnvelope, "signature">,
  privateKeyPem: string
): EvidenceSignature {
  const data = Buffer.from(envelope.envelopeHash, "utf-8");

  // Ed25519 signs the envelope hash directly.
  const signature = cryptoSign(null, data, privateKeyPem).toString("hex");

  return {
    signature,
    algorithm: "ed25519",
    workerId: envelope.workerId,
    executionId: envelope.executionId,
    signedAt: new Date().toISOString(),
  };
}

/**
 * Phase 18F: Verify the complete evidence envelope signature.
 *
 * @returns true if the signature is valid for this envelope + public key.
 */
export function verifyEvidenceEnvelope(
  envelope: ExecutionEvidenceEnvelope,
  publicKeyPem: string
): boolean {
  // Recompute the envelope hash from the envelope (excluding signature).
  const { signature: _sig, ...envelopeWithoutSig } = envelope;
  const expectedHash = computeEnvelopeHash(envelopeWithoutSig);

  // Verify the envelope hash matches.
  if (expectedHash !== envelope.envelopeHash) {
    return false;
  }

  // Verify the signature over the envelope hash.
  const data = Buffer.from(envelope.envelopeHash, "utf-8");
  const sigBuf = Buffer.from(envelope.signature.signature, "hex");

  try {
    return cryptoVerify(null, data, publicKeyPem, sigBuf);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible signEvidence/verifyEvidenceSignature (deprecated)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use signEvidenceEnvelope/verifyEvidenceEnvelope instead.
 * Phase 18F replaces partial signing with complete envelope signing.
 */
export function signEvidence(
  result: {
    repositoryHeadSha: string;
    passed: boolean;
    failureReason: string | null;
    environmentFingerprint: { environmentVariablesHash: string };
  },
  runtimePlanHash: string,
  architectureHash: string | null,
  privateKeyPem: string,
  workerId: string,
  executionId: string
): EvidenceSignature {
  const canonical = canonicalSerialize({
    architectureHash,
    environmentVariablesHash: result.environmentFingerprint.environmentVariablesHash,
    failureReason: result.failureReason,
    passed: result.passed,
    repositoryHeadSha: result.repositoryHeadSha,
    runtimePlanHash,
  });
  const data = Buffer.from(canonical, "utf-8");
  const signature = cryptoSign(null, data, privateKeyPem).toString("hex");
  return { signature, algorithm: "ed25519", workerId, executionId, signedAt: new Date().toISOString() };
}

/**
 * @deprecated Use verifyEvidenceEnvelope instead.
 */
export function verifyEvidenceSignature(
  result: {
    repositoryHeadSha: string;
    passed: boolean;
    failureReason: string | null;
    environmentFingerprint: { environmentVariablesHash: string };
  },
  runtimePlanHash: string,
  architectureHash: string | null,
  sig: EvidenceSignature,
  publicKeyPem: string
): boolean {
  const canonical = canonicalSerialize({
    architectureHash,
    environmentVariablesHash: result.environmentFingerprint.environmentVariablesHash,
    failureReason: result.failureReason,
    passed: result.passed,
    repositoryHeadSha: result.repositoryHeadSha,
    runtimePlanHash,
  });
  const data = Buffer.from(canonical, "utf-8");
  const sigBuf = Buffer.from(sig.signature, "hex");
  try { return cryptoVerify(null, data, publicKeyPem, sigBuf); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Phase 18D: Replayability — verify evidence is reproducible
// ---------------------------------------------------------------------------

/**
 * Phase 18D: Replayability identity.
 *
 * Given the same repositoryHeadSha + runtimePlanHash + architectureHash +
 * environmentFingerprint, a runtime verification should be reproducible.
 *
 * This is the identity that makes evidence deterministic.
 */
export interface ReplayabilityIdentity {
  repositoryHeadSha: string;
  runtimePlanHash: string;
  architectureHash: string | null;
  environmentVariablesHash: string;
}

/**
 * Phase 18D: Create a replayability identity from an execution policy + result.
 */
export function createReplayabilityIdentity(
  policy: RuntimeExecutionPolicy,
  result: { environmentFingerprint: { environmentVariablesHash: string } }
): ReplayabilityIdentity {
  return {
    repositoryHeadSha: policy.repositoryHeadSha,
    runtimePlanHash: policy.runtimePlanHash,
    architectureHash: policy.architectureHash,
    environmentVariablesHash: result.environmentFingerprint.environmentVariablesHash,
  };
}

/**
 * Phase 18D: Check if two runtime evidence records are replay-compatible.
 *
 * Two evidence records are replay-compatible if they share the same
 * replayability identity (same SHA + plan + architecture + environment).
 */
export function isReplayCompatible(
  a: ReplayabilityIdentity,
  b: ReplayabilityIdentity
): boolean {
  return (
    a.repositoryHeadSha === b.repositoryHeadSha &&
    a.runtimePlanHash === b.runtimePlanHash &&
    a.architectureHash === b.architectureHash &&
    a.environmentVariablesHash === b.environmentVariablesHash
  );
}
