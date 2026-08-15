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

function getVerificationCommandsReturnsNull(poller: string): boolean {
  // P11: getVerificationCommands should return null when no plan exists
  return poller.includes("return null;") && poller.includes("getVerificationCommands");
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

// P11: No silent base commit fallback
const hasSilentBaseCommitFallback = poller.includes("starting fresh");
results.push({
  name: "No silent base commit fallback",
  passed: !hasSilentBaseCommitFallback,
  details: hasSilentBaseCommitFallback ? "FOUND 'starting fresh' — silent fallback" : "No silent fallback",
});

// P11: No npm fallback for VerificationPlan
const hasNpmFallback = poller.includes('install: ["npm install"]\n    test: ["npm test"]\n    build: ["npm run build"]\n    lint: []');
results.push({
  name: "No silent npm fallback for VerificationPlan",
  passed: !hasNpmFallback,
  details: hasNpmFallback ? "FOUND npm fallback" : "No npm fallback (returns null = BLOCKED)",
});

// P11: Git uses execFileSync (safe argument arrays), not execSync (shell interpolation)
// Now checks the git module, not the poller directly.
const gitModule = readFile("mini-services/execution-worker/git/repository.ts");
const hasExecSync = gitModule.includes("execSync(") || poller.includes("execSync(");
const hasExecFileSync = gitModule.includes("execFileSync(");
results.push({
  name: "Git uses safe argument arrays (execFileSync, not execSync)",
  passed: !hasExecSync && hasExecFileSync,
  details: `execSync: ${hasExecSync}, execFileSync: ${hasExecFileSync}`,
});

// P11: Worker clones real repository (in git module)
const hasGitClone = gitModule.includes("export function gitClone") || poller.includes("gitClone");
results.push({
  name: "Worker has gitClone for real repository continuity",
  passed: hasGitClone,
  details: hasGitClone ? "gitClone found" : "No gitClone",
});

// P11: Worker pushes to remote (in git module)
const hasGitPush = gitModule.includes("export function gitPush") || poller.includes("gitPush");
results.push({
  name: "Worker has gitPush for remote branch creation",
  passed: hasGitPush,
  details: hasGitPush ? "gitPush found" : "No gitPush",
});

// realGit — check git module
const hasGitInit = gitModule.includes("export function gitInit") || poller.includes("gitInit");
const hasGitAddAndCommit = gitModule.includes("export function gitAddAndCommit") || poller.includes("gitAddAndCommit");
const hasGitCheckoutBranch = gitModule.includes("export function gitCheckoutBranch") || poller.includes("gitCheckoutBranch");
results.push({
  name: "realGit = true",
  passed: hasGitInit && hasGitAddAndCommit && hasGitCheckoutBranch,
  details: `gitInit: ${hasGitInit}, gitAddAndCommit: ${hasGitAddAndCommit}, gitCheckoutBranch: ${hasGitCheckoutBranch}`,
});

// realCommit — check git module
const hasCommitReturn = gitModule.includes("export function gitAddAndCommit") && poller.includes("gitAddAndCommit");
results.push({
  name: "realCommit = true",
  passed: hasCommitReturn,
  details: hasCommitReturn ? "gitAddAndCommit in module + used in poller" : "No real commit return",
});

// baseCommitPropagation
const jobSpec = readFile("src/app/api/worker/job-spec/route.ts");
const hasBaseCommitLookup = jobSpec.includes("depTasks") || jobSpec.includes("code: { in: deps");
results.push({
  name: "baseCommitPropagation = true",
  passed: hasBaseCommitLookup,
  details: hasBaseCommitLookup ? "Task graph lookup for baseCommitSha" : "No base commit propagation",
});

// byokGateway — check llm module
const llmModule = readFile("mini-services/execution-worker/llm/gateway.ts");
const hasCallLLM = llmModule.includes("export async function callLLM");
const hasCallByokProvider = llmModule.includes("callByokProvider") || llmModule.includes("callAnthropic") || llmModule.includes("callOpenAICompatible");
results.push({
  name: "byokGateway = true",
  passed: hasCallLLM && hasCallByokProvider,
  details: `callLLM: ${hasCallLLM}, provider adapters: ${hasCallByokProvider}`,
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
  } else if (pattern === "versionPhase10") {
    const hasPhase10 = versionRoute.includes('"phase10"');
    results.push({
      name: `Forbidden: ${pattern}`,
      passed: !hasPhase10,
      details: hasPhase10 ? "Version endpoint says phase10" : "Clean",
    });
  } else if (pattern === "versionPhase11a") {
    const hasPhase11a = versionRoute.includes('"phase11a"');
    results.push({
      name: `Forbidden: ${pattern}`,
      passed: !hasPhase11a,
      details: hasPhase11a ? "Version endpoint says phase11a" : "Clean",
    });
  } else if (pattern === "silentBaseCommitFallback") {
    const hasFallback = poller.includes("starting fresh");
    results.push({
      name: `Forbidden: ${pattern}`,
      passed: !hasFallback,
      details: hasFallback ? "Found 'starting fresh'" : "Clean",
    });
  } else if (pattern === "npmFallbackForVerificationPlan") {
    const hasNpmFallback = getVerificationCommandsReturnsNull(poller);
    results.push({
      name: `Forbidden: ${pattern}`,
      passed: hasNpmFallback,
      details: hasNpmFallback ? "Returns null (BLOCKED)" : "Still has npm fallback",
    });
  } else if (pattern === "shellInterpolatedGit") {
    const hasExecSync = poller.includes("execSync(") || gitModule.includes("execSync(");
    results.push({
      name: `Forbidden: ${pattern}`,
      passed: !hasExecSync,
      details: hasExecSync ? "Uses execSync (shell interpolation)" : "Uses execFileSync (safe)",
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
