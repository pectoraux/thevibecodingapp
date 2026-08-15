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
  type ProductionReadinessEvidence,
  type RuntimeVerificationResult,
  type RuntimeVerificationPlan,
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
  };
  const evaluation = evaluateRuntimeVerificationResult(result);
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
  };
  const evaluation = evaluateRuntimeVerificationResult(result);
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
  };
  const evaluation = evaluateRuntimeVerificationResult(result);
  record(
    "evaluateRuntimeVerificationResult fails when startup fails",
    !evaluation.passed && evaluation.failureReason?.includes("startup"),
    `passed: ${evaluation.passed}, reason: ${evaluation.failureReason}`
  );
}

// Test 27: evaluateRuntimeVerificationResult fails when health check fails.
{
  const result: RuntimeVerificationResult = {
    repositoryHeadSha: "abc1234",
    headVerified: true,
    environmentFingerprint: { nodeVersion: "20", platform: "linux", arch: "x64", executionMode: "sandbox", workerVersion: "phase18", timestamp: new Date().toISOString() },
    dependencyInstallResult: { success: true, durationMs: 1000, exitCode: 0, output: "installed" },
    buildResult: { success: true, durationMs: 2000, exitCode: 0, output: "built" },
    startupResult: { success: true, durationMs: 500, exitCode: 0, output: "started", port: 3000, pid: 12345 },
    healthChecks: [{ name: "health", path: "/api/health", passed: false, status: null, responseTimeMs: 0, error: "timeout" }],
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
  };
  const evaluation = evaluateRuntimeVerificationResult(result);
  record(
    "evaluateRuntimeVerificationResult fails when health check fails",
    !evaluation.passed && evaluation.failureReason?.includes("healthChecks"),
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
    null
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
        { method: "GET", path: "/api/users", name: "List users" },
        { method: "POST", path: "/api/auth/login", name: "Login" },
      ]),
      integrations: "[]",
      testingStrategy: "{}",
      deploymentModel: "{}",
    }
  );
  record(
    "deriveRuntimeVerificationPlan extracts API journeys from architecture",
    plan !== null && plan.apiJourneys.length === 2 && plan.apiJourneys[0].path === "/api/users",
    `journeys: ${plan?.apiJourneys.length}`
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
// Summary
// ===========================================================================

console.log("=== Forge Phase 18: Runtime Verification Invariants ===\n");
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
