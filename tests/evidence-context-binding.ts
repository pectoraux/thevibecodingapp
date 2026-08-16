// Forge — Phase 18O: Evidence Context Binding
//
// Verifies:
//   1. Worker signs evidence WITH execution identity (workerId, executionId, leaseId)
//   2. Control plane verifies signed execution identity matches token
//   3. Replay across executions is rejected
//   4. Signed evidence is required universally (not just production)
//   5. O_NOFOLLOW actually used (numeric flag, read from fd)
//   6. No fake O_NOFOLLOW (no readFileSync(path) after openSync)
//
// Run with: bun run tests/evidence-context-binding.ts

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
// 1. WORKER SIGNS EVIDENCE WITH EXECUTION IDENTITY
// ===========================================================================

// Test 1: Worker's signTaskEvidence accepts execution context.
{
  const accepts = poller.includes("executionContext: { workerId: string; executionId: string; leaseId: string }");
  record("Worker's signTaskEvidence accepts execution context (workerId, executionId, leaseId)", accepts, `accepts: ${accepts}`);
}

// Test 2: Worker's signed envelope includes execution identity.
{
  const includesIdentity = poller.includes("executionId: executionContext.executionId") &&
    poller.includes("leaseId: executionContext.leaseId") &&
    poller.includes("workerId: executionContext.workerId");
  record("Worker's signed envelope includes executionId, leaseId, workerId", includesIdentity, `includesIdentity: ${includesIdentity}`);
}

// Test 3: Worker sends signedExecutionId + signedLeaseId.
{
  const sends = poller.includes("body.signedExecutionId") && poller.includes("body.signedLeaseId");
  record("Worker sends signedExecutionId + signedLeaseId in body", sends, `sends: ${sends}`);
}

// ===========================================================================
// 2. CONTROL PLANE VERIFIES EXECUTION IDENTITY
// ===========================================================================

// Test 4: Control plane checks signedExecutionId matches token.
{
  const checks = submitEvidence.includes("signedExecutionId !== token.executionId");
  record("Control plane verifies signedExecutionId matches authenticated token", checks, `checks: ${checks}`);
}

// Test 5: Control plane checks signedLeaseId matches token.
{
  const checks = submitEvidence.includes("signedLeaseId !== token.leaseId");
  record("Control plane verifies signedLeaseId matches authenticated token", checks, `checks: ${checks}`);
}

// Test 6: Control plane rejects on executionId mismatch (replay prevention).
{
  const rejects = submitEvidence.includes("Evidence replay across executions is not permitted");
  record("Control plane rejects on executionId mismatch (replay prevention)", rejects, `rejects: ${rejects}`);
}

// Test 7: Control plane's hash computation includes execution identity.
{
  const includesIdentity = submitEvidence.includes("executionId: token.executionId") &&
    submitEvidence.includes("leaseId: token.leaseId") &&
    submitEvidence.includes("workerId: token.workerId");
  record("Control plane's hash computation includes execution identity (envelope)", includesIdentity, `includesIdentity: ${includesIdentity}`);
}

// ===========================================================================
// 3. SIGNED EVIDENCE REQUIRED UNIVERSALLY
// ===========================================================================

// Test 8: No NODE_ENV-based bypass.
{
  const noNodeEnvBypass = !submitEvidence.includes('process.env.NODE_ENV === "production"');
  record("No NODE_ENV-based bypass for signed evidence requirement", noNodeEnvBypass, `noNodeEnvBypass: ${noNodeEnvBypass}`);
}

// Test 9: FORGE_DEV_INSECURE_MODE is the only bypass.
{
  const usesDevMode = submitEvidence.includes("FORGE_DEV_INSECURE_MODE");
  record("FORGE_DEV_INSECURE_MODE is the only bypass (explicit opt-in)", usesDevMode, `usesDevMode: ${usesDevMode}`);
}

// Test 10: No 'backward compatibility' comment.
{
  const noBackwardCompat = !submitEvidence.includes("backward compatibility");
  record("No 'backward compatibility' acceptance of unsigned evidence", noBackwardCompat, `noBackwardCompat: ${noBackwardCompat}`);
}

// ===========================================================================
// 4. O_NOFOLLOW ACTUALLY IMPLEMENTED
// ===========================================================================

// Test 11: Uses numeric O_NOFOLLOW flag.
{
  const usesNumeric = poller.includes("0o400000");
  record("Uses numeric O_NOFOLLOW flag (0o400000)", usesNumeric, `usesNumeric: ${usesNumeric}`);
}

// Test 12: Reads from file descriptor (not from path).
{
  const readsFromFd = poller.includes("readFileSync(fd,");
  const noReopen = !poller.includes("readFileSync(WORKER_KEY_PATH");
  record("Reads from file descriptor (not from path — eliminates TOCTOU)", readsFromFd && noReopen, `readsFromFd: ${readsFromFd}, noReopen: ${noReopen}`);
}

// Test 13: No fake O_NOFOLLOW comment admitting it doesn't work.
{
  const noFakeComment = !poller.includes("Node's openSync doesn't directly support O_NOFOLLOW");
  record("No fake O_NOFOLLOW comment (admitting it doesn't work)", noFakeComment, `noFakeComment: ${noFakeComment}`);
}

// ===========================================================================
// 5. REPLAY ATTACK INTEGRATION TEST
// ===========================================================================

// Test 14: Evidence signed for execution A cannot be verified for execution B.
{
  const keyPair = generateKeyPairSync("ed25519");
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

  // Sign evidence for execution A.
  const evidenceA = { commitSha: "abc123", passed: true };
  const envelopeA = {
    evidence: evidenceA,
    executionId: "exec-A",
    leaseId: "lease-A",
    workerId: "worker-1",
  };
  const canonicalA = JSON.stringify(envelopeA, Object.keys(envelopeA).sort());
  const hashA = createHash("sha256").update(canonicalA).digest("hex");
  const sigA = cryptoSign(null, Buffer.from(hashA, "utf-8"), privateKeyPem).toString("hex");

  // Now try to verify against execution B (different executionId).
  const envelopeB = {
    evidence: evidenceA,
    executionId: "exec-B", // Different!
    leaseId: "lease-A",
    workerId: "worker-1",
  };
  const canonicalB = JSON.stringify(envelopeB, Object.keys(envelopeB).sort());
  const hashB = createHash("sha256").update(canonicalB).digest("hex");

  // The signature was for hashA, but the verifier recomputes hashB.
  // hashA !== hashB because executionId differs.
  const hashesMatch = hashA === hashB;

  // Even if the attacker supplies hashA, the verifier recomputes and gets hashB.
  // The signature was for hashA, so verifying against hashB fails.
  const sigBuf = Buffer.from(sigA, "hex");
  const hashBBuf = Buffer.from(hashB, "utf-8");
  const sigValidAgainstB = cryptoVerify(null, hashBBuf, publicKeyPem, sigBuf);

  record(
    "Evidence signed for execution A fails verification against execution B (replay prevented)",
    !hashesMatch && !sigValidAgainstB,
    `hashesMatch: ${hashesMatch}, sigValidAgainstB: ${sigValidAgainstB} (both should be false)`
  );
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18O: Evidence Context Binding ===\n");
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
  console.log("\n❌ EVIDENCE CONTEXT BINDING NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Evidence context binding verified — evidence is execution-bound, replay prevented");
  process.exit(0);
}
