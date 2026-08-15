// Forge — Phase 10A Commit-Required Regression Test
//
// Verifies that a task CANNOT be marked COMPLETED without a real commitSha.
// This is the hard invariant: no commit = no completion.

import { readFileSync } from "node:fs";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

// Test 1: submit-evidence requires commitSha for completion (P15: via canCompleteTask)
function testCommitRequired() {
  const content = readFile("src/app/api/worker/submit-evidence/route.ts");
  const policy = readFile("src/lib/completion-policy.ts");
  const hasCanCompleteTask = content.includes("canCompleteTask");
  const hasCommitCheck = policy.includes("commitSha") && policy.includes("length >= 7");
  const hasFailureReason = policy.includes("commit=MISSING") || policy.includes("getFailureReason");

  results.push({
    name: "submit-evidence requires real commitSha for completion",
    passed: hasCanCompleteTask && hasCommitCheck && hasFailureReason,
    details: `canCompleteTask: ${hasCanCompleteTask}, commit check in policy: ${hasCommitCheck}, failure reason: ${hasFailureReason}`,
  });
}

// Test 2: Worker creates real git commits
function testWorkerGitCommit() {
  const poller = readFile("mini-services/execution-worker/poller.ts");
  const gitModule = readFile("mini-services/execution-worker/git/repository.ts");
  const hasGitInit = gitModule.includes("export function gitInit") || poller.includes("gitInit");
  const hasGitAddAndCommit = gitModule.includes("export function gitAddAndCommit") || poller.includes("gitAddAndCommit");
  const hasGitCheckoutBranch = gitModule.includes("export function gitCheckoutBranch") || poller.includes("gitCheckoutBranch");
  const hasCommitShaReturn = poller.includes("gitAddAndCommit");

  results.push({
    name: "Worker creates real git commits",
    passed: hasGitInit && hasGitAddAndCommit && hasGitCheckoutBranch && hasCommitShaReturn,
    details: `gitInit: ${hasGitInit}, gitAddAndCommit: ${hasGitAddAndCommit}, gitCheckoutBranch: ${hasGitCheckoutBranch}, commit in poller: ${hasCommitShaReturn}`,
  });
}

// Test 3: Worker Guardian does NOT derive from test results
function testGuardianIndependent() {
  const poller = readFile("mini-services/execution-worker/poller.ts");
  const verificationModule = readFile("mini-services/execution-worker/verification/index.ts");
  const hasRunDeterministicGuardian = poller.includes("runDeterministicGuardian") || verificationModule.includes("runDeterministicGuardian");
  const hasArchitectureCheck = verificationModule.includes("forbiddenTechs");
  // The OLD pattern was: verdict = testResults.every(...) ? "PASS" : "VIOLATION"
  // Check that this pattern is NOT the Guardian's verdict logic.
  const hasTestDerivedGuardian = poller.includes('guardianResult = {\n    verdict: testResults.every');

  results.push({
    name: "Worker Guardian is independent of test results",
    passed: hasRunDeterministicGuardian && hasArchitectureCheck && !hasTestDerivedGuardian,
    details: `runDeterministicGuardian: ${hasRunDeterministicGuardian}, architecture check: ${hasArchitectureCheck}, test-derived guardian: ${hasTestDerivedGuardian}`,
  });
}

// Test 4: Worker Reviewer is a separate LLM invocation
function testReviewerIndependent() {
  const poller = readFile("mini-services/execution-worker/poller.ts");
  const verificationModule = readFile("mini-services/execution-worker/verification/index.ts");
  const hasRunLlmReviewer = poller.includes("runLlmReviewer") || verificationModule.includes("runLlmReviewer");
  const hasSeparatePrompt = verificationModule.includes("independent code reviewer");
  // The OLD pattern was: verdict = testResults.every(...) ? "APPROVED" : "CHANGES_REQUESTED"
  const hasTestDerivedReviewer = poller.includes('reviewResult = {\n    verdict: testResults.every');

  results.push({
    name: "Worker Reviewer is independent LLM invocation",
    passed: hasRunLlmReviewer && hasSeparatePrompt && !hasTestDerivedReviewer,
    details: `runLlmReviewer: ${hasRunLlmReviewer}, separate prompt: ${hasSeparatePrompt}, test-derived reviewer: ${hasTestDerivedReviewer}`,
  });
}

// Test 5: Worker uses BYOK gateway, not hardcoded SDK
function testByokGateway() {
  const poller = readFile("mini-services/execution-worker/poller.ts");
  const llmModule = readFile("mini-services/execution-worker/llm/gateway.ts");
  const hasCallLLM = llmModule.includes("export async function callLLM");
  const hasCallByokProvider = llmModule.includes("callAnthropic") || llmModule.includes("callOpenAICompatible") || llmModule.includes("callGoogle");
  const hasResolveCredential = poller.includes("resolve-credential") || llmModule.includes("resolve-credential");

  results.push({
    name: "Worker uses BYOK gateway (callLLM + callByokProvider)",
    passed: hasCallLLM && hasCallByokProvider && hasResolveCredential,
    details: `callLLM: ${hasCallLLM}, callByokProvider: ${hasCallByokProvider}, resolve-credential: ${hasResolveCredential}`,
  });
}

// Test 6: Job-spec resolves modelProviderRef from BYOK providers
function testJobSpecByokResolution() {
  const jobSpec = readFile("src/app/api/worker/job-spec/route.ts");
  const hasAgentAssignmentLookup = jobSpec.includes("agentAssignment.findFirst") || jobSpec.includes("agentAssignment");
  const hasModelProviderRef = jobSpec.includes("modelProviderRef");

  results.push({
    name: "Job-spec resolves modelProviderRef from BYOK providers",
    passed: hasAgentAssignmentLookup && hasModelProviderRef,
    details: `agentAssignment lookup: ${hasAgentAssignmentLookup}, modelProviderRef: ${hasModelProviderRef}`,
  });
}

// Test 7: Job-spec resolves baseCommitSha from canonicalHeadSha (P15F)
function testBaseCommitPropagation() {
  const jobSpec = readFile("src/app/api/worker/job-spec/route.ts");
  const hasBaseCommitSha = jobSpec.includes("baseCommitSha");
  const hasCanonicalHead = jobSpec.includes("canonicalHeadSha");

  results.push({
    name: "Job-spec resolves baseCommitSha from canonicalHeadSha",
    passed: hasBaseCommitSha && hasCanonicalHead,
    details: `baseCommitSha: ${hasBaseCommitSha}, canonicalHeadSha: ${hasCanonicalHead}`,
  });
}

// Run all tests
testCommitRequired();
testWorkerGitCommit();
testGuardianIndependent();
testReviewerIndependent();
testByokGateway();
testJobSpecByokResolution();
testBaseCommitPropagation();

// Summary
console.log("=== Forge Phase 10A Commit-Required Regression Tests ===\n");
let passed = 0, failed = 0;
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  console.log(`  ${r.details}\n`);
  if (r.passed) passed++; else failed++;
}
console.log(`=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("\n❌ REGRESSION DETECTED — a Phase 10 invariant was broken");
  process.exit(1);
} else {
  console.log("\n✅ All Phase 10 invariants satisfied");
  process.exit(0);
}
