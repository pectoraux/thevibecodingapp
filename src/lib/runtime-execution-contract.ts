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
  const envHash = createHash("sha256").update(envNames).digest("hex").slice(0, 16);

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
  /** The GitHub repo to clone. */
  githubRepo: string;

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
    sandbox,
    commands,
    lifecycle,
    network,
    expectedPort: plan.expectedPort,
    environmentFingerprint,
    runtimePlanHash: options.runtimePlanHash,
    architectureHash: options.architectureHash,
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
// Phase 18E: Evidence Signing — Asymmetric (Ed25519) signature
// ---------------------------------------------------------------------------
//
// Phase 18D used HMAC-SHA256 with a shared secret. This was wrong for a
// distributed architecture: a compromised worker that obtains the shared
// secret can manufacture valid evidence.
//
// Phase 18E replaces HMAC with asymmetric signing:
//   - Worker holds a PRIVATE key (never shared with the control plane).
//   - Control plane holds the worker's PUBLIC key.
//   - Worker signs evidence with its private key.
//   - Control plane verifies with the worker's public key.
//
// A compromised worker cannot forge another worker's evidence (different key).
// A compromised control plane cannot fabricate worker evidence (no private key).
//

import { sign as cryptoSign, verify as cryptoVerify, generateKeyPairSync } from "node:crypto";

/**
 * Phase 18E: Asymmetric evidence signature.
 *
 * Uses Ed25519 for simplicity and performance. RSA-SHA256 is also supported
 * for environments where Ed25519 is unavailable.
 */
export interface EvidenceSignature {
  /** Digital signature (hex) over the canonical evidence serialization. */
  signature: string;
  /** Signing algorithm used. */
  algorithm: "ed25519" | "rsa-sha256";
  /** The worker ID that signed the evidence. */
  workerId: string;
  /** The execution ID the evidence belongs to. */
  executionId: string;
  /** Timestamp the signature was created. */
  signedAt: string;
}

/**
 * Phase 18E: Worker key pair for evidence signing.
 *
 * The worker generates this pair at registration time. The private key never
 * leaves the worker. The public key is registered with the control plane.
 */
export interface WorkerKeyPair {
  workerId: string;
  privateKeyPem: string;  // Never sent to control plane.
  publicKeyPem: string;   // Registered with control plane at registration.
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
 * Canonical serialization of evidence for signing.
 * Uses recursive key sorting (same as hashRuntimePlan).
 */
function canonicalEvidenceSerialization(
  result: {
    repositoryHeadSha: string;
    passed: boolean;
    failureReason: string | null;
    environmentFingerprint: { environmentVariablesHash: string };
  },
  runtimePlanHash: string,
  architectureHash: string | null
): string {
  const obj = {
    architectureHash,
    environmentVariablesHash: result.environmentFingerprint.environmentVariablesHash,
    failureReason: result.failureReason,
    passed: result.passed,
    repositoryHeadSha: result.repositoryHeadSha,
    runtimePlanHash,
  };
  // Recursive canonical serialization (sorted keys at every level).
  return canonicalSerialize(obj);
}

/**
 * Phase 18E: Sign evidence with the worker's private key.
 *
 * @param result The runtime verification result to sign.
 * @param runtimePlanHash The plan hash.
 * @param architectureHash The architecture hash.
 * @param privateKeyPem The worker's private key (PEM).
 * @param workerId The worker's ID.
 * @param executionId The execution ID.
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
  const canonical = canonicalEvidenceSerialization(result, runtimePlanHash, architectureHash);
  const data = Buffer.from(canonical, "utf-8");

  // Ed25519 uses null digest (signs the raw data, not a hash of it).
  const signature = cryptoSign(null, data, privateKeyPem).toString("hex");

  return {
    signature,
    algorithm: "ed25519",
    workerId,
    executionId,
    signedAt: new Date().toISOString(),
  };
}

/**
 * Phase 18E: Verify evidence signature with the worker's public key.
 *
 * @returns true if the signature is valid for this evidence + public key.
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
  const canonical = canonicalEvidenceSerialization(result, runtimePlanHash, architectureHash);
  const data = Buffer.from(canonical, "utf-8");
  const sigBuf = Buffer.from(sig.signature, "hex");

  try {
    return cryptoVerify(null, data, publicKeyPem, sigBuf);
  } catch {
    return false;
  }
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
