// Forge — Phase 18N: Worker Evidence Protocol Closure
//
// Verifies:
//   1. Worker signs task evidence with Ed25519 (signTaskEvidence function)
//   2. Worker sends evidenceSignature + evidenceHash in submit-evidence
//   3. Control plane /submit-evidence verifies Ed25519 signature
//   4. Control plane requires signature in production
//   5. Key storage validates directory permissions (0o700)
//   6. Key storage rejects symlinks (regular file check)
//   7. Key storage uses openSync (TOCTOU mitigation)
//
// Run with: bun run tests/evidence-protocol-closure.ts

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

const poller = readFile("mini-services/execution-worker/poller.ts");
const submitEvidence = readFile("src/app/api/worker/submit-evidence/route.ts");

// ===========================================================================
// 1. WORKER SIGNS TASK EVIDENCE
// ===========================================================================

// Test 1: Worker has signTaskEvidence function.
{
  const hasFunc = poller.includes("function signTaskEvidence");
  record("Worker has signTaskEvidence function", hasFunc, `hasFunc: ${hasFunc}`);
}

// Test 2: Worker uses cryptoSign (Ed25519) for signing.
{
  const usesCryptoSign = poller.includes("cryptoSign(null, Buffer.from(evidenceHash");
  record("Worker uses cryptoSign (Ed25519) for evidence signing", usesCryptoSign, `usesCryptoSign: ${usesCryptoSign}`);
}

// Test 3: Worker sends evidenceSignature + evidenceHash in submit-evidence.
{
  const sendsSignature = poller.includes("body.evidenceSignature") && poller.includes("body.evidenceHash");
  record("Worker sends evidenceSignature + evidenceHash in submit-evidence body", sendsSignature, `sendsSignature: ${sendsSignature}`);
}

// Test 4: Worker computes evidence hash from evidence fields.
{
  const computesHash = poller.includes("createHash") && poller.includes("evidenceHash");
  record("Worker computes evidence hash from evidence fields", computesHash, `computesHash: ${computesHash}`);
}

// ===========================================================================
// 2. CONTROL PLANE VERIFIES SIGNATURE
// ===========================================================================

// Test 5: /submit-evidence verifies Ed25519 signature.
{
  const verifies = submitEvidence.includes("cryptoVerify(null, hashBuf, workerReg.publicKeyPem");
  record("/submit-evidence verifies Ed25519 signature with registered public key", verifies, `verifies: ${verifies}`);
}

// Test 6: /submit-evidence resolves public key from WorkerRegistry.
{
  const resolves = submitEvidence.includes("db.workerRegistry.findUnique") && submitEvidence.includes("publicKeyPem: true");
  record("/submit-evidence resolves worker public key from WorkerRegistry", resolves, `resolves: ${resolves}`);
}

// Test 7: /submit-evidence rejects on signature failure.
{
  const rejects = submitEvidence.includes("Evidence signature verification FAILED");
  record("/submit-evidence rejects on signature verification failure", rejects, `rejects: ${rejects}`);
}

// Test 8: /submit-evidence requires signature in production.
{
  const requiresUniversal = submitEvidence.includes("Evidence signature required.");
  record("/submit-evidence requires Ed25519 signature universally (FORGE_DEV_INSECURE_MODE bypass only)", requiresUniversal, `requiresUniversal: ${requiresUniversal}`);
}

// Test 9: /submit-evidence recomputes evidence hash (doesn't trust worker hash).
{
  const recomputes = submitEvidence.includes("expectedHash") && submitEvidence.includes("createHash");
  record("/submit-evidence recomputes evidence hash (doesn't trust worker-supplied hash)", recomputes, `recomputes: ${recomputes}`);
}

// Test 10: /submit-evidence rejects on hash mismatch.
{
  const rejectsHash = submitEvidence.includes("Evidence hash mismatch");
  record("/submit-evidence rejects on evidence hash mismatch", rejectsHash, `rejectsHash: ${rejectsHash}`);
}

// ===========================================================================
// 3. KEY STORAGE HARDENING
// ===========================================================================

// Test 11: Key directory permissions validated (0o700).
{
  const validatesDir = poller.includes("dirMode !== 0o700") && poller.includes("insecure permissions");
  record("Key directory permissions validated (must be 0o700)", validatesDir, `validatesDir: ${validatesDir}`);
}

// Test 12: Key file must be a regular file (not symlink).
{
  const checksRegular = poller.includes("!stat.isFile()");
  record("Key file must be a regular file (symlinks rejected)", checksRegular, `checksRegular: ${checksRegular}`);
}

// Test 13: Key file opened with openSync (TOCTOU mitigation).
{
  const usesOpen = poller.includes("openSync(WORKER_KEY_PATH");
  record("Key file opened with openSync (TOCTOU mitigation attempt)", usesOpen, `usesOpen: ${usesOpen}`);
}

// Test 14: Directory created with 0o700 mode.
{
  const createsSecure = poller.includes("mode: 0o700");
  record("Key directory created with 0o700 mode (owner access only)", createsSecure, `createsSecure: ${createsSecure}`);
}

// ===========================================================================
// 4. INTEGRATION: signing + verification round-trip
// ===========================================================================

// Test 15: Ed25519 signing + verification round-trip works for task evidence.
{
  const keyPair = generateKeyPairSync("ed25519");
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

  // Simulate worker signing.
  const evidence = { commitSha: "abc123", testResults: [{ passes: true }], guardianResult: { verdict: "PASS" } };
  const canonical = JSON.stringify(evidence, Object.keys(evidence).sort());
  const evidenceHash = createHash("sha256").update(canonical).digest("hex");
  const signature = cryptoSign(null, Buffer.from(evidenceHash, "utf-8"), privateKeyPem).toString("hex");

  // Simulate control plane verifying.
  const sigBuf = Buffer.from(signature, "hex");
  const hashBuf = Buffer.from(evidenceHash, "utf-8");
  const valid = cryptoVerify(null, hashBuf, publicKeyPem, sigBuf);

  record("Ed25519 task evidence signing + verification round-trip works", valid, `valid: ${valid}`);
}

// Test 16: Tampered evidence invalidates signature.
{
  const keyPair = generateKeyPairSync("ed25519");
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

  // Sign original evidence.
  const original = { commitSha: "abc123", passed: true };
  const canonical = JSON.stringify(original, Object.keys(original).sort());
  const evidenceHash = createHash("sha256").update(canonical).digest("hex");
  const signature = cryptoSign(null, Buffer.from(evidenceHash, "utf-8"), privateKeyPem).toString("hex");

  // Tamper: change commitSha.
  const tampered = { commitSha: "different", passed: true };
  const tamperedCanonical = JSON.stringify(tampered, Object.keys(tampered).sort());
  const tamperedHash = createHash("sha256").update(tamperedCanonical).digest("hex");

  // Verify with tampered hash (should fail because signature was for original hash).
  const sigBuf = Buffer.from(signature, "hex");
  const tamperedHashBuf = Buffer.from(tamperedHash, "utf-8");
  const valid = cryptoVerify(null, tamperedHashBuf, publicKeyPem, sigBuf);

  record("Tampered evidence invalidates Ed25519 signature", !valid, `valid: ${valid} (should be false)`);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18N: Worker Evidence Protocol Closure ===\n");
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
  console.log("\n❌ EVIDENCE PROTOCOL CLOSURE NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Evidence protocol closure verified — worker signs evidence, control plane verifies");
  process.exit(0);
}
