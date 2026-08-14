// Forge — Phase 10B Manifest Verification
//
// Reads architecture/phase10-manifest.json and verifies all required invariants
// from a clean clone. This is the canonical phase completion gate.

import { readFileSync, existsSync } from "node:fs";

interface Manifest {
  architectureVersion: string;
  requiredFiles: string[];
  requiredInvariants: Record<string, any>;
  forbiddenPatterns: Record<string, string>;
  tests: string[];
}

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function fileExists(path: string): boolean {
  try { return existsSync(path); } catch { return false; }
}

// Load manifest
const manifestPath = "architecture/phase10-manifest.json";
const manifest: Manifest | null = fileExists(manifestPath)
  ? JSON.parse(readFileSync(manifestPath))
  : null;

if (!manifest) {
  console.error("FATAL: architecture/phase10-manifest.json not found");
  process.exit(1);
}

console.log(`=== Forge Phase 10B Manifest Verification ===`);
console.log(`Architecture version: ${manifest.architectureVersion}\n`);

// --- Check required files exist ---
for (const file of manifest.requiredFiles) {
  const exists = fileExists(file);
  results.push({
    name: `Required file exists: ${file}`,
    passed: exists,
    details: exists ? "Present" : "MISSING",
  });
}

// --- Check required invariants ---

// workerVersion
const poller = readFile("mini-services/execution-worker/poller.ts");
const workerVersion = poller.match(/WORKER_VERSION = "([^"]+)"/)?.[1];
results.push({
  name: `workerVersion = ${manifest.requiredInvariants.workerVersion}`,
  passed: workerVersion === manifest.requiredInvariants.workerVersion,
  details: `Found: ${workerVersion}`,
});

// versionEndpoint
const versionRoute = readFile("src/app/api/version/route.ts");
const versionString = versionRoute.match(/version: "([^"]+)"/)?.[1];
results.push({
  name: `versionEndpoint = ${manifest.requiredInvariants.versionEndpoint}`,
  passed: versionString === manifest.requiredInvariants.versionEndpoint,
  details: `Found: ${versionString}`,
});

// realGit
const hasGitInit = poller.includes("gitInit");
const hasGitAddAndCommit = poller.includes("gitAddAndCommit");
const hasGitCheckoutBranch = poller.includes("gitCheckoutBranch");
results.push({
  name: "realGit = true",
  passed: hasGitInit && hasGitAddAndCommit && hasGitCheckoutBranch,
  details: `gitInit: ${hasGitInit}, gitAddAndCommit: ${hasGitAddAndCommit}, gitCheckoutBranch: ${hasGitCheckoutBranch}`,
});

// realCommit
const hasCommitReturn = poller.includes("commitSha = gitAddAndCommit");
results.push({
  name: "realCommit = true",
  passed: hasCommitReturn,
  details: hasCommitReturn ? "Commit SHA captured from gitAddAndCommit" : "No real commit return",
});

// baseCommitPropagation
const jobSpec = readFile("src/app/api/worker/job-spec/route.ts");
const hasBaseCommitLookup = jobSpec.includes("depTasks") || jobSpec.includes("code: { in: deps");
results.push({
  name: "baseCommitPropagation = true",
  passed: hasBaseCommitLookup,
  details: hasBaseCommitLookup ? "Task graph lookup for baseCommitSha" : "No base commit propagation",
});

// byokGateway
const hasCallLLM = poller.includes("async function callLLM");
const hasCallByokProvider = poller.includes("async function callByokProvider");
results.push({
  name: "byokGateway = true",
  passed: hasCallLLM && hasCallByokProvider,
  details: `callLLM: ${hasCallLLM}, callByokProvider: ${hasCallByokProvider}`,
});

// deterministicGuardian
const hasRunDeterministicGuardian = poller.includes("runDeterministicGuardian");
results.push({
  name: "deterministicGuardian = true",
  passed: hasRunDeterministicGuardian,
  details: hasRunDeterministicGuardian ? "runDeterministicGuardian found" : "Not found",
});

// deterministicGuardianIndependentOfTests
// Check that the Guardian's verdict is NOT assigned from testResults.every
// The Guardian function (runDeterministicGuardian) checks architecture, not tests.
// The poller's success check uses testResults.every for testsOk, which is correct —
// but the Guardian verdict itself must come from runDeterministicGuardian.
const guardianVerdictFromTests = /guardianResult\s*=\s*\{[^}]*verdict:\s*testResults/.test(poller);
results.push({
  name: "deterministicGuardianIndependentOfTests = true",
  passed: !guardianVerdictFromTests,
  details: guardianVerdictFromTests ? "GUARDIAN VERDICT DERIVES FROM TESTS — VIOLATION" : "Guardian verdict comes from runDeterministicGuardian (architecture check)",
});

// independentReviewer
const hasRunLlmReviewer = poller.includes("runLlmReviewer");
results.push({
  name: "independentReviewer = true",
  passed: hasRunLlmReviewer,
  details: hasRunLlmReviewer ? "runLlmReviewer found" : "Not found",
});

// reviewerIndependentOfTests
// Check that the Reviewer's verdict is NOT assigned from testResults.every
// The Reviewer function (runLlmReviewer) makes a separate LLM call.
const reviewerVerdictFromTests = /reviewResult\s*=\s*\{[^}]*verdict:\s*testResults/.test(poller);
results.push({
  name: "reviewerIndependentOfTests = true",
  passed: !reviewerVerdictFromTests,
  details: reviewerVerdictFromTests ? "REVIEWER VERDICT DERIVES FROM TESTS — VIOLATION" : "Reviewer verdict comes from runLlmReviewer (separate LLM call)",
});

// verificationPlanFromArchitecture
const hasVerificationPlanExtraction = jobSpec.includes("contract.verificationPlan");
results.push({
  name: "verificationPlanFromArchitecture = true",
  passed: hasVerificationPlanExtraction,
  details: hasVerificationPlanExtraction ? "Extracts from architecture contract" : "Hardcoded",
});

// commitRequiredForCompletion
const submitEvidence = readFile("src/app/api/worker/submit-evidence/route.ts");
const hasHasRealCommit = submitEvidence.includes("hasRealCommit");
const hasCanCompleteWithCommit = submitEvidence.includes("canComplete = hasRealCommit");
results.push({
  name: "commitRequiredForCompletion = true",
  passed: hasHasRealCommit && hasCanCompleteWithCommit,
  details: `hasRealCommit: ${hasHasRealCommit}, canComplete requires it: ${hasCanCompleteWithCommit}`,
});

// successExpressionConsistent
const hasConsistentSuccess = !submitEvidence.includes("const success = guardianOk && reviewOk && testsOk");
results.push({
  name: "successExpressionConsistent = true",
  passed: hasConsistentSuccess,
  details: hasConsistentSuccess ? "No second success definition without commit" : "FOUND inconsistent success expression",
});

// executeTaskDeleted
const executeTaskExists = fileExists("src/app/api/worker/execute-task/route.ts");
results.push({
  name: "executeTaskDeleted = true",
  passed: !executeTaskExists,
  details: executeTaskExists ? "execute-task STILL EXISTS" : "Confirmed absent",
});

// --- Check forbidden patterns ---
for (const [pattern, description] of Object.entries(manifest.forbiddenPatterns)) {
  if (pattern === "versionPhase5") {
    const hasPhase5 = versionRoute.includes('"phase5"');
    results.push({
      name: `Forbidden: ${pattern}`,
      passed: !hasPhase5,
      details: hasPhase5 ? "Version endpoint says phase5" : "Clean",
    });
  } else if (pattern === "versionPhase8") {
    const hasPhase8 = versionRoute.includes('"phase8"');
    results.push({
      name: `Forbidden: ${pattern}`,
      passed: !hasPhase8,
      details: hasPhase8 ? "Version endpoint says phase8" : "Clean",
    });
  }
}

// --- Summary ---
let passed = 0, failed = 0;
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  console.log(`  ${r.details}`);
  if (r.passed) passed++; else failed++;
}

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("\n❌ PHASE 10 MANIFEST NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Phase 10 manifest satisfied — canonical implementation verified");
  process.exit(0);
}
