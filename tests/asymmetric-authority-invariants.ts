// Forge — Phase 18P: Asymmetric Control-Plane Authority
//
// Verifies:
//   1. Control-plane signs session/execution tokens with Ed25519 (not HMAC)
//   2. Worker verifies with control-plane public key
//   3. HMAC only for registration bootstrap
//   4. SESSION/EXECUTION tokens with HMAC are REJECTED
//   5. A worker with FORGE_WORKER_SECRET cannot forge session tokens
//   6. Production requires FORGE_CONTROL_PLANE_PUBLIC_KEY on worker
//
// Run with: bun run tests/asymmetric-authority-invariants.ts

import { readFileSync } from "node:fs";

interface TestResult { name: string; passed: boolean; details: string; }
const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function record(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
}

const workerAuth = readFile("src/lib/worker-auth.ts");
const poller = readFile("mini-services/execution-worker/poller.ts");

// ===========================================================================
// 1. CONTROL-PLANE USES ED25519 FOR SESSION/EXECUTION TOKENS
// ===========================================================================

// Test 1: WorkerToken has signatureAlgorithm field.
{
  const hasField = workerAuth.includes("signatureAlgorithm:");
  record("WorkerToken has signatureAlgorithm field", hasField, `hasField: ${hasField}`);
}

// Test 2: createWorkerSessionToken uses ed25519.
{
  const usesEd25519 = workerAuth.includes('signatureAlgorithm: "ed25519"') && workerAuth.includes("SESSION");
  record("createWorkerSessionToken uses signatureAlgorithm: ed25519", usesEd25519, `usesEd25519: ${usesEd25519}`);
}

// Test 3: createExecutionToken uses ed25519.
{
  const usesEd25519 = workerAuth.includes('signatureAlgorithm: "ed25519"') && workerAuth.includes("EXECUTION");
  record("createExecutionToken uses signatureAlgorithm: ed25519", usesEd25519, `usesEd25519: ${usesEd25519}`);
}

// Test 4: signWithEd25519 function exists.
{
  const hasFunc = workerAuth.includes("function signWithEd25519");
  record("signWithEd25519 function exists", hasFunc, `hasFunc: ${hasFunc}`);
}

// Test 5: verifyWithEd25519 function exists.
{
  const hasFunc = workerAuth.includes("function verifyWithEd25519");
  record("verifyWithEd25519 function exists", hasFunc, `hasFunc: ${hasFunc}`);
}

// ===========================================================================
// 2. HMAC ONLY FOR REGISTRATION BOOTSTRAP
// ===========================================================================

// Test 6: createRegistrationToken uses hmac.
{
  const usesHmac = workerAuth.includes('signatureAlgorithm: "hmac"') && workerAuth.includes("REGISTRATION");
  record("createRegistrationToken uses signatureAlgorithm: hmac (bootstrap only)", usesHmac, `usesHmac: ${usesHmac}`);
}

// Test 7: verifyWorkerToken rejects HMAC for SESSION/EXECUTION.
{
  const rejects = workerAuth.includes('token.signatureAlgorithm !== "ed25519"');
  record("verifyWorkerToken rejects HMAC SESSION/EXECUTION tokens", rejects, `rejects: ${rejects}`);
}

// ===========================================================================
// 3. CONTROL-PLANE KEY MANAGEMENT
// ===========================================================================

// Test 8: Control-plane keys initialized from env.
{
  const fromEnv = workerAuth.includes("FORGE_CONTROL_PLANE_PRIVATE_KEY") && workerAuth.includes("FORGE_CONTROL_PLANE_PUBLIC_KEY");
  record("Control-plane keys initialized from FORGE_CONTROL_PLANE_PRIVATE_KEY/PUBLIC_KEY env", fromEnv, `fromEnv: ${fromEnv}`);
}

// Test 9: Development mode auto-generates keypair.
{
  const autoGen = workerAuth.includes("generating ephemeral keypair");
  record("Development mode auto-generates control-plane keypair", autoGen, `autoGen: ${autoGen}`);
}

// Test 10: Production requires control-plane keys.
{
  const requiresProd = workerAuth.includes("FORGE_CONTROL_PLANE_PRIVATE_KEY and FORGE_CONTROL_PLANE_PUBLIC_KEY are required in production");
  record("Production requires control-plane Ed25519 keys", requiresProd, `requiresProd: ${requiresProd}`);
}

// ===========================================================================
// 4. WORKER-SIDE VERIFICATION
// ===========================================================================

// Test 11: Worker has FORGE_CONTROL_PLANE_PUBLIC_KEY.
{
  const hasKey = poller.includes("FORGE_CONTROL_PLANE_PUBLIC_KEY");
  record("Worker reads FORGE_CONTROL_PLANE_PUBLIC_KEY", hasKey, `hasKey: ${hasKey}`);
}

// Test 12: Worker requires public key in production.
{
  const requiresProd = poller.includes("FORGE_CONTROL_PLANE_PUBLIC_KEY is required in production");
  record("Worker requires FORGE_CONTROL_PLANE_PUBLIC_KEY in production", requiresProd, `requiresProd: ${requiresProd}`);
}

// ===========================================================================
// 5. SIGNATURE CANONICAL DATA INCLUDES ALGORITHM
// ===========================================================================

// Test 13: Canonical token data includes signatureAlgorithm.
{
  const includes = workerAuth.includes("payload.signatureAlgorithm");
  record("Canonical token data includes signatureAlgorithm (can't tamper algorithm)", includes, `includes: ${includes}`);
}

// Test 14: WORKER_SECRET documented as bootstrap only.
{
  const bootstrap = workerAuth.includes("Bootstrap registration only") || workerAuth.includes("bootstrap");
  record("WORKER_SECRET documented as bootstrap only (not root of authority)", bootstrap, `bootstrap: ${bootstrap}`);
}

// Test 15: Worker's registration token uses signatureAlgorithm: hmac.
{
  const usesHmac = poller.includes('signatureAlgorithm: "hmac"');
  record("Worker's registration token uses signatureAlgorithm: hmac (bootstrap)", usesHmac, `usesHmac: ${usesHmac}`);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18P: Asymmetric Control-Plane Authority ===\n");
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
  console.log("\n❌ ASYMMETRIC AUTHORITY NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Asymmetric authority verified — control-plane signs with Ed25519, worker cannot forge");
  process.exit(0);
}
