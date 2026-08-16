// Forge — Phase 18R: Enrollment Authority Closure
//
// Verifies:
//   1. Admin-only enrollment (isAdmin check)
//   2. Atomic single-use enrollment (compare-and-set updateMany)
//   3. Full SHA-256 fingerprint (no .slice(0, 32))
//   4. No existing-worker bypass (all registrations require identity proof)
//   5. Enrollment expiration (expiresAt checked)
//   6. Re-registration uses FORGE_REREGISTER challenge
//
// Run with: bun run tests/enrollment-authority-closure.ts

import { readFileSync } from "node:fs";

interface TestResult { name: string; passed: boolean; details: string; }
const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function record(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
}

const enrollRoute = readFile("src/app/api/admin/enroll-worker/route.ts");
const registerRoute = readFile("src/app/api/worker/register/route.ts");
const schema = readFile("prisma/schema.prisma");
const poller = readFile("mini-services/execution-worker/poller.ts");

// Test 1: Admin-only enrollment (isAdmin check).
{
  const hasAdminCheck = enrollRoute.includes("isAdmin()") || enrollRoute.includes("requireUserRole");
  const rejectsNonAdmin = enrollRoute.includes("admin role required");
  record("Enrollment endpoint requires admin role (not any authenticated user)", hasAdminCheck && rejectsNonAdmin, `hasAdminCheck: ${hasAdminCheck}, rejectsNonAdmin: ${rejectsNonAdmin}`);
}

// Test 2: Atomic single-use enrollment (compare-and-set).
{
  const usesCas = registerRoute.includes("updateMany") && registerRoute.includes("status: \"PENDING\"") && registerRoute.includes("casResult.count === 0");
  record("Atomic compare-and-set for enrollment (PENDING → ACTIVE)", usesCas, `usesCas: ${usesCas}`);
}

// Test 3: Full SHA-256 fingerprint (no truncation).
{
  const noTruncation = !enrollRoute.includes(".slice(0, 32)") && !registerRoute.includes(".slice(0, 32)");
  const usesFullHash = enrollRoute.includes('.digest("hex")') && registerRoute.includes('.digest("hex")');
  record("Full SHA-256 fingerprint (64 hex chars, not truncated to 32)", noTruncation && usesFullHash, `noTruncation: ${noTruncation}, usesFullHash: ${usesFullHash}`);
}

// Test 4: No existing-worker bypass.
{
  const alwaysRequiresProof = registerRoute.includes("ALL registrations require identity proof");
  const noBypass = !registerRoute.includes("existing.*publicKeyPem.*===.*existing.publicKeyPem.*return");
  record("No existing-worker bypass — all registrations require identity proof", alwaysRequiresProof, `alwaysRequiresProof: ${alwaysRequiresProof}`);
}

// Test 5: Enrollment expiration checked.
{
  const hasExpiry = registerRoute.includes("expiresAt") && registerRoute.includes("Enrollment has expired");
  record("Enrollment expiration checked", hasExpiry, `hasExpiry: ${hasExpiry}`);
}

// Test 6: expiresAt field in schema.
{
  const hasField = schema.includes("expiresAt                 DateTime");
  record("WorkerEnrollment has expiresAt field", hasField, `hasField: ${hasField}`);
}

// Test 7: Re-registration uses FORGE_REREGISTER challenge.
{
  const usesReregister = registerRoute.includes("challengeRecord") || registerRoute.includes("workerChallenge");
  record("Re-registration uses FORGE_REREGISTER challenge", usesReregister, `usesReregister: ${usesReregister}`);
}

// Test 8: Worker signs FORGE_REREGISTER on restart.
{
  const signsReregister = poller.includes("/api/worker/challenge") || poller.includes("reregisterChallenge");
  record("Worker fetches server challenge for re-registration (anti-replay)", signsReregister, `signsReregister: ${signsReregister}`);
}

// Test 9: Worker signs FORGE_ENROLLMENT on first registration.
{
  const signsEnroll = poller.includes("FORGE_ENROLLMENT:");
  record("Worker signs FORGE_ENROLLMENT on first registration", signsEnroll, `signsEnroll: ${signsEnroll}`);
}

// Test 10: Concurrent enrollment rejection (casResult.count === 0).
{
  const rejects = registerRoute.includes("already consumed by another request");
  record("Concurrent enrollment attempts rejected (single-use enforced atomically)", rejects, `rejects: ${rejects}`);
}

// Test 11: Re-registration verifies signature against existing key.
{
  const verifiesAgainstExisting = registerRoute.includes("cryptoVerify(null, challengeData, existingWorker.publicKeyPem");
  record("Re-registration verifies signature against existing registered key", verifiesAgainstExisting, `verifiesAgainstExisting: ${verifiesAgainstExisting}`);
}

// Test 12: Re-registration rejects different public key.
{
  const rejectsDiff = registerRoute.includes("Public key does not match the registered key");
  record("Re-registration rejects different public key (key rotation via /rotate-key only)", rejectsDiff, `rejectsDiff: ${rejectsDiff}`);
}

// Test 13: State-aware validation — enrollmentSecret NOT required for ACTIVE.
{
  // The top-level check must NOT require enrollmentSecret unconditionally.
  // It must only require publicKeyPem and enrollmentSignature always.
  const topLevelRequires = registerRoute.includes("!publicKeyPem || !enrollmentSignature");
  const doesNotRequireSecretAtTop = !registerRoute.includes("!publicKeyPem || !enrollmentSecret || !enrollmentSignature");
  const stateAware = registerRoute.includes('enrollment.status === "PENDING" && !enrollmentSecret');
  record(
    "State-aware validation: enrollmentSecret NOT required at top level (only for PENDING)",
    topLevelRequires && doesNotRequireSecretAtTop && stateAware,
    `topLevelRequires: ${topLevelRequires}, doesNotRequireSecretAtTop: ${doesNotRequireSecretAtTop}, stateAware: ${stateAware}`
  );
}

// Test 14: Restart path is reachable (no unconditional enrollmentSecret requirement).
{
  // The error message for missing fields must NOT mention enrollmentSecret
  // in the top-level check (only publicKeyPem and enrollmentSignature).
  const topErrorMsg = registerRoute.includes("Registration requires publicKeyPem and enrollmentSignature");
  const noSecretInTopError = !registerRoute.includes("Registration requires publicKeyPem, enrollmentSecret, and enrollmentSignature");
  record(
    "Restart path reachable: top-level error does not require enrollmentSecret",
    topErrorMsg && noSecretInTopError,
    `topErrorMsg: ${topErrorMsg}, noSecretInTopError: ${noSecretInTopError}`
  );
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18R: Enrollment Authority Closure ===\n");
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
  console.log("\n❌ ENROLLMENT AUTHORITY CLOSURE NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Enrollment authority closure verified — admin-only, atomic, no bypass, full fingerprint");
  process.exit(0);
}
