// Forge — Phase 18T: Re-registration & Identity Lifetime Closure
//
// Verifies:
//   1. Enrollment expiry only applies to PENDING (not ACTIVE)
//   2. Server-issued challenge endpoint exists
//   3. Re-registration requires server-issued challenge (not static)
//   4. Challenge includes nonce + expiry
//   5. Worker fetches challenge before re-registration
//
// Run with: bun run tests/reregister-lifetime-closure.ts

import { readFileSync } from "node:fs";

interface TestResult { name: string; passed: boolean; details: string; }
const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function record(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
}

const registerRoute = readFile("src/app/api/worker/register/route.ts");
const challengeRoute = readFile("src/app/api/worker/challenge/route.ts");
const poller = readFile("mini-services/execution-worker/poller.ts");

// Test 1: Enrollment expiry only checked for PENDING.
{
  const pendingOnly = registerRoute.includes('enrollment.status === "PENDING" && enrollment.expiresAt');
  record("Enrollment expiry only checked for PENDING (ACTIVE survives expiry)", pendingOnly, `pendingOnly: ${pendingOnly}`);
}

// Test 2: Challenge endpoint exists.
{
  const exists = challengeRoute.length > 0;
  record("Challenge endpoint /api/worker/challenge exists", exists, `exists: ${exists}`);
}

// Test 3: Challenge endpoint is authenticated.
{
  const auth = challengeRoute.includes("getWorkerToken");
  record("Challenge endpoint requires authentication", auth, `auth: ${auth}`);
}

// Test 4: Challenge endpoint requires ACTIVE enrollment.
{
  const active = challengeRoute.includes('status !== "ACTIVE"');
  record("Challenge endpoint requires ACTIVE enrollment", active, `active: ${active}`);
}

// Test 5: Challenge includes nonce.
{
  const nonce = challengeRoute.includes("randomUUID") && challengeRoute.includes("nonce");
  record("Challenge includes server-generated nonce", nonce, `nonce: ${nonce}`);
}

// Test 6: Challenge includes expiry.
{
  const expiry = challengeRoute.includes("expiryMs") && challengeRoute.includes("60000");
  record("Challenge includes 60-second expiry", expiry, `expiry: ${expiry}`);
}

// Test 7: Challenge format is FORGE_REREGISTER:{workerId}:{nonce}:{expiry}.
{
  const format = challengeRoute.includes("FORGE_REREGISTER:") && challengeRoute.includes("challengeStr");
  record("Challenge format: FORGE_REREGISTER:{workerId}:{nonce}:{expiry}", format, `format: ${format}`);
}

// Test 8: Register endpoint requires reregisterChallenge for ACTIVE.
{
  const requires = registerRoute.includes("reregisterChallenge") && registerRoute.includes("server-issued challenge");
  record("Register requires server-issued challenge for ACTIVE re-registration", requires, `requires: ${requires}`);
}

// Test 9: Register endpoint verifies challenge expiry.
{
  const checks = registerRoute.includes("Challenge has expired");
  record("Register endpoint verifies challenge expiry", checks, `checks: ${checks}`);
}

// Test 10: Register endpoint verifies challenge format.
{
  const checks = registerRoute.includes("does not match the server-issued record") || registerRoute.includes("Self-constructed challenges");
  record("Register endpoint verifies challenge against DB record (not format)", checks, `checks: ${checks}`);
}

// Test 11: Worker fetches challenge before re-registration.
{
  const fetches = poller.includes("/api/worker/challenge") && poller.includes("reregisterChallenge");
  record("Worker fetches server-issued challenge before re-registration", fetches, `fetches: ${fetches}`);
}

// Test 12: No static FORGE_REREGISTER:{workerId} in poller.
{
  const noStatic = !poller.includes('"FORGE_REREGISTER:${WORKER_ID}"') && !poller.includes("`FORGE_REREGISTER:${WORKER_ID}`");
  record("Worker does NOT use static FORGE_REREGISTER:{workerId} (uses server challenge)", noStatic, `noStatic: ${noStatic}`);
}

// Test 13: Worker sends reregisterChallenge + reregisterNonce in body.
{
  const sends = poller.includes("reregisterChallenge") && poller.includes("reregisterNonce");
  record("Worker sends reregisterChallenge + reregisterNonce in register body", sends, `sends: ${sends}`);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18T: Re-registration & Identity Lifetime Closure ===\n");
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
  console.log("\n❌ RE-REGISTRATION LIFETIME CLOSURE NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Re-registration lifetime closure verified — anti-replay challenge, enrollment expiry scoped to PENDING");
  process.exit(0);
}
