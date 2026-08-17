// Forge — Phase 18: Runtime Verification Invariants
//
// This test verifies the Phase 18 runtime verification architecture:
//   1. The RuntimeEvidence Prisma model exists with the required fields.
//   2. The runtime-verification module exports the correct types and functions.
//   3. The production readiness predicate requires BOTH static AND runtime.
//   4. The readiness gate has a runtime verification check.
//   5. The API endpoint for submitting runtime evidence exists and is authenticated.
//   6. The worker security test covers the new endpoint.
//
// Run with: bun run tests/runtime-verification-invariants.ts

import { readFileSync } from "node:fs";
import {
  canReachProductionReadyWithRuntime,
  getProductionReadinessFailureReason,
  deriveRuntimeVerificationPlan,
  evaluateRuntimeVerificationResult,
  hashRuntimePlan,
  type ProductionReadinessEvidence,
  type RuntimeVerificationResult,
  type RuntimeVerificationPlan,
  type RuntimeVerificationPlan as Plan,
} from "../src/lib/runtime-verification";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function record(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
}

// Minimal plan for tests that just need the evaluator to run.
function makeMinimalPlan(): Plan {
  return {
    repositoryHeadSha: "abc1234",
    githubRepo: "owner/repo",
    githubDefaultBranch: "main",
    installCommands: ["npm install"],
    buildCommands: ["npm run build"],
    startCommand: "npm start",
    expectedPort: 3000,
    startupTimeoutMs: 30000,
    healthChecks: [],
    apiJourneys: [],
    integrationChecks: [],
    backgroundJobChecks: [],
    browserJourneys: [],
    teardownTimeoutMs: 10000,
  };
}

// ===========================================================================
// PRISMA MODEL: RuntimeEvidence
// ===========================================================================

const schema = readFile("prisma/schema.prisma");

// Test 1: RuntimeEvidence model exists.
{
  const hasModel = schema.includes("model RuntimeEvidence");
  record("Prisma schema has RuntimeEvidence model", hasModel, `hasModel: ${hasModel}`);
}

// Test 2: RuntimeEvidence has repositoryHeadSha field.
{
  const hasField = schema.includes("repositoryHeadSha") && schema.includes("model RuntimeEvidence");
  record("RuntimeEvidence has repositoryHeadSha field", hasField, `hasField: ${hasField}`);
}

// Test 3: RuntimeEvidence has environmentFingerprint.
{
  const hasField = schema.includes("environmentFingerprint");
  record("RuntimeEvidence has environmentFingerprint field", hasField, `hasField: ${hasField}`);
}

// Test 4: RuntimeEvidence has all pipeline stage result fields.
{
  const stages = [
    "dependencyInstallResult",
    "buildResult",
    "startupResult",
    "healthChecks",
    "apiJourneys",
    "integrationChecks",
    "backgroundJobChecks",
    "browserJourneys",
    "teardownResult",
  ];
  const missing = stages.filter((s) => !schema.includes(s));
  record(
    "RuntimeEvidence has all pipeline stage result fields",
    missing.length === 0,
    missing.length === 0 ? "All stages present" : `MISSING: ${missing.join(", ")}`
  );
}

// Test 5: RuntimeEvidence has passed + failureReason.
{
  const hasPassed = schema.includes("passed") && schema.includes("failureReason");
  record("RuntimeEvidence has passed + failureReason fields", hasPassed, `hasPassed: ${hasPassed}`);
}

// Test 6: RuntimeEvidence is append-only (no update logic in the codebase).
{
  const evidenceRoute = readFile("src/app/api/worker/submit-runtime-evidence/route.ts");
  const usesCreate = evidenceRoute.includes("db.runtimeEvidence.create");
  const noUpdate = !evidenceRoute.includes("db.runtimeEvidence.update");
  record(
    "RuntimeEvidence is append-only (create, never update)",
    usesCreate && noUpdate,
    `usesCreate: ${usesCreate}, noUpdate: ${noUpdate}`
  );
}

// Test 7: RuntimeEvidence has index on repositoryHeadSha.
{
  const hasIndex = schema.includes("@@index([repositoryHeadSha])");
  record("RuntimeEvidence has index on repositoryHeadSha", hasIndex, `hasIndex: ${hasIndex}`);
}

// Test 8: Project model has runtimeEvidence relation.
{
  const hasRelation = schema.includes("runtimeEvidence   RuntimeEvidence[]");
  record("Project model has runtimeEvidence relation", hasRelation, `hasRelation: ${hasRelation}`);
}

// ===========================================================================
// RUNTIME VERIFICATION MODULE
// ===========================================================================

const runtimeModule = readFile("src/lib/runtime-verification.ts");

// Test 9: Module exports RuntimeVerificationPlan interface.
{
  const hasInterface = runtimeModule.includes("interface RuntimeVerificationPlan");
  record("runtime-verification.ts exports RuntimeVerificationPlan interface", hasInterface, `hasInterface: ${hasInterface}`);
}

// Test 10: Module exports RuntimeVerificationResult interface.
{
  const hasInterface = runtimeModule.includes("interface RuntimeVerificationResult");
  record("runtime-verification.ts exports RuntimeVerificationResult interface", hasInterface, `hasInterface: ${hasInterface}`);
}

// Test 11: Module exports ProductionReadinessEvidence interface.
{
  const hasInterface = runtimeModule.includes("interface ProductionReadinessEvidence");
  record("runtime-verification.ts exports ProductionReadinessEvidence interface", hasInterface, `hasInterface: ${hasInterface}`);
}

// Test 12: Module exports canReachProductionReadyWithRuntime function.
{
  const hasFunction = runtimeModule.includes("export function canReachProductionReadyWithRuntime");
  record("runtime-verification.ts exports canReachProductionReadyWithRuntime function", hasFunction, `hasFunction: ${hasFunction}`);
}

// Test 13: Module exports deriveRuntimeVerificationPlan function.
{
  const hasFunction = runtimeModule.includes("export function deriveRuntimeVerificationPlan");
  record("runtime-verification.ts exports deriveRuntimeVerificationPlan function", hasFunction, `hasFunction: ${hasFunction}`);
}

// Test 14: Module exports evaluateRuntimeVerificationResult function.
{
  const hasFunction = runtimeModule.includes("export function evaluateRuntimeVerificationResult");
  record("runtime-verification.ts exports evaluateRuntimeVerificationResult function", hasFunction, `hasFunction: ${hasFunction}`);
}

// Test 15: Pipeline includes install, build, start, health, API, teardown stages.
{
  const stages = ["install", "build", "start", "health", "apiJourneys", "teardown"];
  const missing = stages.filter((s) => !runtimeModule.includes(s));
  record(
    "Runtime verification pipeline includes install/build/start/health/api/teardown stages",
    missing.length === 0,
    missing.length === 0 ? "All stages present" : `MISSING: ${missing.join(", ")}`
  );
}

// ===========================================================================
// PRODUCTION READINESS PREDICATE (Phase 18)
// ===========================================================================

// Test 16: Predicate requires architectureFrozen.
{
  const allTrue: ProductionReadinessEvidence = {
    architectureFrozen: true, allTasksCompleted: true, allTasksIntegrated: true,
    staticReadinessPassed: true, runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true, executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
    artifactManifestVerified: true,
    artifactRetrievable: true,
    repositoryHeadVerified: true,
  };
  const withFalse = { ...allTrue, architectureFrozen: false };
  record(
    "Predicate requires architectureFrozen",
    canReachProductionReadyWithRuntime(allTrue) && !canReachProductionReadyWithRuntime(withFalse),
    `allTrue passes: ${canReachProductionReadyWithRuntime(allTrue)}, architectureFrozen=false fails: ${!canReachProductionReadyWithRuntime(withFalse)}`
  );
}

// Test 17: Predicate requires runtimeVerificationPassed.
{
  const allTrue: ProductionReadinessEvidence = {
    architectureFrozen: true, allTasksCompleted: true, allTasksIntegrated: true,
    staticReadinessPassed: true, runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true, executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
    artifactManifestVerified: true,
    artifactRetrievable: true,
    repositoryHeadVerified: true,
  };
  const withFalse = { ...allTrue, runtimeVerificationPassed: false };
  record(
    "Predicate requires runtimeVerificationPassed (static alone is not enough)",
    !canReachProductionReadyWithRuntime(withFalse),
    `runtimeVerificationPassed=false fails: ${!canReachProductionReadyWithRuntime(withFalse)}`
  );
}

// Test 18: Predicate requires staticReadinessPassed.
{
  const allTrue: ProductionReadinessEvidence = {
    architectureFrozen: true, allTasksCompleted: true, allTasksIntegrated: true,
    staticReadinessPassed: true, runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true, executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
    artifactManifestVerified: true,
    artifactRetrievable: true,
    repositoryHeadVerified: true,
  };
  const withFalse = { ...allTrue, staticReadinessPassed: false };
  record(
    "Predicate requires staticReadinessPassed (runtime alone is not enough)",
    !canReachProductionReadyWithRuntime(withFalse),
    `staticReadinessPassed=false fails: ${!canReachProductionReadyWithRuntime(withFalse)}`
  );
}

// Test 19: Predicate requires runtimeEvidencePersisted.
{
  const allTrue: ProductionReadinessEvidence = {
    architectureFrozen: true, allTasksCompleted: true, allTasksIntegrated: true,
    staticReadinessPassed: true, runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true, executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
    artifactManifestVerified: true,
    artifactRetrievable: true,
    repositoryHeadVerified: true,
  };
  const withFalse = { ...allTrue, runtimeEvidencePersisted: false };
  record(
    "Predicate requires runtimeEvidencePersisted",
    !canReachProductionReadyWithRuntime(withFalse),
    `runtimeEvidencePersisted=false fails: ${!canReachProductionReadyWithRuntime(withFalse)}`
  );
}

// Test 20: Predicate requires executionEnvironmentSandboxed.
{
  const allTrue: ProductionReadinessEvidence = {
    architectureFrozen: true, allTasksCompleted: true, allTasksIntegrated: true,
    staticReadinessPassed: true, runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true, executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
    artifactManifestVerified: true,
    artifactRetrievable: true,
    repositoryHeadVerified: true,
  };
  const withFalse = { ...allTrue, executionEnvironmentSandboxed: false };
  record(
    "Predicate requires executionEnvironmentSandboxed",
    !canReachProductionReadyWithRuntime(withFalse),
    `executionEnvironmentSandboxed=false fails: ${!canReachProductionReadyWithRuntime(withFalse)}`
  );
}

// Test 21: Predicate requires repositoryHeadVerified.
{
  const allTrue: ProductionReadinessEvidence = {
    architectureFrozen: true, allTasksCompleted: true, allTasksIntegrated: true,
    staticReadinessPassed: true, runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true, executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
    artifactManifestVerified: true,
    artifactRetrievable: true,
    repositoryHeadVerified: true,
  };
  const withFalse = { ...allTrue, repositoryHeadVerified: false };
  record(
    "Predicate requires repositoryHeadVerified",
    !canReachProductionReadyWithRuntime(withFalse),
    `repositoryHeadVerified=false fails: ${!canReachProductionReadyWithRuntime(withFalse)}`
  );
}

// Test 22: getProductionReadinessFailureReason lists all failing conditions.
{
  const allFalse: ProductionReadinessEvidence = {
    architectureFrozen: false, allTasksCompleted: false, allTasksIntegrated: false,
    staticReadinessPassed: false, runtimeVerificationPassed: false,
    runtimeEvidencePersisted: false, executionEnvironmentSandboxed: false,
    substrateAttestationVerified: false,
    artifactManifestVerified: true,
    artifactRetrievable: true,
    repositoryHeadVerified: false,
  };
  const reason = getProductionReadinessFailureReason(allFalse);
  const hasAllReasons = reason !== null &&
    reason.includes("architecture") &&
    reason.includes("tasks") &&
    reason.includes("integration") &&
    reason.includes("staticReadiness") &&
    reason.includes("runtimeVerification") &&
    reason.includes("runtimeEvidence") &&
    reason.includes("environment") &&
    reason.includes("repositoryHead");
  record(
    "getProductionReadinessFailureReason lists all failing conditions",
    hasAllReasons,
    `reason: ${reason}`
  );
}

// Test 23: getProductionReadinessFailureReason returns null when all pass.
{
  const allTrue: ProductionReadinessEvidence = {
    architectureFrozen: true, allTasksCompleted: true, allTasksIntegrated: true,
    staticReadinessPassed: true, runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true, executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
    artifactManifestVerified: true,
    artifactRetrievable: true,
    repositoryHeadVerified: true,
  };
  const reason = getProductionReadinessFailureReason(allTrue);
  record(
    "getProductionReadinessFailureReason returns null when all conditions pass",
    reason === null,
    `reason: ${reason}`
  );
}

// ===========================================================================
// RUNTIME VERIFICATION RESULT EVALUATION
// ===========================================================================

// Test 24: evaluateRuntimeVerificationResult passes when all stages succeed.
{
  const result: RuntimeVerificationResult = {
    repositoryHeadSha: "abc1234",
    headVerified: true,
    environmentFingerprint: { nodeVersion: "20", platform: "linux", arch: "x64", executionMode: "sandbox", workerVersion: "phase18", timestamp: new Date().toISOString() },
    dependencyInstallResult: { success: true, durationMs: 1000, exitCode: 0, output: "installed" },
    buildResult: { success: true, durationMs: 2000, exitCode: 0, output: "built" },
    startupResult: { success: true, durationMs: 500, exitCode: 0, output: "started", port: 3000, pid: 12345 },
    healthChecks: [{ name: "health", path: "/api/health", passed: true, status: 200, responseTimeMs: 10 }],
    apiJourneys: [{ name: "GET /", method: "GET", path: "/", passed: true, status: 200, responseTimeMs: 20 }],
    integrationChecks: [],
    backgroundJobChecks: [],
    browserJourneys: [],
    teardownResult: { success: true, durationMs: 100 },
    passed: true,
    failureReason: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    logs: "",
    substrateAttestation: null,
  };
  const evaluation = evaluateRuntimeVerificationResult(result, makeMinimalPlan());
  record(
    "evaluateRuntimeVerificationResult passes when all stages succeed",
    evaluation.passed,
    `passed: ${evaluation.passed}, reason: ${evaluation.failureReason}`
  );
}

// Test 25: evaluateRuntimeVerificationResult fails when install fails.
{
  const result: RuntimeVerificationResult = {
    repositoryHeadSha: "abc1234",
    headVerified: true,
    environmentFingerprint: { nodeVersion: "20", platform: "linux", arch: "x64", executionMode: "sandbox", workerVersion: "phase18", timestamp: new Date().toISOString() },
    dependencyInstallResult: { success: false, durationMs: 1000, exitCode: 1, output: "error" },
    buildResult: { success: true, durationMs: 2000, exitCode: 0, output: "built" },
    startupResult: { success: true, durationMs: 500, exitCode: 0, output: "started", port: 3000, pid: 12345 },
    healthChecks: [{ name: "health", path: "/api/health", passed: true, status: 200, responseTimeMs: 10 }],
    apiJourneys: [],
    integrationChecks: [],
    backgroundJobChecks: [],
    browserJourneys: [],
    teardownResult: { success: true, durationMs: 100 },
    passed: false,
    failureReason: "install failed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    logs: "",
    substrateAttestation: null,
  };
  const evaluation = evaluateRuntimeVerificationResult(result, makeMinimalPlan());
  record(
    "evaluateRuntimeVerificationResult fails when dependency install fails",
    !evaluation.passed && evaluation.failureReason?.includes("dependencyInstall"),
    `passed: ${evaluation.passed}, reason: ${evaluation.failureReason}`
  );
}

// Test 26: evaluateRuntimeVerificationResult fails when startup fails.
{
  const result: RuntimeVerificationResult = {
    repositoryHeadSha: "abc1234",
    headVerified: true,
    environmentFingerprint: { nodeVersion: "20", platform: "linux", arch: "x64", executionMode: "sandbox", workerVersion: "phase18", timestamp: new Date().toISOString() },
    dependencyInstallResult: { success: true, durationMs: 1000, exitCode: 0, output: "installed" },
    buildResult: { success: true, durationMs: 2000, exitCode: 0, output: "built" },
    startupResult: { success: false, durationMs: 30000, exitCode: 1, output: "timeout", port: 3000, pid: null },
    healthChecks: [],
    apiJourneys: [],
    integrationChecks: [],
    backgroundJobChecks: [],
    browserJourneys: [],
    teardownResult: { success: true, durationMs: 100 },
    passed: false,
    failureReason: "startup failed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    logs: "",
    substrateAttestation: null,
  };
  const evaluation = evaluateRuntimeVerificationResult(result, makeMinimalPlan());
  record(
    "evaluateRuntimeVerificationResult fails when startup fails",
    !evaluation.passed && evaluation.failureReason?.includes("startup"),
    `passed: ${evaluation.passed}, reason: ${evaluation.failureReason}`
  );
}

// Test 27: evaluateRuntimeVerificationResult fails when health check fails.
{
  const planWithHealth: Plan = {
    ...makeMinimalPlan(),
    healthChecks: [{ name: "health", path: "/api/health", expectedStatus: 200, timeoutMs: 10000, required: "required" }],
  };
  const result: RuntimeVerificationResult = {
    repositoryHeadSha: "abc1234",
    headVerified: true,
    environmentFingerprint: { nodeVersion: "20", platform: "linux", arch: "x64", executionMode: "sandbox", workerVersion: "phase18", timestamp: new Date().toISOString() },
    dependencyInstallResult: { success: true, durationMs: 1000, exitCode: 0, output: "installed" },
    buildResult: { success: true, durationMs: 2000, exitCode: 0, output: "built" },
    startupResult: { success: true, durationMs: 500, exitCode: 0, output: "started", port: 3000, pid: 12345 },
    healthChecks: [{ name: "health", path: "/api/health", passed: false, status: null, responseTimeMs: 0, required: "required", error: "timeout" }],
    apiJourneys: [],
    integrationChecks: [],
    backgroundJobChecks: [],
    browserJourneys: [],
    teardownResult: { success: true, durationMs: 100 },
    passed: false,
    failureReason: "health failed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    logs: "",
    substrateAttestation: null,
  };
  const evaluation = evaluateRuntimeVerificationResult(result, planWithHealth);
  record(
    "evaluateRuntimeVerificationResult fails when health check fails",
    !evaluation.passed && evaluation.failureReason?.includes("health"),
    `passed: ${evaluation.passed}, reason: ${evaluation.failureReason}`
  );
}

// ===========================================================================
// PLAN DERIVATION
// ===========================================================================

// Test 28: deriveRuntimeVerificationPlan returns null without canonicalHeadSha.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: null, githubRepo: "owner/repo", githubDefaultBranch: "main" },
    null
  );
  record(
    "deriveRuntimeVerificationPlan returns null without canonicalHeadSha",
    plan === null,
    `plan: ${plan}`
  );
}

// Test 29: deriveRuntimeVerificationPlan returns null without githubRepo.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: null, githubDefaultBranch: "main" },
    null
  );
  record(
    "deriveRuntimeVerificationPlan returns null without githubRepo",
    plan === null,
    `plan: ${plan}`
  );
}

// Test 30: deriveRuntimeVerificationPlan returns a plan with correct SHA.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123def456", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}",
      apiContracts: "[]",
      integrations: "[]",
      testingStrategy: "{}",
      deploymentModel: JSON.stringify({
        installCommands: ["npm install"],
        buildCommands: ["npm run build"],
        startCommand: "npm start",
        port: 3000,
        startupTimeoutMs: 30000,
        teardownTimeoutMs: 10000,
      }),
      frozen: true,
    }
  );
  record(
    "deriveRuntimeVerificationPlan returns a plan with correct SHA + repo",
    plan !== null && plan.repositoryHeadSha === "abc123def456" && plan.githubRepo === "owner/repo",
    `sha: ${plan?.repositoryHeadSha}, repo: ${plan?.githubRepo}`
  );
}

// Test 31: deriveRuntimeVerificationPlan extracts API journeys from architecture.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}",
      apiContracts: JSON.stringify([
        { method: "GET", path: "/api/users", name: "List users", expectedStatus: 200 },
        { method: "POST", path: "/api/auth/login", name: "Login", expectedStatus: 200 },
      ]),
      integrations: "[]",
      testingStrategy: "{}",
      deploymentModel: JSON.stringify({
        installCommands: ["npm install"],
        buildCommands: ["npm run build"],
        startCommand: "npm start",
        port: 3000,
        startupTimeoutMs: 30000,
        teardownTimeoutMs: 10000,
      }),
      frozen: true,
    }
  );
  record(
    "deriveRuntimeVerificationPlan extracts API journeys from architecture",
    plan !== null && plan.apiJourneys.length === 2 && plan.apiJourneys[0].steps[0].path === "/api/users",
    `journeys: ${plan?.apiJourneys.length}, firstStepPath: ${plan?.apiJourneys[0]?.steps[0]?.path}`
  );
}

// ===========================================================================
// READINESS GATE INTEGRATION
// ===========================================================================

const readiness = readFile("src/lib/readiness.ts");

// Test 32: Readiness gate has runtime verification check.
{
  const hasCheck = readiness.includes("Runtime verification passed at exact canonical SHA");
  record(
    "readiness gate has 'Runtime verification passed at exact canonical SHA' check",
    hasCheck,
    `hasCheck: ${hasCheck}`
  );
}

// Test 33: Readiness gate queries RuntimeEvidence by exact SHA.
{
  const queriesEvidence = readiness.includes("db.runtimeEvidence.findFirst") &&
    readiness.includes("repositoryHeadSha: repo.head");
  record(
    "readiness gate queries RuntimeEvidence by exact canonical SHA",
    queriesEvidence,
    `queriesEvidence: ${queriesEvidence}`
  );
}

// Test 34: Readiness gate fails when no runtime evidence exists.
{
  const failsOnMissing = readiness.includes("RUNTIME_VERIFICATION_REQUIRED");
  record(
    "readiness gate fails when no runtime evidence exists (RUNTIME_VERIFICATION_REQUIRED)",
    failsOnMissing,
    `failsOnMissing: ${failsOnMissing}`
  );
}

// ===========================================================================
// API ENDPOINT SECURITY
// ===========================================================================

const evidenceRoute = readFile("src/app/api/worker/submit-runtime-evidence/route.ts");

// Test 35: Endpoint requires authentication.
{
  const hasAuth = evidenceRoute.includes("getWorkerToken") || evidenceRoute.includes("verifyWorkerToken");
  record(
    "submit-runtime-evidence endpoint requires worker authentication",
    hasAuth,
    `hasAuth: ${hasAuth}`
  );
}

// Test 36: Endpoint verifies execution token.
{
  const verifiesExec = evidenceRoute.includes("token.executionId");
  record(
    "submit-runtime-evidence endpoint verifies execution token",
    verifiesExec,
    `verifiesExec: ${verifiesExec}`
  );
}

// Test 37: Endpoint verifies lease.
{
  const verifiesLease = evidenceRoute.includes("leaseId") && evidenceRoute.includes("leaseExpiresAt");
  record(
    "submit-runtime-evidence endpoint verifies lease (compare-and-set)",
    verifiesLease,
    `verifiesLease: ${verifiesLease}`
  );
}

// Test 38: Endpoint evaluates result fail-closed (doesn't trust worker self-assessment).
{
  const evaluates = evidenceRoute.includes("evaluateRuntimeVerificationResult");
  record(
    "submit-runtime-evidence endpoint evaluates result fail-closed (doesn't trust worker self-assessment)",
    evaluates,
    `evaluates: ${evaluates}`
  );
}

// Test 39: Endpoint creates new evidence (append-only).
{
  const creates = evidenceRoute.includes("db.runtimeEvidence.create");
  const noUpdate = !evidenceRoute.includes("db.runtimeEvidence.update");
  record(
    "submit-runtime-evidence endpoint creates new evidence (append-only, never update)",
    creates && noUpdate,
    `creates: ${creates}, noUpdate: ${noUpdate}`
  );
}

// ===========================================================================
// PRODUCTION-ENFORCEMENT RE-EXPORT
// ===========================================================================

const enforcement = readFile("src/lib/production-enforcement.ts");

// Test 40: production-enforcement re-exports the Phase 18 predicate.
{
  const reExports = enforcement.includes("canReachProductionReadyWithRuntime") &&
    enforcement.includes("getProductionReadinessFailureReason") &&
    enforcement.includes("ProductionReadinessEvidence");
  record(
    "production-enforcement.ts re-exports Phase 18 predicate + types",
    reExports,
    `reExports: ${reExports}`
  );
}

// ===========================================================================
// PHASE 18A: Server-authoritative SHA + no defaults + required/optional
// ===========================================================================

const runtimeModulePhase18A = readFile("src/lib/runtime-verification.ts");
const evidenceRoutePhase18A = readFile("src/app/api/worker/submit-runtime-evidence/route.ts");

// Test 41: NO DEFAULTS — deriveRuntimeVerificationPlan returns null without architecture.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    null
  );
  record(
    "Phase 18A: deriveRuntimeVerificationPlan returns null when architecture is null (NO DEFAULTS)",
    plan === null,
    `plan: ${plan}`
  );
}

// Test 42: NO DEFAULTS — returns null when architecture is not frozen.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    { contractJson: "{}", apiContracts: "[]", integrations: "[]", testingStrategy: "{}", deploymentModel: "{}", frozen: false }
  );
  record(
    "Phase 18A: deriveRuntimeVerificationPlan returns null when architecture is not frozen",
    plan === null,
    `plan: ${plan}`
  );
}

// Test 43: NO DEFAULTS — returns null when deployment model lacks installCommands.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}",
      apiContracts: "[]",
      integrations: "[]",
      testingStrategy: "{}",
      deploymentModel: JSON.stringify({ buildCommands: ["npm run build"], startCommand: "npm start", port: 3000 }),
      frozen: true,
    }
  );
  record(
    "Phase 18A: returns null when deployment model lacks installCommands (NO npm default)",
    plan === null,
    `plan: ${plan}`
  );
}

// Test 44: NO DEFAULTS — returns null when deployment model lacks startCommand.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}",
      apiContracts: "[]",
      integrations: "[]",
      testingStrategy: "{}",
      deploymentModel: JSON.stringify({ installCommands: ["npm install"], buildCommands: ["npm run build"], port: 3000 }),
      frozen: true,
    }
  );
  record(
    "Phase 18A: returns null when deployment model lacks startCommand (NO npm start default)",
    plan === null,
    `plan: ${plan}`
  );
}

// Test 45: NO DEFAULTS — returns null when deployment model lacks port.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}",
      apiContracts: "[]",
      integrations: "[]",
      testingStrategy: "{}",
      deploymentModel: JSON.stringify({ installCommands: ["npm install"], buildCommands: ["npm run build"], startCommand: "npm start" }),
      frozen: true,
    }
  );
  record(
    "Phase 18A: returns null when deployment model lacks port (NO port 3000 default)",
    plan === null,
    `plan: ${plan}`
  );
}

// Test 46: NO DEFAULTS — returns null on malformed JSON.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}",
      apiContracts: "[]",
      integrations: "[]",
      testingStrategy: "{}",
      deploymentModel: "INVALID JSON{{",
      frozen: true,
    }
  );
  record(
    "Phase 18A: returns null on malformed deployment model JSON (NO fallback)",
    plan === null,
    `plan: ${plan}`
  );
}

// Test 47: Valid plan with full deployment model.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}",
      apiContracts: JSON.stringify([{ method: "GET", path: "/api/users", name: "List users", expectedStatus: 200 }]),
      integrations: JSON.stringify([{ name: "Postgres", type: "database", verificationMethod: "connectivity", required: "required" }]),
      testingStrategy: JSON.stringify({
        apiJourneys: [{
          name: "User CRUD",
          required: "required",
          steps: [
            { method: "POST", path: "/api/users", expectedStatus: 201, capture: "$.id" },
            { method: "GET", path: "/api/users/{id}", expectedStatus: 200 },
          ],
        }],
      }),
      deploymentModel: JSON.stringify({
        installCommands: ["pip install -r requirements.txt"],
        buildCommands: ["python -m build"],
        startCommand: "uvicorn app:main",
        port: 8000,
        startupTimeoutMs: 45000,
        teardownTimeoutMs: 15000,
      }),
      frozen: true,
    }
  );
  record(
    "Phase 18A: valid plan from full architecture (Python app, not npm defaults)",
    plan !== null &&
    plan.installCommands[0] === "pip install -r requirements.txt" &&
    plan.startCommand === "uvicorn app:main" &&
    plan.expectedPort === 8000 &&
    plan.apiJourneys.length === 1 &&
    plan.apiJourneys[0].steps.length === 2,
    `plan: ${plan ? "valid" : "null"}, journeys: ${plan?.apiJourneys.length ?? 0}`
  );
}

// Test 48: hashRuntimePlan produces a stable hash.
{
  const plan = makeMinimalPlan();
  const hash1 = hashRuntimePlan(plan);
  const hash2 = hashRuntimePlan(plan);
  record(
    "hashRuntimePlan produces a stable hash for the same plan",
    hash1 === hash2 && hash1.length === 64,
    `hash1: ${hash1}, hash2: ${hash2}`
  );
}

// Test 49: hashRuntimePlan produces different hashes for different plans.
{
  const plan1 = makeMinimalPlan();
  const plan2 = { ...makeMinimalPlan(), expectedPort: 8080 };
  const hash1 = hashRuntimePlan(plan1);
  const hash2 = hashRuntimePlan(plan2);
  record(
    "hashRuntimePlan produces different hashes for different plans",
    hash1 !== hash2,
    `hash1: ${hash1}, hash2: ${hash2}`
  );
}

// Test 50: Endpoint verifies SHA match (server-authoritative).
{
  const verifiesSha = evidenceRoutePhase18A.includes("result.repositoryHeadSha !== expectedSha") ||
    evidenceRoutePhase18A.includes("SHA mismatch");
  record(
    "submit-runtime-evidence endpoint verifies result.repositoryHeadSha == project.canonicalHeadSha",
    verifiesSha,
    `verifiesSha: ${verifiesSha}`
  );
}

// Test 51: Endpoint rejects SHA mismatch.
{
  const rejectsMismatch = evidenceRoutePhase18A.includes("REJECTED") && evidenceRoutePhase18A.includes("SHA mismatch");
  record(
    "submit-runtime-evidence endpoint rejects SHA mismatch (server-authoritative)",
    rejectsMismatch,
    `rejectsMismatch: ${rejectsMismatch}`
  );
}

// Test 52: Endpoint independently verifies GitHub freshness.
{
  const verifiesFreshness = evidenceRoutePhase18A.includes("api.github.com") && evidenceRoutePhase18A.includes("branchRes");
  record(
    "submit-runtime-evidence endpoint independently verifies GitHub branch HEAD (freshness)",
    verifiesFreshness,
    `verifiesFreshness: ${verifiesFreshness}`
  );
}

// Test 53: Endpoint rejects when headVerified is false.
{
  const rejectsUnverified = evidenceRoutePhase18A.includes("Canonical HEAD not verified");
  record(
    "submit-runtime-evidence endpoint rejects when canonical HEAD not verified",
    rejectsUnverified,
    `rejectsUnverified: ${rejectsUnverified}`
  );
}

// Test 54: Endpoint derives plan from architecture (NO DEFAULTS).
{
  const derivesPlan = evidenceRoutePhase18A.includes("deriveRuntimeVerificationPlan");
  const rejectsNoPlan = evidenceRoutePhase18A.includes("No valid runtime verification plan");
  record(
    "submit-runtime-evidence endpoint derives plan from architecture and rejects if missing (NO DEFAULTS)",
    derivesPlan && rejectsNoPlan,
    `derivesPlan: ${derivesPlan}, rejectsNoPlan: ${rejectsNoPlan}`
  );
}

// Test 55: Endpoint uses plan-aware evaluation.
{
  const planAware = evidenceRoutePhase18A.includes("evaluateRuntimeVerificationResult(result, plan)");
  record(
    "submit-runtime-evidence endpoint uses plan-aware evaluation (passes plan to evaluator)",
    planAware,
    `planAware: ${planAware}`
  );
}

// Test 56: Endpoint does NOT emit PRODUCTION_READY from runtime pass alone.
{
  // The endpoint should emit RUNTIME_VERIFIED, not PRODUCTION_READY, initially.
  // PRODUCTION_READY only comes from the complete canonical predicate.
  const usesCanonicalPredicate = evidenceRoutePhase18A.includes("canReachProductionReadyWithRuntime(prodEvidence)");
  const runtimeEventNotProductionReady = evidenceRoutePhase18A.includes("RUNTIME_VERIFIED") || evidenceRoutePhase18A.includes("runtimeVerified");
  record(
    "submit-runtime-evidence evaluates canonical predicate before PRODUCTION_READY (not runtime pass alone)",
    usesCanonicalPredicate,
    `usesCanonicalPredicate: ${usesCanonicalPredicate}`
  );
}

// Test 57: Endpoint records expectedRepositoryHeadSha (server-derived).
{
  const recordsExpected = evidenceRoutePhase18A.includes("expectedRepositoryHeadSha: expectedSha");
  record(
    "submit-runtime-evidence records expectedRepositoryHeadSha (server-derived, not worker-supplied)",
    recordsExpected,
    `recordsExpected: ${recordsExpected}`
  );
}

// Test 58: Endpoint records runtimePlanHash.
{
  const recordsHash = evidenceRoutePhase18A.includes("runtimePlanHash");
  record(
    "submit-runtime-evidence records runtimePlanHash (for reproducibility)",
    recordsHash,
    `recordsHash: ${recordsHash}`
  );
}

// Test 59: Endpoint records architectureHash.
{
  const recordsArchHash = evidenceRoutePhase18A.includes("architectureHash");
  record(
    "submit-runtime-evidence records architectureHash (for reproducibility)",
    recordsArchHash,
    `recordsArchHash: ${recordsArchHash}`
  );
}

// Test 60: Required API journey missing → UNVERIFIED (fail).
{
  const plan: Plan = {
    ...makeMinimalPlan(),
    apiJourneys: [{
      name: "Critical Journey",
      description: "must pass",
      required: "required",
      steps: [{ name: "step1", method: "GET", path: "/api/critical", expectedStatus: 200 }],
    }],
  };
  const result: RuntimeVerificationResult = {
    ...makeMinimalResult(),
    apiJourneys: [], // Missing the required journey.
  };
  const evaluation = evaluateRuntimeVerificationResult(result, plan);
  record(
    "Required API journey missing → evaluation fails (UNVERIFIED)",
    !evaluation.passed && evaluation.failureReason?.includes("Critical Journey:MISSING"),
    `passed: ${evaluation.passed}, reason: ${evaluation.failureReason}`
  );
}

// Test 61: Optional API journey missing → SKIPPED (ok).
{
  const plan: Plan = {
    ...makeMinimalPlan(),
    apiJourneys: [{
      name: "Optional Journey",
      description: "nice to have",
      required: "optional",
      steps: [{ name: "step1", method: "GET", path: "/api/optional", expectedStatus: 200 }],
    }],
  };
  const result: RuntimeVerificationResult = {
    ...makeMinimalResult(),
    apiJourneys: [], // Missing the optional journey.
  };
  const evaluation = evaluateRuntimeVerificationResult(result, plan);
  record(
    "Optional API journey missing → evaluation passes (SKIPPED)",
    evaluation.passed,
    `passed: ${evaluation.passed}, reason: ${evaluation.failureReason}`
  );
}

// Test 62: Required integration check failed → FAILED.
{
  const plan: Plan = {
    ...makeMinimalPlan(),
    integrationChecks: [{
      name: "Postgres",
      type: "database",
      required: "required",
      verificationMethod: "connectivity",
    }],
  };
  const result: RuntimeVerificationResult = {
    ...makeMinimalResult(),
    integrationChecks: [{
      name: "Postgres",
      type: "database",
      passed: false,
      required: "required",
      verificationMethod: "connectivity",
      error: "connection refused",
    }],
  };
  const evaluation = evaluateRuntimeVerificationResult(result, plan);
  record(
    "Required integration check failed → evaluation fails",
    !evaluation.passed && evaluation.failureReason?.includes("Postgres:FAILED"),
    `passed: ${evaluation.passed}, reason: ${evaluation.failureReason}`
  );
}

// Test 63: No npm defaults in runtime-verification.ts.
{
  const hasNpmDefault = runtimeModulePhase18A.includes('"npm install"') || runtimeModulePhase18A.includes('"npm start"');
  record(
    "runtime-verification.ts has NO npm defaults (no 'npm install' or 'npm start' literals)",
    !hasNpmDefault,
    `hasNpmDefault: ${hasNpmDefault}`
  );
}

// Test 64: RuntimeEvidence schema has expectedRepositoryHeadSha field.
{
  const hasField = readFile("prisma/schema.prisma").includes("expectedRepositoryHeadSha");
  record(
    "RuntimeEvidence schema has expectedRepositoryHeadSha field (server-authoritative)",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 65: RuntimeEvidence schema has runtimePlanHash field.
{
  const hasField = readFile("prisma/schema.prisma").includes("runtimePlanHash");
  record(
    "RuntimeEvidence schema has runtimePlanHash field (reproducibility)",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 66: RuntimeEvidence schema has architectureHash field.
{
  const hasField = readFile("prisma/schema.prisma").includes("architectureHash");
  record(
    "RuntimeEvidence schema has architectureHash field (reproducibility)",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 67: Evaluator returns breakdown with required/optional counts.
{
  const result: RuntimeVerificationResult = makeMinimalResult();
  const evaluation = evaluateRuntimeVerificationResult(result, makeMinimalPlan());
  const hasBreakdown = evaluation.breakdown &&
    typeof evaluation.breakdown.requiredPassed === "number" &&
    typeof evaluation.breakdown.requiredFailed === "number" &&
    typeof evaluation.breakdown.requiredMissing === "number" &&
    typeof evaluation.breakdown.optionalPassed === "number" &&
    typeof evaluation.breakdown.optionalSkipped === "number";
  record(
    "Evaluator returns breakdown with required/optional counts",
    hasBreakdown,
    `breakdown: ${JSON.stringify(evaluation.breakdown)}`
  );
}

// Helper for minimal result.
function makeMinimalResult(): RuntimeVerificationResult {
  return {
    repositoryHeadSha: "abc1234",
    headVerified: true,
    environmentFingerprint: { nodeVersion: "20", platform: "linux", arch: "x64", executionMode: "sandbox", workerVersion: "phase18", timestamp: new Date().toISOString() },
    dependencyInstallResult: { success: true, durationMs: 1000, exitCode: 0, output: "installed" },
    buildResult: { success: true, durationMs: 2000, exitCode: 0, output: "built" },
    startupResult: { success: true, durationMs: 500, exitCode: 0, output: "started", port: 3000, pid: 12345 },
    healthChecks: [],
    apiJourneys: [],
    integrationChecks: [],
    backgroundJobChecks: [],
    browserJourneys: [],
    teardownResult: { success: true, durationMs: 100 },
    passed: true,
    failureReason: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    logs: "",
    substrateAttestation: null,
  };
}

// ===========================================================================
// PHASE 18B: No defaults, canonical hash, idempotency, event semantics
// ===========================================================================

const runtimeModule18B = readFile("src/lib/runtime-verification.ts");
const evidenceRoute18B = readFile("src/app/api/worker/submit-runtime-evidence/route.ts");

// Test 68: Missing startupTimeoutMs → BLOCKED.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}", apiContracts: "[]", integrations: "[]", testingStrategy: "{}",
      deploymentModel: JSON.stringify({
        installCommands: ["npm install"], buildCommands: ["npm run build"],
        startCommand: "npm start", port: 3000, teardownTimeoutMs: 10000,
      }),
      frozen: true,
    }
  );
  record("Phase 18B: missing startupTimeoutMs → BLOCKED (no 30000 default)", plan === null, `plan: ${plan}`);
}

// Test 69: Missing teardownTimeoutMs → BLOCKED.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}", apiContracts: "[]", integrations: "[]", testingStrategy: "{}",
      deploymentModel: JSON.stringify({
        installCommands: ["npm install"], buildCommands: ["npm run build"],
        startCommand: "npm start", port: 3000, startupTimeoutMs: 30000,
      }),
      frozen: true,
    }
  );
  record("Phase 18B: missing teardownTimeoutMs → BLOCKED (no 10000 default)", plan === null, `plan: ${plan}`);
}

// Test 70: Missing health expectedStatus → BLOCKED.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}", apiContracts: "[]", integrations: "[]",
      testingStrategy: JSON.stringify({ healthEndpoints: [{ path: "/health", timeoutMs: 5000, required: "required" }] }),
      deploymentModel: JSON.stringify({
        installCommands: ["npm install"], buildCommands: ["npm run build"],
        startCommand: "npm start", port: 3000, startupTimeoutMs: 30000, teardownTimeoutMs: 10000,
      }),
      frozen: true,
    }
  );
  record("Phase 18B: missing health expectedStatus → BLOCKED (no 200 default)", plan === null, `plan: ${plan}`);
}

// Test 71: Missing API method → BLOCKED.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}",
      apiContracts: JSON.stringify([{ path: "/api/users", expectedStatus: 200 }]), // no method
      integrations: "[]", testingStrategy: "{}",
      deploymentModel: JSON.stringify({
        installCommands: ["npm install"], buildCommands: ["npm run build"],
        startCommand: "npm start", port: 3000, startupTimeoutMs: 30000, teardownTimeoutMs: 10000,
      }),
      frozen: true,
    }
  );
  record("Phase 18B: missing API method → BLOCKED (no GET default)", plan === null, `plan: ${plan}`);
}

// Test 72: Missing integration verificationMethod → BLOCKED.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}", apiContracts: "[]",
      integrations: JSON.stringify([{ name: "Postgres", type: "database", required: "required" }]), // no verificationMethod
      testingStrategy: "{}",
      deploymentModel: JSON.stringify({
        installCommands: ["npm install"], buildCommands: ["npm run build"],
        startCommand: "npm start", port: 3000, startupTimeoutMs: 30000, teardownTimeoutMs: 10000,
      }),
      frozen: true,
    }
  );
  record("Phase 18B: missing integration verificationMethod → BLOCKED (no connectivity default)", plan === null, `plan: ${plan}`);
}

// Test 73: Missing background observationWindowMs → BLOCKED.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}", apiContracts: "[]", integrations: "[]",
      testingStrategy: JSON.stringify({
        backgroundJobs: [{ name: "Email queue", type: "worker", required: "required", trigger: "manual", expectedEffect: "email sent" }],
      }),
      deploymentModel: JSON.stringify({
        installCommands: ["npm install"], buildCommands: ["npm run build"],
        startCommand: "npm start", port: 3000, startupTimeoutMs: 30000, teardownTimeoutMs: 10000,
      }),
      frozen: true,
    }
  );
  record("Phase 18B: missing background observationWindowMs → BLOCKED (no 5000 default)", plan === null, `plan: ${plan}`);
}

// Test 74: Missing browser timeoutMs → BLOCKED.
{
  const plan = deriveRuntimeVerificationPlan(
    { canonicalHeadSha: "abc123", githubRepo: "owner/repo", githubDefaultBranch: "main" },
    {
      contractJson: "{}", apiContracts: "[]", integrations: "[]",
      testingStrategy: JSON.stringify({
        browserJourneys: [{ name: "Login flow", url: "http://localhost:3000", required: "required", steps: [], assertions: [] }],
      }),
      deploymentModel: JSON.stringify({
        installCommands: ["npm install"], buildCommands: ["npm run build"],
        startCommand: "npm start", port: 3000, startupTimeoutMs: 30000, teardownTimeoutMs: 10000,
      }),
      frozen: true,
    }
  );
  record("Phase 18B: missing browser timeoutMs → BLOCKED (no 30000 default)", plan === null, `plan: ${plan}`);
}

// Test 75: No || defaults remain in runtime-verification.ts.
{
  const hasDefaultPattern = /\|\|\s*(200|10000|"GET"|"connectivity"|"manual"|5000|"optional"|30000)\b/.test(runtimeModule18B);
  record(
    "Phase 18B: no || runtime defaults remain in runtime-verification.ts",
    !hasDefaultPattern,
    `hasDefaultPattern: ${hasDefaultPattern}`
  );
}

// Test 76: Recursive canonical hash — reordered object keys produce same hash.
{
  const plan1: any = { a: 1, b: { y: 2, x: 1 }, c: [3, 2, 1] };
  const plan2: any = { c: [3, 2, 1], b: { x: 1, y: 2 }, a: 1 };
  // Use the internal canonicalSerialize via hashRuntimePlan (which wraps it).
  // We test with the public API by hashing plans with reordered keys.
  const hash1 = hashRuntimePlan(plan1 as any);
  const hash2 = hashRuntimePlan(plan2 as any);
  record(
    "Phase 18B: reordered object keys → identical hash (recursive canonical serialization)",
    hash1 === hash2,
    `hash1: ${hash1}, hash2: ${hash2}`
  );
}

// Test 77: Reordered array elements → different hash.
{
  const plan1: any = { a: [1, 2, 3] };
  const plan2: any = { a: [3, 2, 1] };
  const hash1 = hashRuntimePlan(plan1 as any);
  const hash2 = hashRuntimePlan(plan2 as any);
  record(
    "Phase 18B: reordered array elements → different hash (order matters)",
    hash1 !== hash2,
    `hash1: ${hash1}, hash2: ${hash2}`
  );
}

// Test 78: Endpoint does NOT emit PRODUCTION_READY from evaluation.passed alone.
{
  // The first event should use TASK_COMPLETED/TASK_FAILED, not PRODUCTION_READY.
  const noEarlyProductionReady = !evidenceRoute18B.includes("evaluation.passed ? BuildEventType.PRODUCTION_READY");
  record(
    "Phase 18B: endpoint does NOT emit PRODUCTION_READY from evaluation.passed alone",
    noEarlyProductionReady,
    `noEarlyProductionReady: ${noEarlyProductionReady}`
  );
}

// Test 79: Endpoint emits RUNTIME_VERIFIED event type.
{
  const emitsRuntimeVerified = evidenceRoute18B.includes("RUNTIME_VERIFIED");
  record(
    "Phase 18B: endpoint emits RUNTIME_VERIFIED event type",
    emitsRuntimeVerified,
    `emitsRuntimeVerified: ${emitsRuntimeVerified}`
  );
}

// Test 80: Endpoint has idempotency check.
{
  const hasIdempotency = evidenceRoute18B.includes("idempotencyKey") && evidenceRoute18B.includes("findUnique");
  record(
    "Phase 18B: endpoint has idempotency check (projectId+executionId+attempt)",
    hasIdempotency,
    `hasIdempotency: ${hasIdempotency}`
  );
}

// Test 81: Endpoint returns idempotent response for duplicate submission.
{
  const returnsIdempotent = evidenceRoute18B.includes("idempotent: true");
  record(
    "Phase 18B: endpoint returns idempotent response for duplicate submission",
    returnsIdempotent,
    `returnsIdempotent: ${returnsIdempotent}`
  );
}

// Test 82: RuntimeEvidence schema has idempotencyKey field.
{
  const hasField = readFile("prisma/schema.prisma").includes("idempotencyKey  String   @unique");
  record(
    "Phase 18B: RuntimeEvidence schema has idempotencyKey @unique field",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 83: RuntimeEvidence schema has attempt field.
{
  const hasField = readFile("prisma/schema.prisma").includes("attempt         Int");
  record(
    "Phase 18B: RuntimeEvidence schema has attempt field",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 84: Runtime PASS + static FAIL → NOT PRODUCTION_READY.
{
  const allTrue: ProductionReadinessEvidence = {
    architectureFrozen: true, allTasksCompleted: true, allTasksIntegrated: true,
    staticReadinessPassed: false, // STATIC FAILS
    runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true, executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
    artifactManifestVerified: true,
    artifactRetrievable: true,
    repositoryHeadVerified: true,
  };
  record(
    "Phase 18B: runtime PASS + static FAIL → NOT PRODUCTION_READY",
    !canReachProductionReadyWithRuntime(allTrue),
    `result: ${canReachProductionReadyWithRuntime(allTrue)}`
  );
}

// Test 85: Runtime PASS + unsandboxed → NOT PRODUCTION_READY.
{
  const allTrue: ProductionReadinessEvidence = {
    architectureFrozen: true, allTasksCompleted: true, allTasksIntegrated: true,
    staticReadinessPassed: true,
    runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true,
    executionEnvironmentSandboxed: false, // UNSANDBOXED
    substrateAttestationVerified: false,
    artifactManifestVerified: true,
    artifactRetrievable: true,
    repositoryHeadVerified: true,
  };
  record(
    "Phase 18B: runtime PASS + unsandboxed → NOT PRODUCTION_READY",
    !canReachProductionReadyWithRuntime(allTrue),
    `result: ${canReachProductionReadyWithRuntime(allTrue)}`
  );
}

// Test 86: Runtime PASS + wrong SHA → NOT PRODUCTION_READY.
{
  const allTrue: ProductionReadinessEvidence = {
    architectureFrozen: true, allTasksCompleted: true, allTasksIntegrated: true,
    staticReadinessPassed: true,
    runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true,
    executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
    artifactManifestVerified: true,
    artifactRetrievable: true,
    repositoryHeadVerified: false, // SHA NOT VERIFIED
  };
  record(
    "Phase 18B: runtime PASS + wrong SHA → NOT PRODUCTION_READY",
    !canReachProductionReadyWithRuntime(allTrue),
    `result: ${canReachProductionReadyWithRuntime(allTrue)}`
  );
}

// Test 87: All conditions true → PRODUCTION_READY.
{
  const allTrue: ProductionReadinessEvidence = {
    architectureFrozen: true, allTasksCompleted: true, allTasksIntegrated: true,
    staticReadinessPassed: true,
    runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true,
    executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
    artifactManifestVerified: true,
    artifactRetrievable: true,
    repositoryHeadVerified: true,
  };
  record(
    "Phase 18B: all conditions true → PRODUCTION_READY",
    canReachProductionReadyWithRuntime(allTrue),
    `result: ${canReachProductionReadyWithRuntime(allTrue)}`
  );
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18B: Final Runtime Policy Hardening ===\n");
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
  console.log("\n❌ RUNTIME VERIFICATION ARCHITECTURE NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Runtime verification architecture verified — PRODUCTION_READY now requires both static AND runtime evidence");
  process.exit(0);
}
