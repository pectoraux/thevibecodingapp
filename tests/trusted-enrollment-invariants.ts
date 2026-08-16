// Forge — Phase 18Q: Trusted Worker Enrollment
//
// Verifies:
//   1. WorkerEnrollment model exists in schema
//   2. Admin enrollment endpoint exists
//   3. Register endpoint requires enrollment proof (not just HMAC)
//   4. Register endpoint verifies enrollment secret
//   5. Register endpoint verifies public key fingerprint
//   6. Register endpoint verifies Ed25519 enrollment signature
//   7. Enrollment is single-use (PENDING → ACTIVE)
//   8. Worker signs enrollment challenge with Ed25519
//
// Run with: bun run tests/trusted-enrollment-invariants.ts

import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as cryptoSign, createHash, verify as cryptoVerify } from "node:crypto";

interface TestResult { name: string; passed: boolean; details: string; }
const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function record(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
}

const schema = readFile("prisma/schema.prisma");
const enrollRoute = readFile("src/app/api/admin/enroll-worker/route.ts");
const registerRoute = readFile("src/app/api/worker/register/route.ts");
const poller = readFile("mini-services/execution-worker/poller.ts");

// Test 1: WorkerEnrollment model exists.
{
  const hasModel = schema.includes("model WorkerEnrollment");
  record("WorkerEnrollment model exists in Prisma schema", hasModel, `hasModel: ${hasModel}`);
}

// Test 2: Enrollment has expectedPublicKeyFingerprint.
{
  const hasField = schema.includes("expectedPublicKeyFingerprint");
  record("WorkerEnrollment has expectedPublicKeyFingerprint", hasField, `hasField: ${hasField}`);
}

// Test 3: Enrollment has enrollmentSecretHash.
{
  const hasField = schema.includes("enrollmentSecretHash");
  record("WorkerEnrollment has enrollmentSecretHash (bcrypt-hashed)", hasField, `hasField: ${hasField}`);
}

// Test 4: Enrollment has status PENDING/ACTIVE.
{
  const hasStatus = schema.includes("PENDING") && schema.includes("ACTIVE");
  record("WorkerEnrollment has status PENDING/ACTIVE", hasStatus, `hasStatus: ${hasStatus}`);
}

// Test 5: Admin enrollment endpoint exists.
{
  const exists = enrollRoute.length > 0;
  record("Admin enrollment endpoint /api/admin/enroll-worker exists", exists, `exists: ${exists}`);
}

// Test 6: Enrollment endpoint requires admin auth.
{
  const requiresAuth = enrollRoute.includes("requireUserId");
  record("Enrollment endpoint requires admin authentication", requiresAuth, `requiresAuth: ${requiresAuth}`);
}

// Test 7: Enrollment endpoint computes public key fingerprint.
{
  const computes = enrollRoute.includes("createHash") && enrollRoute.includes("fingerprint");
  record("Enrollment endpoint computes public key fingerprint", computes, `computes: ${computes}`);
}

// Test 8: Register endpoint requires enrollment proof for new workers.
{
  const requires = registerRoute.includes("publicKeyPem and enrollmentSignature");
  record("Register endpoint requires enrollment proof for new workers", requires, `requires: ${requires}`);
}

// Test 9: Register endpoint looks up pending enrollment.
{
  const looks = registerRoute.includes("db.workerEnrollment.findUnique");
  record("Register endpoint looks up pending enrollment", looks, `looks: ${looks}`);
}

// Test 10: Register endpoint verifies enrollment secret.
{
  const verifies = registerRoute.includes("bcrypt.compareSync") && registerRoute.includes("enrollmentSecret");
  record("Register endpoint verifies enrollment secret (bcrypt)", verifies, `verifies: ${verifies}`);
}

// Test 11: Register endpoint verifies public key fingerprint.
{
  const verifies = registerRoute.includes("fingerprint !== enrollment.expectedPublicKeyFingerprint");
  record("Register endpoint verifies public key fingerprint", verifies, `verifies: ${verifies}`);
}

// Test 12: Register endpoint verifies Ed25519 enrollment signature.
{
  const verifies = registerRoute.includes("cryptoVerify(null, challengeData, publicKeyPem, sigBuf)");
  record("Register endpoint verifies Ed25519 enrollment signature", verifies, `verifies: ${verifies}`);
}

// Test 13: Enrollment is single-use (marked ACTIVE after registration).
{
  const marks = registerRoute.includes('status: "ACTIVE"');
  record("Enrollment marked ACTIVE after registration (single-use)", marks, `marks: ${marks}`);
}

// Test 14: Register endpoint rejects non-PENDING enrollment.
{
  const rejects = registerRoute.includes("not PENDING");
  record("Register endpoint rejects non-PENDING enrollment", rejects, `rejects: ${rejects}`);
}

// Test 15: Worker signs enrollment challenge.
{
  const signs = poller.includes("FORGE_ENROLLMENT:") && poller.includes("enrollmentSignature");
  record("Worker signs enrollment challenge with Ed25519", signs, `signs: ${signs}`);
}

// Test 16: Worker reads enrollment secret from env.
{
  const reads = poller.includes("FORGE_WORKER_ENROLLMENT_SECRET");
  record("Worker reads enrollment secret from FORGE_WORKER_ENROLLMENT_SECRET env", reads, `reads: ${reads}`);
}

// Test 17: Integration — enrollment signing + verification round-trip.
{
  const keyPair = generateKeyPairSync("ed25519");
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

  const workerId = "test-worker";
  const enrollmentSecret = "test-secret-123";
  const challenge = `FORGE_ENROLLMENT:${workerId}:${enrollmentSecret}`;
  const signature = cryptoSign(null, Buffer.from(challenge, "utf-8"), privateKeyPem).toString("hex");

  // Verify with the public key.
  const sigBuf = Buffer.from(signature, "hex");
  const challengeData = Buffer.from(challenge, "utf-8");
  const valid = cryptoVerify(null, challengeData, publicKeyPem, sigBuf);

  record("Enrollment signing + verification round-trip works", valid, `valid: ${valid}`);
}

// Test 18: Different enrollment secret produces different signature.
{
  const keyPair = generateKeyPairSync("ed25519");
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const challenge1 = `FORGE_ENROLLMENT:worker:secret-A`;
  const challenge2 = `FORGE_ENROLLMENT:worker:secret-B`;
  const sig1 = cryptoSign(null, Buffer.from(challenge1, "utf-8"), privateKeyPem).toString("hex");
  const sig2 = cryptoSign(null, Buffer.from(challenge2, "utf-8"), privateKeyPem).toString("hex");

  record("Different enrollment secrets produce different signatures", sig1 !== sig2, `different: ${sig1 !== sig2}`);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18Q: Trusted Worker Enrollment ===\n");
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
  console.log("\n❌ TRUSTED ENROLLMENT NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Trusted enrollment verified — worker identity is pre-provisioned, not self-claimed");
  process.exit(0);
}
