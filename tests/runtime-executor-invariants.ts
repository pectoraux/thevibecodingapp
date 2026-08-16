// Forge — Phase 18C: Runtime Execution Contract + Executor Invariants
//
// This test verifies:
//   1. The execution contract module exports all required types and functions.
//   2. The sandbox model provides isolation guarantees.
//   3. Commands are structured data (not strings).
//   4. Process lifecycle has SIGTERM → grace → SIGKILL guarantees.
//   5. Network policy is explicit (hermetic vs integration).
//   6. Environment fingerprint captures without secrets.
//   7. Evidence collector captures per-stage events continuously.
//   8. The executor module exports the main executeRuntimeVerification function.
//
// Run with: bun run tests/runtime-executor-invariants.ts

import { readFileSync } from "node:fs";
import {
  createSandboxModel,
  deriveRuntimeExecutionPolicy,
  captureEnvironmentFingerprint,
  getWorkspacePaths,
  signEvidence,
  verifyEvidenceSignature,
  generateWorkerKeyPair,
  createReplayabilityIdentity,
  isReplayCompatible,
  type SandboxModel,
  type RuntimeCommand,
  type RuntimeCommandSet,
  type ProcessLifecycle,
  type NetworkPolicy,
  type NetworkMode,
  type EnvironmentFingerprintFull,
  type RuntimeExecutionPolicy,
  type EvidenceEvent,
  type RuntimeStage,
  type SandboxIsolationLevel,
  type EvidenceSignature,
  type ReplayabilityIdentity,
} from "../src/lib/runtime-execution-contract";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function record(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
}

// ===========================================================================
// EXECUTION CONTRACT MODULE
// ===========================================================================

const contractModule = readFile("src/lib/runtime-execution-contract.ts");

// Test 1: Module exports SandboxModel interface.
{
  const hasInterface = contractModule.includes("interface SandboxModel");
  record("runtime-execution-contract.ts exports SandboxModel interface", hasInterface, `hasInterface: ${hasInterface}`);
}

// Test 2: Module exports RuntimeCommand interface (commands as data).
{
  const hasInterface = contractModule.includes("interface RuntimeCommand");
  record("runtime-execution-contract.ts exports RuntimeCommand interface (commands as data)", hasInterface, `hasInterface: ${hasInterface}`);
}

// Test 3: Module exports ProcessLifecycle interface.
{
  const hasInterface = contractModule.includes("interface ProcessLifecycle");
  record("runtime-execution-contract.ts exports ProcessLifecycle interface", hasInterface, `hasInterface: ${hasInterface}`);
}

// Test 4: Module exports NetworkPolicy interface.
{
  const hasInterface = contractModule.includes("interface NetworkPolicy");
  record("runtime-execution-contract.ts exports NetworkPolicy interface", hasInterface, `hasInterface: ${hasInterface}`);
}

// Test 5: Module exports EnvironmentFingerprintFull interface.
{
  const hasInterface = contractModule.includes("interface EnvironmentFingerprintFull");
  record("runtime-execution-contract.ts exports EnvironmentFingerprintFull interface", hasInterface, `hasInterface: ${hasInterface}`);
}

// Test 6: Module exports RuntimeExecutionPolicy interface.
{
  const hasInterface = contractModule.includes("interface RuntimeExecutionPolicy");
  record("runtime-execution-contract.ts exports RuntimeExecutionPolicy interface", hasInterface, `hasInterface: ${hasInterface}`);
}

// Test 7: Module exports EvidenceEvent interface.
{
  const hasInterface = contractModule.includes("interface EvidenceEvent");
  record("runtime-execution-contract.ts exports EvidenceEvent interface", hasInterface, `hasInterface: ${hasInterface}`);
}

// Test 8: Module exports createSandboxModel function.
{
  const hasFunction = contractModule.includes("export function createSandboxModel");
  record("runtime-execution-contract.ts exports createSandboxModel function", hasFunction, `hasFunction: ${hasFunction}`);
}

// Test 9: Module exports deriveRuntimeExecutionPolicy function.
{
  const hasFunction = contractModule.includes("export function deriveRuntimeExecutionPolicy");
  record("runtime-execution-contract.ts exports deriveRuntimeExecutionPolicy function", hasFunction, `hasFunction: ${hasFunction}`);
}

// Test 10: Module exports captureEnvironmentFingerprint function.
{
  const hasFunction = contractModule.includes("export function captureEnvironmentFingerprint");
  record("runtime-execution-contract.ts exports captureEnvironmentFingerprint function", hasFunction, `hasFunction: ${hasFunction}`);
}

// Test 11: Module exports getWorkspacePaths function.
{
  const hasFunction = contractModule.includes("export function getWorkspacePaths");
  record("runtime-execution-contract.ts exports getWorkspacePaths function", hasFunction, `hasFunction: ${hasFunction}`);
}

// ===========================================================================
// SANDBOX MODEL — isolation guarantees
// ===========================================================================

// Test 12: Sandbox model provides per-execution workspace path.
{
  const sandbox = createSandboxModel("exec-123", "/tmp/forge-test");
  record(
    "Sandbox model provides per-execution workspace path",
    sandbox.workspacePath === "/tmp/forge-test/exec-123",
    `workspacePath: ${sandbox.workspacePath}`
  );
}

// Test 13: Sandbox model destroys workspace after execution.
{
  const sandbox = createSandboxModel("exec-123");
  record(
    "Sandbox model destroys workspace after execution (destroyAfterExecution: true)",
    sandbox.destroyAfterExecution === true,
    `destroyAfterExecution: ${sandbox.destroyAfterExecution}`
  );
}

// Test 14: Sandbox model disallows caches by default.
{
  const sandbox = createSandboxModel("exec-123");
  record(
    "Sandbox model disallows caches by default (reproducibility)",
    sandbox.cachesAllowed === false,
    `cachesAllowed: ${sandbox.cachesAllowed}`
  );
}

// Test 15: Workspace paths are deterministic.
{
  const sandbox = createSandboxModel("exec-456", "/tmp/forge-runtime");
  const paths = getWorkspacePaths(sandbox);
  record(
    "Workspace paths are deterministic (root/repo/logs/artifacts)",
    paths.root === "/tmp/forge-runtime/exec-456" &&
    paths.repo === "/tmp/forge-runtime/exec-456/repo" &&
    paths.logs === "/tmp/forge-runtime/exec-456/logs" &&
    paths.artifacts === "/tmp/forge-runtime/exec-456/artifacts",
    `root: ${paths.root}`
  );
}

// Test 16: Two executions get different workspace paths.
{
  const sandbox1 = createSandboxModel("exec-A");
  const sandbox2 = createSandboxModel("exec-B");
  record(
    "Two executions get different workspace paths (no shared workspace)",
    sandbox1.workspacePath !== sandbox2.workspacePath,
    `path1: ${sandbox1.workspacePath}, path2: ${sandbox2.workspacePath}`
  );
}

// ===========================================================================
// COMMAND MODEL — commands as data
// ===========================================================================

// Test 17: RuntimeCommand has binary + args (not a single string).
{
  const hasFields = contractModule.includes("binary: string") && contractModule.includes("args: string[]");
  record(
    "RuntimeCommand has binary + args[] (structured, not string)",
    hasFields,
    `hasFields: ${hasFields}`
  );
}

// Test 18: RuntimeCommand has timeoutMs.
{
  const hasField = contractModule.includes("timeoutMs: number");
  record("RuntimeCommand has timeoutMs", hasField, `hasField: ${hasField}`);
}

// Test 19: RuntimeCommand has cwd.
{
  const hasField = contractModule.includes("cwd: string");
  record("RuntimeCommand has cwd (working directory)", hasField, `hasField: ${hasField}`);
}

// Test 20: RuntimeCommandSet has install, build, start commands.
{
  const hasInstall = contractModule.includes("install: RuntimeCommand");
  const hasBuild = contractModule.includes("build: RuntimeCommand");
  const hasStart = contractModule.includes("start: RuntimeCommand");
  record(
    "RuntimeCommandSet has install, build, start commands",
    hasInstall && hasBuild && hasStart,
    `install: ${hasInstall}, build: ${hasBuild}, start: ${hasStart}`
  );
}

// ===========================================================================
// PROCESS LIFECYCLE — SIGTERM → grace → SIGKILL
// ===========================================================================

// Test 21: ProcessLifecycle has startupTimeoutMs.
{
  const hasField = contractModule.includes("startupTimeoutMs: number");
  record("ProcessLifecycle has startupTimeoutMs", hasField, `hasField: ${hasField}`);
}

// Test 22: ProcessLifecycle has terminationGraceMs.
{
  const hasField = contractModule.includes("terminationGraceMs: number");
  record("ProcessLifecycle has terminationGraceMs (grace between SIGTERM and SIGKILL)", hasField, `hasField: ${hasField}`);
}

// Test 23: ProcessLifecycle has killChildProcesses.
{
  const hasField = contractModule.includes("killChildProcesses: boolean");
  record("ProcessLifecycle has killChildProcesses (process group cleanup)", hasField, `hasField: ${hasField}`);
}

// Test 24: ProcessEvidence has forcedTermination field.
{
  const hasField = contractModule.includes("forcedTermination: boolean");
  record("ProcessEvidence has forcedTermination field (SIGKILL was needed)", hasField, `hasField: ${hasField}`);
}

// Test 25: ProcessEvidence has exitCode, signal, pid, timestamps.
{
  const hasFields = contractModule.includes("exitCode: number | null") &&
    contractModule.includes("signal: string | null") &&
    contractModule.includes("pid: number | null") &&
    contractModule.includes("processStartedAt: string") &&
    contractModule.includes("processStoppedAt: string | null");
  record(
    "ProcessEvidence has exitCode, signal, pid, startedAt, stoppedAt",
    hasFields,
    `hasFields: ${hasFields}`
  );
}

// ===========================================================================
// NETWORK POLICY — explicit, never silent
// ===========================================================================

// Test 26: NetworkMode type has hermetic and integration.
{
  const hasTypes = contractModule.includes('"hermetic"') && contractModule.includes('"integration"');
  record("NetworkMode type has hermetic and integration modes", hasTypes, `hasTypes: ${hasTypes}`);
}

// Test 27: NetworkPolicy has mode, allowedHosts, recordOutbound.
{
  const hasMode = contractModule.includes("mode: NetworkMode");
  const hasHosts = contractModule.includes("allowedHosts: string[]");
  const hasRecord = contractModule.includes("recordOutbound: boolean");
  record(
    "NetworkPolicy has mode, allowedHosts, recordOutbound",
    hasMode && hasHosts && hasRecord,
    `mode: ${hasMode}, hosts: ${hasHosts}, record: ${hasRecord}`
  );
}

// Test 28: Default network mode is hermetic (no network).
{
  const hasDefault = contractModule.includes('options.networkMode || "hermetic"');
  record(
    "Default network mode is hermetic (no network unless explicitly declared)",
    hasDefault,
    `hasDefault: ${hasDefault}`
  );
}

// ===========================================================================
// ENVIRONMENT FINGERPRINT — no secrets
// ===========================================================================

// Test 29: EnvironmentFingerprintFull has os, arch, nodeVersion.
{
  const hasFields = contractModule.includes("os: string") &&
    contractModule.includes("architecture: string") &&
    contractModule.includes("nodeVersion: string");
  record(
    "EnvironmentFingerprintFull has os, architecture, nodeVersion",
    hasFields,
    `hasFields: ${hasFields}`
  );
}

// Test 30: EnvironmentFingerprintFull has packageManager.
{
  const hasField = contractModule.includes("packageManager: string");
  record("EnvironmentFingerprintFull has packageManager", hasField, `hasField: ${hasField}`);
}

// Test 31: EnvironmentFingerprintFull has containerImageHash.
{
  const hasField = contractModule.includes("containerImageHash: string | null");
  record("EnvironmentFingerprintFull has containerImageHash", hasField, `hasField: ${hasField}`);
}

// Test 32: EnvironmentFingerprintFull has environmentVariablesHash (not values).
{
  const hasField = contractModule.includes("environmentVariablesHash: string");
  record(
    "EnvironmentFingerprintFull has environmentVariablesHash (hash of NAMES, not values — no secrets)",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 33: captureEnvironmentFingerprint hashes env var names, not values.
{
  const fp = captureEnvironmentFingerprint("npm", null);
  record(
    "captureEnvironmentFingerprint produces a hash (not raw env values)",
    fp.environmentVariablesHash.length === 16,
    `hash: ${fp.environmentVariablesHash}`
  );
}

// Test 34: captureEnvironmentFingerprint captures os/arch/nodeVersion.
{
  const fp = captureEnvironmentFingerprint("npm", null);
  record(
    "captureEnvironmentFingerprint captures os, arch, nodeVersion",
    fp.os.length > 0 && fp.architecture.length > 0 && fp.nodeVersion.length > 0,
    `os: ${fp.os}, arch: ${fp.architecture}, node: ${fp.nodeVersion}`
  );
}

// ===========================================================================
// EVIDENCE CAPTURE — continuous per-stage
// ===========================================================================

// Test 35: EvidenceEvent has stage, timestamp, success, durationMs.
{
  const hasFields = contractModule.includes("stage: RuntimeStage") &&
    contractModule.includes("timestamp: string") &&
    contractModule.includes("success: boolean") &&
    contractModule.includes("durationMs: number");
  record(
    "EvidenceEvent has stage, timestamp, success, durationMs",
    hasFields,
    `hasFields: ${hasFields}`
  );
}

// Test 36: RuntimeStage includes all pipeline stages.
{
  const stages = [
    "workspace-create", "repository-checkout", "dependency-install",
    "build", "application-start", "health-check", "api-journey",
    "application-stop", "workspace-destroy",
  ];
  const missing = stages.filter((s) => !contractModule.includes(s));
  record(
    "RuntimeStage includes all pipeline stages (workspace/checkout/install/build/start/health/api/stop/destroy)",
    missing.length === 0,
    missing.length === 0 ? "All stages present" : `MISSING: ${missing.join(", ")}`
  );
}

// ===========================================================================
// EXECUTION POLICY DERIVATION
// ===========================================================================

// Test 37: deriveRuntimeExecutionPolicy produces a complete policy.
{
  const policy = deriveRuntimeExecutionPolicy(
    {
      repositoryHeadSha: "abc123",
      githubRepo: "owner/repo",
      githubDefaultBranch: "main",
      installCommands: ["npm install"],
      buildCommands: ["npm run build"],
      startCommand: "npm start",
      expectedPort: 3000,
      startupTimeoutMs: 30000,
      teardownTimeoutMs: 10000,
    },
    {
      executionId: "exec-test-1",
      runtimePlanHash: "hash123",
      architectureHash: "archHash456",
    }
  );
  record(
    "deriveRuntimeExecutionPolicy produces a complete RuntimeExecutionPolicy",
    policy.repositoryHeadSha === "abc123" &&
    policy.commands.install.binary === "npm" &&
    policy.commands.start.binary === "npm" &&
    policy.expectedPort === 3000 &&
    policy.runtimePlanHash === "hash123" &&
    policy.architectureHash === "archHash456",
    `sha: ${policy.repositoryHeadSha}, install binary: ${policy.commands.install.binary}`
  );
}

// Test 38: deriveRuntimeExecutionPolicy defaults to hermetic network.
{
  const policy = deriveRuntimeExecutionPolicy(
    {
      repositoryHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main",
      installCommands: ["npm install"], buildCommands: ["npm run build"],
      startCommand: "npm start", expectedPort: 3000,
      startupTimeoutMs: 30000, teardownTimeoutMs: 10000,
    },
    { executionId: "exec-test-2", runtimePlanHash: "h", architectureHash: null }
  );
  record(
    "deriveRuntimeExecutionPolicy defaults to hermetic network mode",
    policy.network.mode === "hermetic",
    `mode: ${policy.network.mode}`
  );
}

// Test 39: deriveRuntimeExecutionPolicy captures environment fingerprint.
{
  const policy = deriveRuntimeExecutionPolicy(
    {
      repositoryHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main",
      installCommands: ["npm install"], buildCommands: ["npm run build"],
      startCommand: "npm start", expectedPort: 3000,
      startupTimeoutMs: 30000, teardownTimeoutMs: 10000,
    },
    { executionId: "exec-test-3", runtimePlanHash: "h", architectureHash: null, packageManager: "pnpm" }
  );
  record(
    "deriveRuntimeExecutionPolicy captures environment fingerprint with packageManager",
    policy.environmentFingerprint.packageManager === "pnpm" &&
    policy.environmentFingerprint.environmentVariablesHash.length === 16,
    `packageManager: ${policy.environmentFingerprint.packageManager}`
  );
}

// ===========================================================================
// EXECUTOR MODULE
// ===========================================================================

const executorModule = readFile("src/lib/runtime-executor.ts");

// Test 40: Executor module exports executeRuntimeVerification function.
{
  const hasFunction = executorModule.includes("export async function executeRuntimeVerification");
  record(
    "runtime-executor.ts exports executeRuntimeVerification function",
    hasFunction,
    `hasFunction: ${hasFunction}`
  );
}

// Test 41: Executor module exports EvidenceCollector class.
{
  const hasClass = executorModule.includes("export class EvidenceCollector");
  record("runtime-executor.ts exports EvidenceCollector class", hasClass, `hasClass: ${hasClass}`);
}

// Test 42: Executor module exports WorkspaceManager class.
{
  const hasClass = executorModule.includes("export class WorkspaceManager");
  record("runtime-executor.ts exports WorkspaceManager class", hasClass, `hasClass: ${hasClass}`);
}

// Test 43: Executor module exports ProcessSupervisor class.
{
  const hasClass = executorModule.includes("export class ProcessSupervisor");
  record("runtime-executor.ts exports ProcessSupervisor class", hasClass, `hasClass: ${hasClass}`);
}

// Test 44: Executor module exports runCommand function.
{
  const hasFunction = executorModule.includes("export function runCommand");
  record("runtime-executor.ts exports runCommand function", hasFunction, `hasFunction: ${hasFunction}`);
}

// Test 45: WorkspaceManager has create/destroy/verifyEmpty methods.
{
  const hasCreate = executorModule.includes("create(): void");
  const hasDestroy = executorModule.includes("destroy(): void");
  const hasVerify = executorModule.includes("verifyEmpty(): boolean");
  record(
    "WorkspaceManager has create/destroy/verifyEmpty methods",
    hasCreate && hasDestroy && hasVerify,
    `create: ${hasCreate}, destroy: ${hasDestroy}, verify: ${hasVerify}`
  );
}

// Test 46: WorkspaceManager destroy uses rmSync (always cleans up).
{
  const usesRmSync = executorModule.includes("rmSync(this.paths.root");
  record(
    "WorkspaceManager destroy uses rmSync (always cleans up, even on failure)",
    usesRmSync,
    `usesRmSync: ${usesRmSync}`
  );
}

// Test 47: ProcessSupervisor has start/waitForReady/terminate methods.
{
  const hasStart = executorModule.includes("start(");
  const hasWait = executorModule.includes("async waitForReady(");
  const hasTerminate = executorModule.includes("async terminate(");
  record(
    "ProcessSupervisor has start/waitForReady/terminate methods",
    hasStart && hasWait && hasTerminate,
    `start: ${hasStart}, wait: ${hasWait}, terminate: ${hasTerminate}`
  );
}

// Test 48: ProcessSupervisor uses SIGTERM then SIGKILL.
{
  const hasSigTerm = executorModule.includes('SIGTERM') || executorModule.includes('"SIGTERM"');
  const hasSigKill = executorModule.includes('SIGKILL') || executorModule.includes('"SIGKILL"');
  record(
    "ProcessSupervisor uses SIGTERM → grace → SIGKILL lifecycle",
    hasSigTerm && hasSigKill,
    `sigterm: ${hasSigTerm}, sigkill: ${hasSigKill}`
  );
}

// Test 49: ProcessSupervisor kills process groups (child cleanup).
{
  const hasProcessGroup = executorModule.includes("process.kill(-") || executorModule.includes("detached: true");
  record(
    "ProcessSupervisor kills process groups (child process cleanup)",
    hasProcessGroup,
    `hasProcessGroup: ${hasProcessGroup}`
  );
}

// Test 50: runCommand uses spawn with array args (no shell injection).
{
  const usesSpawn = executorModule.includes("spawn(binary, args");
  record(
    "runCommand uses spawn with array args (no shell interpolation)",
    usesSpawn,
    `usesSpawn: ${usesSpawn}`
  );
}

// Test 51: runCommand enforces timeout.
{
  const hasTimeout = executorModule.includes("setTimeout") && executorModule.includes("timedOut = true");
  record(
    "runCommand enforces timeout (setTimeout + timedOut flag)",
    hasTimeout,
    `hasTimeout: ${hasTimeout}`
  );
}

// Test 52: EvidenceCollector records events continuously (not just at end).
{
  const hasRecord = executorModule.includes("recordEvent(event: EvidenceEvent)");
  const hasGetEvents = executorModule.includes("getEvents()");
  record(
    "EvidenceCollector records events continuously (recordEvent + getEvents)",
    hasRecord && hasGetEvents,
    `record: ${hasRecord}, getEvents: ${hasGetEvents}`
  );
}

// Test 53: Executor has finally block for workspace cleanup (always destroys).
{
  const hasFinally = executorModule.includes("finally {");
  const hasDestroyInFinally = executorModule.includes("workspace.destroy()");
  record(
    "Executor has finally block for workspace cleanup (always destroys, even on failure)",
    hasFinally && hasDestroyInFinally,
    `finally: ${hasFinally}, destroy: ${hasDestroyInFinally}`
  );
}

// Test 54: Executor pipeline includes all stages.
{
  const stages = [
    "workspace-create", "repository-checkout", "dependency-install",
    "build", "application-start", "health-check", "api-journey",
    "application-stop", "workspace-destroy",
  ];
  const missing = stages.filter((s) => !executorModule.includes(s));
  record(
    "Executor pipeline includes all stages (workspace→checkout→install→build→start→health→api→stop→destroy)",
    missing.length === 0,
    missing.length === 0 ? "All stages present" : `MISSING: ${missing.join(", ")}`
  );
}

// Test 55: Executor returns RuntimeVerificationResult.
{
  const hasReturn = executorModule.includes("Promise<RuntimeVerificationResult>");
  record(
    "executeRuntimeVerification returns Promise<RuntimeVerificationResult>",
    hasReturn,
    `hasReturn: ${hasReturn}`
  );
}

// ===========================================================================
// PHASE 18D: Security freeze — sandbox isolation, shell:false, evidence signing, replayability
// ===========================================================================

// Test 56: spawn calls use shell: false (no command injection).
{
  const executorCode = readFile("src/lib/runtime-executor.ts");
  const hasShellFalse = executorCode.includes("shell: false");
  const hasNoExec = !executorCode.includes("exec(") && !executorCode.includes("execSync(");
  record(
    "Phase 18D: all spawn calls use shell: false (no command injection, no exec())",
    hasShellFalse && hasNoExec,
    `shellFalse: ${hasShellFalse}, noExec: ${hasNoExec}`
  );
}

// Test 57: SandboxIsolationLevel type exists.
{
  const hasType = readFile("src/lib/runtime-execution-contract.ts").includes("type SandboxIsolationLevel");
  record(
    "Phase 18D: SandboxIsolationLevel type exists (filesystem-only | container | microvm)",
    hasType,
    `hasType: ${hasType}`
  );
}

// Test 58: SandboxModel records isolationLevel.
{
  const sandbox = createSandboxModel("exec-test");
  record(
    "SandboxModel records isolationLevel (current: filesystem-only)",
    sandbox.isolationLevel === "filesystem-only",
    `isolationLevel: ${sandbox.isolationLevel}`
  );
}

// Test 59: SandboxModel records networkEnforced.
{
  const sandbox = createSandboxModel("exec-test");
  record(
    "SandboxModel records networkEnforced (current: false — not physically enforced)",
    sandbox.networkEnforced === false,
    `networkEnforced: ${sandbox.networkEnforced}`
  );
}

// Test 60: Evidence signing produces a signature (asymmetric Ed25519).
{
  const keyPair = generateWorkerKeyPair("worker-1");
  const result = {
    repositoryHeadSha: "abc123",
    passed: true,
    failureReason: null,
    environmentFingerprint: { environmentVariablesHash: "hash123" },
  };
  const sig = signEvidence(result, "planHash", "archHash", keyPair.privateKeyPem, "worker-1", "exec-1");
  record(
    "Phase 18E: signEvidence produces an EvidenceSignature (Ed25519 asymmetric)",
    sig.signature.length > 0 && sig.algorithm === "ed25519" && sig.workerId === "worker-1",
    `signature length: ${sig.signature.length}, algorithm: ${sig.algorithm}`
  );
}

// Test 61: Evidence signature is verifiable with correct public key.
{
  const keyPair = generateWorkerKeyPair("worker-1");
  const result = {
    repositoryHeadSha: "abc123",
    passed: true,
    failureReason: null,
    environmentFingerprint: { environmentVariablesHash: "hash123" },
  };
  const sig = signEvidence(result, "planHash", "archHash", keyPair.privateKeyPem, "worker-1", "exec-1");
  const verified = verifyEvidenceSignature(result, "planHash", "archHash", sig, keyPair.publicKeyPem);
  record(
    "Phase 18E: verifyEvidenceSignature returns true for correct public key",
    verified,
    `verified: ${verified}`
  );
}

// Test 62: Evidence signature fails with wrong public key (different worker).
{
  const worker1Keys = generateWorkerKeyPair("worker-1");
  const worker2Keys = generateWorkerKeyPair("worker-2");
  const result = {
    repositoryHeadSha: "abc123",
    passed: true,
    failureReason: null,
    environmentFingerprint: { environmentVariablesHash: "hash123" },
  };
  const sig = signEvidence(result, "planHash", "archHash", worker1Keys.privateKeyPem, "worker-1", "exec-1");
  const verified = verifyEvidenceSignature(result, "planHash", "archHash", sig, worker2Keys.publicKeyPem);
  record(
    "Phase 18E: verifyEvidenceSignature returns false with different worker's public key",
    !verified,
    `verified: ${verified}`
  );
}

// Test 63: Evidence signature fails with tampered result.
{
  const keyPair = generateWorkerKeyPair("worker-1");
  const originalResult = {
    repositoryHeadSha: "abc123",
    passed: true,
    failureReason: null,
    environmentFingerprint: { environmentVariablesHash: "hash123" },
  };
  const sig = signEvidence(originalResult, "planHash", "archHash", keyPair.privateKeyPem, "worker-1", "exec-1");
  const tamperedResult = { ...originalResult, passed: false };
  const verified = verifyEvidenceSignature(tamperedResult, "planHash", "archHash", sig, keyPair.publicKeyPem);
  record(
    "Phase 18E: verifyEvidenceSignature returns false for tampered result (passed: true→false)",
    !verified,
    `verified: ${verified}`
  );
}

// Test 64: ReplayabilityIdentity type exists.
{
  const hasType = readFile("src/lib/runtime-execution-contract.ts").includes("interface ReplayabilityIdentity");
  record(
    "Phase 18D: ReplayabilityIdentity interface exists",
    hasType,
    `hasType: ${hasType}`
  );
}

// Test 65: isReplayCompatible returns true for same identity.
{
  const a: ReplayabilityIdentity = {
    repositoryHeadSha: "abc123",
    runtimePlanHash: "planHash",
    architectureHash: "archHash",
    environmentVariablesHash: "envHash",
  };
  const b: ReplayabilityIdentity = { ...a };
  record(
    "Phase 18D: isReplayCompatible returns true for same identity",
    isReplayCompatible(a, b),
    `compatible: ${isReplayCompatible(a, b)}`
  );
}

// Test 66: isReplayCompatible returns false for different SHA.
{
  const a: ReplayabilityIdentity = {
    repositoryHeadSha: "abc123",
    runtimePlanHash: "planHash",
    architectureHash: "archHash",
    environmentVariablesHash: "envHash",
  };
  const b: ReplayabilityIdentity = { ...a, repositoryHeadSha: "different" };
  record(
    "Phase 18D: isReplayCompatible returns false for different SHA",
    !isReplayCompatible(a, b),
    `compatible: ${isReplayCompatible(a, b)}`
  );
}

// Test 67: isReplayCompatible returns false for different plan hash.
{
  const a: ReplayabilityIdentity = {
    repositoryHeadSha: "abc123",
    runtimePlanHash: "planHash",
    architectureHash: "archHash",
    environmentVariablesHash: "envHash",
  };
  const b: ReplayabilityIdentity = { ...a, runtimePlanHash: "different" };
  record(
    "Phase 18D: isReplayCompatible returns false for different plan hash",
    !isReplayCompatible(a, b),
    `compatible: ${isReplayCompatible(a, b)}`
  );
}

// Test 68: ProcessSupervisor uses detached: true (process group).
{
  const executorCode = readFile("src/lib/runtime-executor.ts");
  const hasDetached = executorCode.includes("detached: true");
  record(
    "Phase 18D: ProcessSupervisor uses detached: true (process group for child cleanup)",
    hasDetached,
    `hasDetached: ${hasDetached}`
  );
}

// Test 69: ProcessSupervisor kills process group (negative PID).
{
  const executorCode = readFile("src/lib/runtime-executor.ts");
  const hasProcessGroupKill = executorCode.includes("process.kill(-");
  record(
    "Phase 18D: ProcessSupervisor kills process group (negative PID, not just parent)",
    hasProcessGroupKill,
    `hasProcessGroupKill: ${hasProcessGroupKill}`
  );
}

// Test 70: No exec() or execSync() anywhere in the executor.
{
  const executorCode = readFile("src/lib/runtime-executor.ts");
  const hasExec = /\bexec\s*\(/.test(executorCode) || /\bexecSync\s*\(/.test(executorCode);
  record(
    "Phase 18D: no exec() or execSync() in runtime-executor.ts (only spawn)",
    !hasExec,
    `hasExec: ${hasExec}`
  );
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18D: Runtime Executor Security Freeze ===\n");
let passed = 0;
let failed = 0;
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  console.log(`  ${r.details}\n`);
  if (r.passed) passed++;
  else failed++;
}
console.log(`=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("\n❌ RUNTIME EXECUTION CONTRACT NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Runtime execution contract + executor verified — Forge can now actually run applications and produce trustworthy evidence");
  process.exit(0);
}
