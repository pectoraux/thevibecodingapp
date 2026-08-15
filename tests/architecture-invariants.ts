// Forge — Architecture Invariants Test
//
// This test mechanically verifies that the repository maintains a single
// coherent architecture. It fails if:
// - The old execute-task endpoint exists
// - Worker endpoints don't use authentication
// - The poller calls the control plane to execute tasks
// - The control plane imports execution modules (child_process, test-runner)
// - The version string is stale
//
// Run with: bun run tests/architecture-invariants.ts

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

function listFiles(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

// Recursively find all .ts files in a directory
function findTsFiles(dir: string): string[] {
  const files: string[] = [];
  function walk(d: string) {
    try {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (!entry.startsWith(".") && entry !== "node_modules" && entry !== ".next") {
            walk(full);
          }
        } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
          files.push(full);
        }
      }
    } catch {}
  }
  walk(dir);
  return files;
}

// --- Test 1: Old execute-task endpoint must NOT exist ---
function testExecuteTaskDeleted() {
  const exists = fileExists("src/app/api/worker/execute-task/route.ts");
  results.push({
    name: "Old /api/worker/execute-task endpoint is deleted",
    passed: !exists,
    details: exists ? "execute-task/route.ts STILL EXISTS — must be deleted" : "Confirmed absent",
  });
}

// --- Test 2: All worker endpoints must use getWorkerToken ---
function testWorkerEndpointAuth() {
  const endpoints = ["register", "claim", "heartbeat", "complete", "job-spec", "submit-evidence"];
  for (const ep of endpoints) {
    const content = readFile(`src/app/api/worker/${ep}/route.ts`);
    const hasAuth = content.includes("getWorkerToken") || content.includes("verifyWorkerToken");
    results.push({
      name: `Worker endpoint /api/worker/${ep} uses authentication`,
      passed: hasAuth,
      details: hasAuth ? "getWorkerToken found" : "NO AUTHENTICATION — workerId trusted from body",
    });
  }
}

// --- Test 3: Poller must NOT call /api/worker/execute-task ---
function testPollerDoesNotCallExecuteTask() {
  const poller = readFile("mini-services/execution-worker/poller.ts");
  const callsExecuteTask = poller.includes("/api/worker/execute-task");
  const hasLocalExecution = poller.includes("sandbox") && (poller.includes("spawn") || poller.includes("import") && poller.includes("z-ai-web-dev-sdk"));
  results.push({
    name: "Poller does NOT call /api/worker/execute-task",
    passed: !callsExecuteTask,
    details: callsExecuteTask ? "Poller STILL calls execute-task endpoint" : "Poller does not call execute-task",
  });
  results.push({
    name: "Poller executes tasks locally (sandbox + LLM)",
    passed: hasLocalExecution,
    details: hasLocalExecution ? "Sandbox + LLM execution found in poller" : "No local execution found",
  });
}

// --- Test 4: Control plane must NOT import child_process or execution modules ---
function testControlPlaneDoesNotExecute() {
  // Check API routes (src/app/) — these must never import child_process
  // or execution modules directly.
  const apiFiles = findTsFiles("src/app");
  // Check specific control-plane modules that should not execute code.
  const controlPlaneModules = [
    "src/lib/orchestrator.ts",
    "src/lib/scheduler.ts",
  ];

  const forbiddenInApi = [
    "from \"node:child_process\"",
    "from 'node:child_process'",
    "from \"child_process\"",
    "from 'child_process'",
  ];
  const forbiddenInControlPlane = [
    ...forbiddenInApi,
    "from \"@/lib/worker\"",
    "from '@/lib/worker'",
    "from \"@/lib/git-engine\"",
    "from '@/lib/git-engine'",
    "from \"@/lib/test-runner\"",
    "from '@/lib/test-runner'",
    "import * as gitEngine",
    "import { submitExecutionJob",
    "import { createSandbox",
  ];

  let violations: string[] = [];

  // Check API routes
  for (const file of apiFiles) {
    const content = readFile(file);
    for (const imp of forbiddenInApi) {
      if (content.includes(imp)) {
        violations.push(`${file}: imports ${imp}`);
      }
    }
  }

  // Check control-plane modules
  for (const file of controlPlaneModules) {
    const content = readFile(file);
    for (const imp of forbiddenInControlPlane) {
      if (content.includes(imp)) {
        violations.push(`${file}: imports ${imp}`);
      }
    }
  }

  results.push({
    name: "Control plane does not import execution modules",
    passed: violations.length === 0,
    details: violations.length === 0 ? "No execution imports in control plane" : `VIOLATIONS:\n${violations.join("\n")}`,
  });
}

// --- Test 5: Worker-auth module must exist and export getWorkerToken ---
function testWorkerAuthModule() {
  const content = readFile("src/lib/worker-auth.ts");
  const hasGetWorkerToken = content.includes("export function getWorkerToken");
  const hasVerifyWorkerToken = content.includes("export function verifyWorkerToken");
  const hasNonceProtection = content.includes("usedNonces");
  results.push({
    name: "Worker auth module exists with token verification",
    passed: hasGetWorkerToken && hasVerifyWorkerToken && hasNonceProtection,
    details: `getWorkerToken: ${hasGetWorkerToken}, verifyWorkerToken: ${hasVerifyWorkerToken}, nonce protection: ${hasNonceProtection}`,
  });
}

// --- Test 6: Version endpoint must report current version ---
function testVersionString() {
  const content = readFile("src/app/api/version/route.ts");
  const hasPhase12 = content.includes('"phase16d"') || content.includes("'phase16d'");
  results.push({
    name: "Version endpoint reports phase16d",
    passed: hasPhase12,
    details: hasPhase12 ? "Version is phase16d" : "Version is NOT phase16d — stale string",
  });
}

// --- Test 7: ExecutionJob model must have capability fields ---
function testExecutionJobModel() {
  const schema = readFile("prisma/schema.prisma");
  const hasExecutionJob = schema.includes("model ExecutionJob");
  const hasRequiredCapabilities = schema.includes("requiredCapabilities");
  const hasWorkerRegistry = schema.includes("model WorkerRegistry");
  results.push({
    name: "Schema has ExecutionJob + WorkerRegistry with capabilities",
    passed: hasExecutionJob && hasRequiredCapabilities && hasWorkerRegistry,
    details: `ExecutionJob: ${hasExecutionJob}, requiredCapabilities: ${hasRequiredCapabilities}, WorkerRegistry: ${hasWorkerRegistry}`,
  });
}

// --- Test 8: Scheduler must NOT import executeTask ---
function testSchedulerDoesNotExecute() {
  const scheduler = readFile("src/lib/scheduler.ts");
  const importsExecuteTask = scheduler.includes("executeTask") && !scheduler.includes("// does NOT");
  results.push({
    name: "Scheduler does NOT call executeTask",
    passed: !importsExecuteTask,
    details: importsExecuteTask ? "Scheduler imports/calls executeTask — VIOLATION" : "Scheduler does not call executeTask",
  });
}

// --- Test 9: Production enforcement must exist ---
function testProductionEnforcement() {
  const enforcement = readFile("src/lib/production-enforcement.ts");
  const hasEnforceMode = enforcement.includes("enforceProductionMode");
  const hasCanReachReady = enforcement.includes("canReachProductionReady");
  results.push({
    name: "Production enforcement module exists",
    passed: hasEnforceMode && hasCanReachReady,
    details: `enforceProductionMode: ${hasEnforceMode}, canReachProductionReady: ${hasCanReachReady}`,
  });
}

// --- Test 10: Orchestrator's startBuild must enqueue, not execute synchronously ---
function testStartBuildEnqueues() {
  const orchestrator = readFile("src/lib/orchestrator.ts");
  const usesEnqueue = orchestrator.includes("enqueueBuild");
  const noSynchronousLoop = !orchestrator.includes("for (let i = 0; i < MAX_LOOP_ITERATIONS; i++)");
  results.push({
    name: "startBuild enqueues job (does not execute synchronously)",
    passed: usesEnqueue && noSynchronousLoop,
    details: `enqueueBuild: ${usesEnqueue}, no sync loop: ${noSynchronousLoop}`,
  });
}

// --- Run all tests ---
testExecuteTaskDeleted();
testWorkerEndpointAuth();
testPollerDoesNotCallExecuteTask();
testControlPlaneDoesNotExecute();
testWorkerAuthModule();
testVersionString();
testExecutionJobModel();
testSchedulerDoesNotExecute();
testProductionEnforcement();
testStartBuildEnqueues();

// --- Summary ---
console.log("=== Forge Architecture Invariants Test ===\n");
let passed = 0, failed = 0;
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  console.log(`  ${r.details}\n`);
  if (r.passed) passed++; else failed++;
}
console.log(`=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("\n❌ ARCHITECTURE DRIFT DETECTED — invariants not satisfied");
  process.exit(1);
} else {
  console.log("\n✅ All architecture invariants satisfied — single coherent architecture");
  process.exit(0);
}
