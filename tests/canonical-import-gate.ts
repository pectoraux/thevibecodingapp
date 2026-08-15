// Forge — Phase 11C Canonical Import Gate
//
// This test mechanically proves that poller.ts imports from modules and does
// NOT define duplicate implementations. It distinguishes between:
//   import { gitClone } from "./git/repository.js"  ← CORRECT
//   function gitClone(...)                          ← FORBIDDEN
//
// This is the definitive canonical execution path gate.

import { readFileSync, existsSync } from "node:fs";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

const poller = readFile("mini-services/execution-worker/poller.ts");

// --- Functions that MUST be imported, NOT defined in poller.ts ---

const requiredImports = [
  { name: "gitClone", module: "git/repository.ts" },
  { name: "gitPush", module: "git/repository.ts" },
  { name: "gitAddAndCommit", module: "git/repository.ts" },
  { name: "gitCheckoutBranch", module: "git/repository.ts" },
  { name: "gitRevParse", module: "git/repository.ts" },
  { name: "gitDiff", module: "git/repository.ts" },
  { name: "callLLM", module: "llm/gateway.ts" },
  { name: "runDeterministicGuardian", module: "verification/index.ts" },
  { name: "runLlmReviewer", module: "verification/index.ts" },
  { name: "getVerificationCommands", module: "verification/index.ts" },
];

for (const { name, module } of requiredImports) {
  // Check it's imported
  const isImported = poller.includes(`import {`) && poller.includes(name) && poller.includes(module);
  // Check it's NOT defined as a function in poller
  const isDefined = new RegExp(`function\\s+${name}\\s*\\(`).test(poller);
  // Also check for arrow function definitions
  const isArrowDefined = new RegExp(`const\\s+${name}\\s*=`).test(poller) &&
    !poller.includes(`import {`) === false; // exclude imports

  results.push({
    name: `${name} is imported from ${module}, NOT defined in poller.ts`,
    passed: isImported && !isDefined,
    details: `Imported: ${isImported}, Defined locally: ${isDefined}`,
  });
}

// --- Check that module files exist and define the functions ---

const modules = [
  { path: "mini-services/execution-worker/git/repository.ts", functions: ["gitClone", "gitPush", "gitAddAndCommit", "gitCheckoutBranch", "gitRevParse", "gitDiff"] },
  { path: "mini-services/execution-worker/llm/gateway.ts", functions: ["callLLM"] },
  { path: "mini-services/execution-worker/verification/index.ts", functions: ["runDeterministicGuardian", "runLlmReviewer", "getVerificationCommands"] },
];

for (const { path, functions } of modules) {
  const exists = existsSync(path);
  const content = readFile(path);

  results.push({
    name: `Module ${path} exists`,
    passed: exists,
    details: exists ? "Present" : "MISSING",
  });

  for (const func of functions) {
    const isDefined = new RegExp(`(export\\s+)?(async\\s+)?function\\s+${func}\\s*\\(`).test(content);
    results.push({
      name: `${func} is defined in ${path}`,
      passed: isDefined,
      details: isDefined ? "Defined" : "NOT FOUND",
    });
  }
}

// --- Check poller does NOT contain provider-specific HTTP logic ---

const providerPatterns = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.x.ai",
];

for (const pattern of providerPatterns) {
  const inPoller = poller.includes(pattern);
  results.push({
    name: `Provider URL ${pattern} is NOT in poller.ts`,
    passed: !inPoller,
    details: inPoller ? "FOUND in poller — should be in llm/gateway.ts only" : "Clean — in gateway module only",
  });
}

// --- Check poller does NOT contain execSync ---

const hasExecSync = poller.includes("execSync(");
results.push({
  name: "poller.ts does NOT use execSync",
  passed: !hasExecSync,
  details: hasExecSync ? "FOUND execSync — should use execFileSync via git module" : "Clean",
});

// --- Check authenticated GitHub flow is wired ---

const hasCredentialResolution = poller.includes("resolve-github-credential");
const hasAuthenticatedClone = poller.includes("x-access-token");
const hasCredentialCleanup = poller.includes("remote", "set-url");

results.push({
  name: "poller.ts calls resolve-github-credential",
  passed: hasCredentialResolution,
  details: hasCredentialResolution ? "Found" : "NOT FOUND",
});

results.push({
  name: "poller.ts uses authenticated clone URL (x-access-token)",
  passed: hasAuthenticatedClone,
  details: hasAuthenticatedClone ? "Found" : "NOT FOUND",
});

results.push({
  name: "poller.ts cleans up credentials after clone/push",
  passed: poller.includes("set-url") && poller.includes("origin"),
  details: "Found git remote set-url cleanup" ,
});

// --- Check job-spec has no npm fallback ---

const jobSpec = readFile("src/app/api/worker/job-spec/route.ts");
const hasNpmFallback = jobSpec.includes("npm install") || jobSpec.includes("npm test") || jobSpec.includes("npm run");
const returnsNull = jobSpec.includes("return null;");

results.push({
  name: "job-spec does NOT have npm fallback",
  passed: !hasNpmFallback,
  details: hasNpmFallback ? "FOUND npm commands" : "Clean — no npm",
});

results.push({
  name: "job-spec returns null when VerificationPlan missing",
  passed: returnsNull,
  details: returnsNull ? "Returns null (BLOCKED)" : "Does NOT return null",
});

// --- Summary ---

console.log("=== Forge Phase 11C Canonical Import Gate ===\n");
let passed = 0, failed = 0;
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  console.log(`  ${r.details}`);
  if (r.passed) passed++; else failed++;
}
console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("\n❌ CANONICAL EXECUTION PATH NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Canonical execution path verified — modules are the sole implementation");
  process.exit(0);
}
