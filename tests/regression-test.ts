// Forge — Phase 5 Regression Tests
//
// These tests verify the critical invariants from each phase are maintained.
// They run against the codebase (not the running server) to catch regressions.
//
// Run with: bun run tests/regression-test.ts

import { readFileSync, existsSync } from "node:fs";

interface TestResult {
  phase: string;
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

// --- Phase 1: No template fallback in production ---

function testNoTemplateFallback() {
  const llmGateway = readFile("src/lib/llm-gateway.ts");
  const llm = readFile("src/lib/llm.ts");

  // The TemplateAdapter must not be importable in the production path.
  const templateInGateway = llmGateway.includes("TemplateAdapter");
  const gatewayAllowsTemplate = llmGateway.includes("isTemplateAdapterAllowed");

  results.push({
    phase: "Phase 1",
    name: "No template fallback in production LLM gateway",
    passed: !templateInGateway || (gatewayAllowsTemplate && !llmGateway.includes("new TemplateAdapter()")),
    details: templateInGateway
      ? `TemplateAdapter referenced in llm-gateway.ts (allowed only if gated by isTemplateAdapterAllowed)`
      : "TemplateAdapter not in llm-gateway.ts",
  });

  // The llm.ts shim must not import or instantiate TemplateAdapter.
  // Re-exporting `isTemplateAdapterAllowed` (a function name) is OK — that's the gating function.
  // What's NOT OK is `new TemplateAdapter()` or importing the class itself.
  const hasTemplateInstantiation = llm.includes("new TemplateAdapter()");
  const hasTemplateImport = /import.*TemplateAdapter/.test(llm);

  results.push({
    phase: "Phase 1",
    name: "llm.ts does not instantiate or import TemplateAdapter",
    passed: !hasTemplateInstantiation && !hasTemplateImport,
    details: hasTemplateInstantiation
      ? "TemplateAdapter instantiated in llm.ts"
      : hasTemplateImport
      ? "TemplateAdapter imported in llm.ts"
      : "Clean (only isTemplateAdapterAllowed gating function re-exported)",
  });
}

// --- Phase 2: No fake SHA, no DB shadow commit ---

function testNoFakeSha() {
  const orchestrator = readFile("src/lib/orchestrator.ts");

  // The orchestrator must not have `realCommitSha || dbSha` pattern.
  const hasFakeShaFallback = orchestrator.includes("realCommitSha || dbSha") ||
                              orchestrator.includes("|| dbSha");
  // Must have the BLOCKED path for no real commit.
  const hasBlockedPath = orchestrator.includes("No real git commit") &&
                         orchestrator.includes("BLOCKED");

  results.push({
    phase: "Phase 2",
    name: "No fake SHA fallback (realCommitSha || dbSha)",
    passed: !hasFakeShaFallback,
    details: hasFakeShaFallback ? "Found fake SHA fallback pattern" : "No fake SHA fallback",
  });

  results.push({
    phase: "Phase 2",
    name: "BLOCKED when no real git commit",
    passed: hasBlockedPath,
    details: hasBlockedPath ? "BLOCKED path exists for missing commit" : "No BLOCKED path found",
  });
}

// --- Phase 3: No direct control-plane execution ---

function testNoDirectExecution() {
  const orchestrator = readFile("src/lib/orchestrator.ts");
  const executionClient = readFile("src/lib/execution-client.ts");

  // The orchestrator must use submitExecutionJob, not direct spawn.
  const usesExecutionClient = orchestrator.includes("submitExecutionJob");
  // Must not import spawn directly (except in the local fallback of execution-client).
  const orchestratorHasSpawn = orchestrator.includes("from \"node:child_process\"");

  results.push({
    phase: "Phase 3",
    name: "Orchestrator uses execution client (not direct spawn)",
    passed: usesExecutionClient && !orchestratorHasSpawn,
    details: `submitExecutionJob: ${usesExecutionClient}, direct spawn in orchestrator: ${orchestratorHasSpawn}`,
  });

  // The execution client must have env allowlist.
  const hasAllowlist = executionClient.includes("FORBIDDEN") || executionClient.includes("ALLOWED_ENV_KEYS");
  results.push({
    phase: "Phase 3",
    name: "Execution client has env allowlist",
    passed: hasAllowlist,
    details: hasAllowlist ? "Env allowlist found" : "No env allowlist",
  });
}

// --- Phase 4: Worker authentication, no CORS, server-controlled workspaces ---

function testWorkerSecurity() {
  const worker = readFile("mini-services/execution-worker/index.ts");

  // Must have HMAC verification.
  const hasHmac = worker.includes("createHmac") && worker.includes("verifyToken");
  // Must NOT have CORS wildcard.
  const hasCorsWildcard = worker.includes("Access-Control-Allow-Origin: *");
  // Must NOT accept client-supplied worktreePath.
  const acceptsWorktreePath = worker.includes("job.worktreePath");
  // Must have path containment.
  const hasPathContainment = worker.includes("isPathSafe") || worker.includes("Path escapes sandbox");
  // Must have command policy.
  const hasCommandPolicy = worker.includes("validateCommand") || worker.includes("FORBIDDEN_COMMANDS");

  results.push({
    phase: "Phase 4",
    name: "Worker has HMAC authentication",
    passed: hasHmac,
    details: hasHmac ? "HMAC verification found" : "No HMAC verification",
  });

  results.push({
    phase: "Phase 4",
    name: "Worker has no CORS wildcard",
    passed: !hasCorsWildcard,
    details: hasCorsWildcard ? "CORS wildcard found!" : "No CORS wildcard",
  });

  results.push({
    phase: "Phase 4",
    name: "Worker does not accept client-supplied worktreePath",
    passed: !acceptsWorktreePath,
    details: acceptsWorktreePath ? "Client can control worktreePath!" : "Server-controlled workspaces",
  });

  results.push({
    phase: "Phase 4",
    name: "Worker has path containment",
    passed: hasPathContainment,
    details: hasPathContainment ? "Path containment found" : "No path containment",
  });

  results.push({
    phase: "Phase 4",
    name: "Worker has command policy",
    passed: hasCommandPolicy,
    details: hasCommandPolicy ? "Command policy found" : "No command policy",
  });
}

// --- Phase 5: Durable job leases, production enforcement ---

function testDurableJobs() {
  const jobQueue = readFile("src/lib/job-queue.ts");
  const prodEnforcement = readFile("src/lib/production-enforcement.ts");
  const schema = readFile("prisma/schema.prisma");

  const hasLeases = jobQueue.includes("claimNextJob") && jobQueue.includes("leaseExpiresAt");
  const hasHeartbeat = jobQueue.includes("heartbeat") && jobQueue.includes("heartbeatAt");
  const hasRecovery = jobQueue.includes("recoverExpiredJobs");
  const hasIdempotency = jobQueue.includes("idempotencyKey") || schema.includes("idempotencyKey");
  const hasProdEnforcement = prodEnforcement.includes("enforceProductionMode") && prodEnforcement.includes("LOCAL_UNSANDBOXED");
  const hasLeaseFields = schema.includes("leaseExpiresAt") && schema.includes("workerId");

  results.push({
    phase: "Phase 5",
    name: "Job queue has lease/claim mechanism",
    passed: hasLeases,
    details: hasLeases ? "claimNextJob + leaseExpiresAt found" : "Missing lease mechanism",
  });

  results.push({
    phase: "Phase 5",
    name: "Job queue has heartbeat",
    passed: hasHeartbeat,
    details: hasHeartbeat ? "heartbeat function found" : "No heartbeat",
  });

  results.push({
    phase: "Phase 5",
    name: "Job queue has recovery for expired leases",
    passed: hasRecovery,
    details: hasRecovery ? "recoverExpiredJobs found" : "No recovery",
  });

  results.push({
    phase: "Phase 5",
    name: "Jobs have idempotency keys",
    passed: hasIdempotency,
    details: hasIdempotency ? "Idempotency key found" : "No idempotency",
  });

  results.push({
    phase: "Phase 5",
    name: "Production refuses LOCAL_UNSANDBOXED",
    passed: hasProdEnforcement,
    details: hasProdEnforcement ? "Production enforcement found" : "No production enforcement",
  });

  results.push({
    phase: "Phase 5",
    name: "BuildJob schema has lease fields",
    passed: hasLeaseFields,
    details: hasLeaseFields ? "Lease fields in schema" : "Missing lease fields",
  });
}

// --- Phase 5: Version endpoint ---

function testVersionEndpoint() {
  const versionRoute = readFile("src/app/api/version/route.ts");
  const hasGitSha = versionRoute.includes("gitSha");
  const hasBuildTime = versionRoute.includes("buildTime");
  const hasExecMode = versionRoute.includes("executionMode");

  results.push({
    phase: "Phase 5",
    name: "Version endpoint returns gitSha",
    passed: hasGitSha,
    details: hasGitSha ? "gitSha found" : "No gitSha",
  });

  results.push({
    phase: "Phase 5",
    name: "Version endpoint returns buildTime + executionMode",
    passed: hasBuildTime && hasExecMode,
    details: `buildTime: ${hasBuildTime}, executionMode: ${hasExecMode}`,
  });
}

// --- Run all tests ---

testNoTemplateFallback();
testNoFakeSha();
testNoDirectExecution();
testWorkerSecurity();
testDurableJobs();
testVersionEndpoint();

// --- Summary ---

console.log("=== Forge Phase 5 Regression Tests ===\n");

let passed = 0, failed = 0;
let currentPhase = "";
for (const r of results) {
  if (r.phase !== currentPhase) {
    currentPhase = r.phase;
    console.log(`--- ${currentPhase} ---`);
  }
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  console.log(`  ${r.details}`);
  if (r.passed) passed++; else failed++;
}

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  console.log("\n❌ Regression tests FAILED — a phase invariant was broken");
  process.exit(1);
} else {
  console.log("\n✅ All regression tests PASSED — all phase invariants maintained");
  process.exit(0);
}
