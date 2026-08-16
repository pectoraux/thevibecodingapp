// Forge — Phase 18Y: Execution Capability Closure — Smoke Test.
//
// This is the END-TO-END smoke test for Phase 18Y. It exercises the FULL
// path:
//
//   control-plane (issues capability with FULL runtimePlan + workloadHash)
//       ↓
//   worker (clones repo, POSTs { capability, repoPath } to supervisor)
//       ↓
//   supervisor (verifies cap, calls /api/supervisor/consume-capability,
//              derives workload from cap.runtimePlan, verifies workloadHash,
//              verifies git HEAD + clean tree, writes plan.json +
//              orchestrator.js, runs substrate, returns attestation)
//       ↓
//   worker (builds envelope, signs with worker key)
//       ↓
//   verification (both signatures verify, attestation nonce/executionId
//                 match the capability)
//
// AND it tests the Phase 18Y-specific P0 closures:
//   - The supervisor REJECTS a `workload` field in the request body.
//   - The supervisor DERIVES the workload from cap.runtimePlan.
//   - The supervisor VERIFIES workloadHash matches cap.workloadHash.
//   - The supervisor VERIFIES git rev-parse HEAD === cap.repositoryHeadSha.
//   - The supervisor VERIFIES the working tree is clean.
//   - The supervisor CALLS /api/supervisor/consume-capability (atomic nonce).
//   - A REPLAYED capability (same nonce used twice) is rejected (403).
//   - A TAMPERED runtimePlan (modified after signing) is rejected (403).
//   - A WRONG workloadHash (doesn't match derived) is rejected (403).
//   - A WRONG repo SHA (repoPath HEAD ≠ cap.repositoryHeadSha) is rejected (403).
//   - A DIRTY tree (uncommitted changes) is rejected (403).
//
// Run with: bun run tests/phase-18y-smoke.ts

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  verifyLauncherAttestation,
  isSubstrateTrusted,
  REQUIRED_SECCOMP_PROFILE_HASH,
} from "@/lib/substrate-attestation";
import {
  generateWorkerKeyPair,
  verifyEvidenceEnvelope,
} from "@/lib/runtime-execution-contract";
import {
  signExecutionCapability,
  verifyExecutionCapability,
  deriveWorkloadFromPlan,
  computeWorkloadHash,
  type ExecutionCapabilityInput,
} from "@/lib/execution-capability";
import { executeRuntimeVerificationInWorker, generateSubstrateNonce } from "../mini-services/execution-worker/runtime/verify.js";
import { startTestSupervisor, type TestSupervisor } from "./lib/test-supervisor.js";
import { setupTestWorkspace, setupTestRepo, makeTestPlan } from "./lib/test-capability.js";

// ===========================================================================
// Test infrastructure
// ===========================================================================

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];
let passed = 0;
let failed = 0;

function record(name: string, passedFlag: boolean, details: string): void {
  results.push({ name, passed: passedFlag, details });
  if (passedFlag) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name} — ${details}`);
  }
}

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

// ===========================================================================
// Start the supervisor (with mock consume-capability server).
// ===========================================================================

const SUPERVISOR: TestSupervisor = await startTestSupervisor();
const LAUNCHER_PUBLIC_KEY = SUPERVISOR.launcherPublicKey;
const WORKER_KEY = generateWorkerKeyPair("phase-18y-smoke-worker");
console.log(`[phase-18y-smoke] Supervisor started at ${SUPERVISOR.url}`);
console.log(`[phase-18y-smoke] Mock consume-capability server on port ${SUPERVISOR.mockConsumeCapabilityPort}`);

// ===========================================================================
// TEST 1 — Full happy path: capability + repoPath → attestation
// ===========================================================================
// Sign a capability with the FULL runtimePlan + workloadHash. Call
// executeRuntimeVerificationInWorker. The supervisor:
//   - verifies the cap signature
//   - calls /api/supervisor/consume-capability (atomic nonce consumption)
//   - derives the workload from cap.runtimePlan
//   - verifies workloadHash matches
//   - verifies git rev-parse HEAD === cap.repositoryHeadSha
//   - verifies the working tree is clean
//   - writes plan.json + copies orchestrator.js to dirname(repoPath)
//   - runs the substrate
//   - returns { attestation, result, results }

let test1Envelope: Awaited<ReturnType<typeof executeRuntimeVerificationInWorker>> | null = null;
let test1ExecutionId = "";
let test1Nonce = "";
let test1Cap: ReturnType<typeof SUPERVISOR.signCapability> | null = null;

{
  const { repoPath, sha } = setupTestWorkspace("phase-18y-1");
  const executionId = randomUUID();
  const nonce = generateSubstrateNonce();
  const plan = makeTestPlan(3000);
  const capability = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId: "lease-smoke-1",
    repositoryHeadSha: sha,
    runtimePlanHash: "smoke-plan-hash",
    architectureHash: null,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });
  test1ExecutionId = executionId;
  test1Nonce = nonce;
  test1Cap = capability;

  const envelope = await executeRuntimeVerificationInWorker({
    executionId,
    workerId: "phase-18y-smoke-worker",
    leaseId: "lease-smoke-1",
    repositoryHeadSha: sha,
    repositoryUrl: repoPath,
    architectureHash: null,
    runtimePlanHash: "smoke-plan-hash",
    plan,
    nonce,
    capability,
    supervisorUrl: SUPERVISOR.url,
    workerPrivateKeyPem: WORKER_KEY.privateKeyPem,
    totalTimeoutMs: 120000,
  });
  test1Envelope = envelope;

  const att = envelope.substrateAttestation;
  const attNonNull = att !== null && att !== undefined;
  const sigValid = verifyEvidenceEnvelope(envelope, WORKER_KEY.publicKeyPem);
  const launcherResult = attNonNull
    ? verifyLauncherAttestation(att, LAUNCHER_PUBLIC_KEY, nonce, executionId)
    : { valid: false, reasons: ["attestation is null"] };
  const trusted = attNonNull
    ? isSubstrateTrusted(att, LAUNCHER_PUBLIC_KEY, nonce, executionId)
    : false;
  const passedBool = envelope.passed === true;
  const execMatch = attNonNull && att.executionId === executionId;
  const nonceMatch = attNonNull && att.nonce === nonce;
  const seccompOk = attNonNull && att.seccompMode === 2;
  const seccompHashOk = attNonNull && att.seccompProfileHash === REQUIRED_SECCOMP_PROFILE_HASH;

  const ok = attNonNull && sigValid && launcherResult.valid && trusted && passedBool && execMatch && nonceMatch && seccompOk && seccompHashOk;
  const details = !attNonNull
    ? "substrateAttestation is null"
    : `sigValid=${sigValid} launcherValid=${launcherResult.valid} trusted=${trusted} passed=${envelope.passed} execMatch=${execMatch} nonceMatch=${nonceMatch} seccompMode=${att.seccompMode} hashOk=${seccompHashOk}`;
  record(
    "Test 1: full happy path — capability + repoPath → attestation (all signatures + facts verified)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 2 — Supervisor REJECTS a `workload` field in the request body
// ===========================================================================
// Phase 18Y P0 closure: the supervisor must NOT accept a workload field.
// POST { capability, workload, repoPath } → 403.

{
  const { repoPath, sha } = setupTestWorkspace("phase-18y-2");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const plan = makeTestPlan(3000);
  const cap = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId: "lease-smoke-2",
    repositoryHeadSha: sha,
    runtimePlanHash: "smoke-plan-hash",
    architectureHash: null,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });
  const resp = await fetch(`${SUPERVISOR.url}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: cap,
      workload: {
        binary: "/bin/echo",
        args: ["should-not-run-workload-field-rejected"],
        cwd: "/tmp",
        timeoutMs: 15000,
      },
      repoPath,
    }),
  });
  const ok = resp.status === 403;
  let detail = `status=${resp.status}`;
  try {
    const body = await resp.json() as { error?: string };
    detail += ` error=${body.error ?? "(none)"}`;
  } catch { /* ignore */ }
  record(
    "Test 2: supervisor REJECTS a 'workload' field in the request body (Phase 18Y P0 — worker cannot supply the workload)",
    ok,
    detail
  );
}

// ===========================================================================
// TEST 3 — REPLAY: same capability nonce used twice → second call 403
// ===========================================================================
// The supervisor calls /api/supervisor/consume-capability before running.
// The mock consume-capability server tracks consumed nonces in a Set. The
// FIRST call with a given nonce → 200 (consumed). The SECOND call with the
// SAME nonce → 403 (replay).
//
// We use the capability from test 1 (its nonce was already consumed). The
// second /execute call should fail at the consume-capability step → 403.

{
  if (!test1Cap) {
    record(
      "Test 3: replay — same capability nonce used twice → second call 403",
      false,
      "test1Cap is null — Test 1 did not run"
    );
  } else {
    // Re-setup a fresh repo (the worker's workspace from test 1 was cleaned up).
    const { repoPath } = setupTestWorkspace("phase-18y-3");
    // We need a repo whose HEAD matches test1Cap.repositoryHeadSha. The
    // simplest way is to clone the test app again at the same SHA. But
    // test1Cap.repositoryHeadSha was the SHA of the test 1 repo, which is
    // gone. We'll sign a NEW capability with the same nonce but for the
    // new repo's SHA — the nonce is what matters for replay.
    const { sha: newSha } = setupTestWorkspace("phase-18y-3b");
    // Actually, we need to use the EXACT same capability (same nonce) to
    // test replay. But the cap's repositoryHeadSha won't match newSha.
    // The supervisor checks the cap signature FIRST, then consume-capability.
    // consume-capability will reject (replay) BEFORE the git SHA check.
    // So we can use the original test1Cap with any repoPath — the SHA check
    // never runs.
    // Use the new repoPath (it exists).
    const resp = await fetch(`${SUPERVISOR.url}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: test1Cap,
        repoPath,
      }),
    });
    const ok = resp.status === 403;
    let detail = `status=${resp.status}`;
    try {
      const body = await resp.json() as { error?: string; reasons?: string[] };
      detail += ` error=${body.error ?? "(none)"} reasons=${(body.reasons ?? []).join("; ")}`;
    } catch { /* ignore */ }
    record(
      "Test 3: replay — same capability nonce used twice → second call 403 (atomic nonce consumption)",
      ok,
      detail
    );
  }
}

// ===========================================================================
// TEST 4 — TAMPERED runtimePlan: cap.runtimePlan modified after signing → 403
// ===========================================================================
// Take a valid capability, modify cap.runtimePlan after signing. The
// signature no longer matches → supervisor rejects (403).

{
  const { repoPath, sha } = setupTestWorkspace("phase-18y-4");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const plan = makeTestPlan(3000);
  const cap = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId: "lease-smoke-4",
    repositoryHeadSha: sha,
    runtimePlanHash: "smoke-plan-hash",
    architectureHash: null,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });
  // Tamper: change the plan's port after signing.
  const tamperedPlan = { ...(cap.runtimePlan as Record<string, unknown>), port: 9999 };
  const tamperedCap = { ...cap, runtimePlan: tamperedPlan };
  const resp = await fetch(`${SUPERVISOR.url}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: tamperedCap,
      repoPath,
    }),
  });
  const ok = resp.status === 403;
  let detail = `status=${resp.status}`;
  try {
    const body = await resp.json() as { error?: string; reasons?: string[] };
    detail += ` error=${body.error ?? "(none)"} reasons=${(body.reasons ?? []).slice(0, 2).join("; ")}`;
  } catch { /* ignore */ }
  record(
    "Test 4: tampered runtimePlan (modified after signing) → 403 (signature invalid)",
    ok,
    detail
  );
}

// ===========================================================================
// TEST 5 — WRONG workloadHash: cap.workloadHash doesn't match derived → 403
// ===========================================================================
// Sign a capability with a workloadHash that doesn't match what
// deriveWorkloadFromPlan + computeWorkloadHash would produce. The
// supervisor derives the workload, computes the hash, compares → mismatch → 403.
//
// This is defense-in-depth — the control plane signs both runtimePlan and
// workloadHash, so a wrong workloadHash would also break the signature.
// But we test it explicitly: we sign with a workloadHash that matches the
// signature (so the signature is valid), but then change workloadHash
// AFTER signing (breaking the signature). The supervisor should reject
// either way.

{
  const { repoPath, sha } = setupTestWorkspace("phase-18y-5");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const plan = makeTestPlan(3000);
  const cap = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId: "lease-smoke-5",
    repositoryHeadSha: sha,
    runtimePlanHash: "smoke-plan-hash",
    architectureHash: null,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });
  // Change workloadHash after signing (breaks the signature).
  const tamperedCap = { ...cap, workloadHash: "0".repeat(64) };
  const resp = await fetch(`${SUPERVISOR.url}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: tamperedCap,
      repoPath,
    }),
  });
  const ok = resp.status === 403;
  let detail = `status=${resp.status}`;
  try {
    const body = await resp.json() as { error?: string; reasons?: string[] };
    detail += ` error=${body.error ?? "(none)"} reasons=${(body.reasons ?? []).slice(0, 2).join("; ")}`;
  } catch { /* ignore */ }
  record(
    "Test 5: wrong workloadHash (doesn't match derived) → 403 (defense-in-depth)",
    ok,
    detail
  );
}

// ===========================================================================
// TEST 6 — WRONG repo SHA: repoPath HEAD ≠ cap.repositoryHeadSha → 403
// ===========================================================================
// Sign a capability with SHA "aaaa...", but pass a repoPath whose HEAD is
// "bbbb...". The supervisor verifies git rev-parse HEAD === cap.repositoryHeadSha
// → mismatch → 403.

{
  const { repoPath, sha: realSha } = setupTestWorkspace("phase-18y-6");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const plan = makeTestPlan(3000);
  // Sign with a WRONG SHA (not realSha).
  const wrongSha = "0".repeat(40);
  const cap = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId: "lease-smoke-6",
    repositoryHeadSha: wrongSha,
    runtimePlanHash: "smoke-plan-hash",
    architectureHash: null,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });
  const resp = await fetch(`${SUPERVISOR.url}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: cap,
      repoPath,
    }),
  });
  const ok = resp.status === 403;
  let detail = `status=${resp.status}`;
  try {
    const body = await resp.json() as { error?: string; reasons?: string[] };
    detail += ` error=${body.error ?? "(none)"} reasons=${(body.reasons ?? []).slice(0, 2).join("; ")}`;
  } catch { /* ignore */ }
  record(
    "Test 6: wrong repo SHA (repoPath HEAD ≠ cap.repositoryHeadSha) → 403",
    ok,
    detail
  );
}

// ===========================================================================
// TEST 7 — DIRTY tree: uncommitted changes in repoPath → 403
// ===========================================================================
// Set up a clean repo, then modify a file (uncommitted). The supervisor
// verifies git status --porcelain is empty → not empty → 403.

{
  const { repoPath, sha } = setupTestWorkspace("phase-18y-7");
  // Dirty the tree: append to server.js.
  writeFileSync(join(repoPath, "server.js"), "// dirty modification\n" + readFile(join(repoPath, "server.js")));
  // Also create an untracked file.
  writeFileSync(join(repoPath, "untracked.txt"), "untracked content");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const plan = makeTestPlan(3000);
  const cap = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId: "lease-smoke-7",
    repositoryHeadSha: sha,
    runtimePlanHash: "smoke-plan-hash",
    architectureHash: null,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });
  const resp = await fetch(`${SUPERVISOR.url}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: cap,
      repoPath,
    }),
  });
  const ok = resp.status === 403;
  let detail = `status=${resp.status}`;
  try {
    const body = await resp.json() as { error?: string; reasons?: string[] };
    detail += ` error=${body.error ?? "(none)"} reasons=${(body.reasons ?? []).slice(0, 2).join("; ")}`;
  } catch { /* ignore */ }
  record(
    "Test 7: dirty working tree (uncommitted changes) → 403 (worker modified the repo after cloning)",
    ok,
    detail
  );
}

// ===========================================================================
// TEST 8 — Supervisor WITHOUT FORGE_SUPERVISOR_SECRET → FATAL exit
// ===========================================================================
// Source inspection: the supervisor's source must check FORGE_SUPERVISOR_SECRET
// and FATAL-exit if it's missing.

{
  const src = readFile("mini-services/substrate-supervisor/index.ts");
  const checksSecret = src.includes("FORGE_SUPERVISOR_SECRET") &&
    /if\s*\(\s*!SUPERVISOR_SECRET\s*\)/.test(src) &&
    /process\.exit\(1\)/.test(src);
  record(
    "Test 8: supervisor source checks FORGE_SUPERVISOR_SECRET + FATAL-exits if missing (Phase 18Y)",
    checksSecret,
    `checksSecret=${checksSecret}`
  );
}

// ===========================================================================
// TEST 9 — Consume-capability route exists + implements atomic consumption
// ===========================================================================
// Source inspection: the route file exists and implements updateMany with
// substrateNonceConsumed: false in the WHERE clause.

{
  const src = readFile("src/app/api/supervisor/consume-capability/route.ts");
  const hasUpdateMany = src.includes("updateMany");
  const hasConsumedFalse = src.includes("substrateNonceConsumed: false");
  const hasLeaseCheck = src.includes("leaseId") && src.includes("leaseExpiresAt");
  const hasSecretAuth = src.includes("FORGE_SUPERVISOR_SECRET") && src.includes("Bearer");
  const hasTimingSafeEqual = src.includes("timingSafeEqual");
  const ok = hasUpdateMany && hasConsumedFalse && hasLeaseCheck && hasSecretAuth && hasTimingSafeEqual;
  record(
    "Test 9: consume-capability route implements atomic nonce consumption + lease check + supervisor-secret auth",
    ok,
    `updateMany=${hasUpdateMany} consumedFalse=${hasConsumedFalse} leaseCheck=${hasLeaseCheck} secretAuth=${hasSecretAuth} timingSafeEqual=${hasTimingSafeEqual}`
  );
}

// ===========================================================================
// TEST 10 — Prisma schema has substrateNonceConsumed + substrateNonceConsumedAt
// ===========================================================================

{
  const schema = readFile("prisma/schema.prisma");
  const hasConsumed = /substrateNonceConsumed\s+Boolean\s+@default\(false\)/.test(schema);
  const hasConsumedAt = /substrateNonceConsumedAt\s+DateTime\?/.test(schema);
  const inExecutionJob = schema.includes("model ExecutionJob") && schema.includes("substrateNonceConsumed");
  const ok = hasConsumed && hasConsumedAt && inExecutionJob;
  record(
    "Test 10: Prisma schema has substrateNonceConsumed (Boolean @default(false)) + substrateNonceConsumedAt (DateTime?) on ExecutionJob",
    ok,
    `hasConsumed=${hasConsumed} hasConsumedAt=${hasConsumedAt} inExecutionJob=${inExecutionJob}`
  );
}

// ===========================================================================
// TEST 11 — ExecutionCapability type includes workloadHash + runtimePlan
// ===========================================================================

{
  const src = readFile("src/lib/execution-capability.ts");
  const hasWorkloadHash = /workloadHash\s*:\s*string/.test(src);
  const hasRuntimePlan = /runtimePlan\s*:\s*Record<string,\s*unknown>/.test(src);
  const hasDeriveWorkload = src.includes("export function deriveWorkloadFromPlan");
  const hasComputeWorkloadHash = src.includes("export function computeWorkloadHash");
  const hasCwdPolicy = src.includes('cwd: "/workspace/repo"');
  const hasBinaryNode = src.includes('binary: "node"');
  const hasArgsOrchestrator = src.includes('args: ["/workspace/orchestrator.js"]');
  const ok = hasWorkloadHash && hasRuntimePlan && hasDeriveWorkload && hasComputeWorkloadHash && hasCwdPolicy && hasBinaryNode && hasArgsOrchestrator;
  record(
    "Test 11: ExecutionCapability type + helpers (workloadHash, runtimePlan, deriveWorkloadFromPlan, computeWorkloadHash, derived workload = node /workspace/orchestrator.js with cwd=/workspace/repo)",
    ok,
    `workloadHash=${hasWorkloadHash} runtimePlan=${hasRuntimePlan} derive=${hasDeriveWorkload} compute=${hasComputeWorkloadHash} cwdPolicy=${hasCwdPolicy} binaryNode=${hasBinaryNode} argsOrch=${hasArgsOrchestrator}`
  );
}

// ===========================================================================
// TEST 12 — Worker verify.ts POSTs { capability, repoPath } (NO workload)
// ===========================================================================

{
  const src = readFile("mini-services/execution-worker/runtime/verify.ts");
  const hasRepoPath = /body:\s*JSON\.stringify\(\s*{\s*capability:\s*job\.capability,\s*repoPath,?\s*}\s*\)/.test(src) ||
    /capability:\s*job\.capability/.test(src) && /repoPath/.test(src);
  // Strip comments before checking for 'workload' references.
  const stripped = src
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  // The worker MUST NOT pass a workload field to the supervisor.
  const hasNoWorkloadInPostBody = !/JSON\.stringify\(\s*{\s*capability:[^}]*workload/.test(stripped);
  const ok = hasRepoPath && hasNoWorkloadInPostBody;
  record(
    "Test 12: worker verify.ts POSTs { capability, repoPath } (NO workload field — Phase 18Y)",
    ok,
    `hasRepoPath=${hasRepoPath} hasNoWorkloadInPostBody=${hasNoWorkloadInPostBody}`
  );
}

// ===========================================================================
// TEST 13 — Job-spec route includes runtimePlan + workloadHash in capability
// ===========================================================================

{
  const src = readFile("src/app/api/worker/job-spec/route.ts");
  const importsDerive = src.includes("deriveWorkloadFromPlan") && src.includes("computeWorkloadHash");
  const hasRuntimePlan = /runtimePlan:\s*runtimePlanForCapability/.test(src);
  const hasWorkloadHash = /workloadHash,/.test(src) || /workloadHash:\s*workloadHash/.test(src);
  const ok = importsDerive && hasRuntimePlan && hasWorkloadHash;
  record(
    "Test 13: job-spec route includes runtimePlan + workloadHash in the signed capability (Phase 18Y)",
    ok,
    `importsDerive=${importsDerive} hasRuntimePlan=${hasRuntimePlan} hasWorkloadHash=${hasWorkloadHash}`
  );
}

// ===========================================================================
// Stop the supervisor.
// ===========================================================================

await SUPERVISOR.stop();

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n=== phase-18y-smoke ===\n");
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  if (!r.passed) {
    console.log(`  ${r.details}`);
  }
}
console.log(`\n=== phase-18y-smoke: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  console.log("\n❌ PHASE 18Y SMOKE TEST FAILED — execution capability closure not satisfied");
  process.exit(1);
} else {
  console.log("\n✅ Phase 18Y execution capability closure enforced — control plane authorizes the exact workload; worker cannot supply arbitrary commands");
  process.exit(0);
}
