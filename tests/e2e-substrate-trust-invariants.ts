// Forge — Phase 18W-C: E2E Substrate Trust Invariants.
//
// This is the END-TO-END ACCEPTANCE TEST for the two-signature trust model
// across the WHOLE path:
//
//   worker (Ed25519 key) → substrate (real launcher, real namespace isolation)
//     → signed attestation (Ed25519 launcher key) → signed envelope (Ed25519
//     worker key) → control-plane verification (verifies BOTH signatures,
//     rejects forgeries, fail-closed when launcher key not pinned).
//
// This test does NOT use HTTP or DB. It calls the REAL functions directly:
//   - executeRuntimeVerificationInWorker() runs the orchestrator inside the
//     real substrate (fork unshare, seccomp BPF, namespace inodes that differ
//     from the host).
//   - verifyEvidenceEnvelope() verifies the worker's signature.
//   - verifyLauncherAttestation() / isSubstrateTrusted() verify the launcher's
//     signature.
//   - canReachProductionReadyWithRuntime() exercises the production gate.
//
// Tests:
//   1.  FULL E2E — valid path: worker → substrate → evidence → verification.
//   2.  Fabricated attestation rejected (random launcherSignature).
//   3.  Worker-key forgery rejected (sign canonicalFactsJson with worker key,
//       put as launcherSignature; launcher key ≠ worker key).
//   4.  Wrong nonce rejected.
//   5.  Wrong executionId rejected.
//   6.  Wrong launcher public key rejected (different launcher keypair).
//   7.  No launcher public key configured → fail-closed (production blocked).
//   8.  Envelope tampering breaks worker signature (change envelope.passed).
//   9.  Attestation bound into envelope hash (different substrateInstanceId
//       → different envelopeHash — proves the attestation is Ed25519-bound).
//   10. Failed app still produces valid attestation (substrate ran, workload
//       just failed; orchestrator exits 1).
//   11. Production predicate requires trusted attestation
//       (executionEnvironmentSandboxed + substrateAttestationVerified).
//   12. Real substrate isolation in the E2E path (namespace inodes differ
//       from host, seccompMode=2, seccompProfileHash matches required).
//
// Run with: bun run tests/e2e-substrate-trust-invariants.ts

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash, sign as cryptoSign } from "node:crypto";

import { executeRuntimeVerificationInWorker, generateSubstrateNonce } from "../mini-services/execution-worker/runtime/verify.js";
import {
  verifySubstrateAttestation,
  verifyLauncherAttestation,
  isSubstrateTrusted,
  generateLauncherKeyPair,
  REQUIRED_SECCOMP_PROFILE_HASH,
  type SandboxAttestation,
} from "@/lib/substrate-attestation";
import { getHostNamespaceInodes } from "@/lib/substrate-namespace";
import {
  generateWorkerKeyPair,
  verifyEvidenceEnvelope,
  computeEnvelopeHash,
  type ExecutionEvidenceEnvelope,
} from "@/lib/runtime-execution-contract";
import {
  canReachProductionReadyWithRuntime,
  getProductionReadinessFailureReason,
  type ProductionReadinessEvidence,
} from "@/lib/runtime-verification";

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

// ===========================================================================
// Test fixture — minimal Node.js HTTP server app
// ===========================================================================

const TEST_APP_DIR = "/tmp/forge-e2e-test-app";
const CRASH_APP_DIR = "/tmp/forge-e2e-crash-app";
const LAUNCHER_KEY_FILE = `/tmp/forge-e2e-launcher-key-${Date.now()}.pem`;

const LAUNCHER_KEY = generateLauncherKeyPair();
writeFileSync(LAUNCHER_KEY_FILE, LAUNCHER_KEY.privateKeyPem, { mode: 0o600 });

const WORKER_KEY = generateWorkerKeyPair("e2e-test-worker");

/**
 * Create a minimal Node.js HTTP server app at TEST_APP_DIR. Responds 200 OK
 * on /health, 404 on anything else. Initialized as a git repo so we have a
 * real SHA to checkout.
 */
function setupTestApp(): string {
  rmSync(TEST_APP_DIR, { recursive: true, force: true });
  mkdirSync(TEST_APP_DIR, { recursive: true });
  const serverJs = `const http = require("http");
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("OK"); return; }
  res.writeHead(404); res.end("Not found");
});
server.listen(parseInt(process.env.PORT || "3000"), "127.0.0.1", () => {
  console.log("SERVER_LISTENING");
});
`;
  writeFileSync(join(TEST_APP_DIR, "server.js"), serverJs);
  writeFileSync(join(TEST_APP_DIR, "package.json"), JSON.stringify({
    name: "forge-e2e-app",
    version: "1.0.0",
    scripts: { start: "node server.js" },
  }, null, 2));

  execFileSync("git", ["init"], { cwd: TEST_APP_DIR, shell: false });
  execFileSync("git", ["config", "user.email", "test@forge"], { cwd: TEST_APP_DIR, shell: false });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: TEST_APP_DIR, shell: false });
  execFileSync("git", ["add", "."], { cwd: TEST_APP_DIR, shell: false });
  execFileSync("git", ["commit", "-m", "init"], { cwd: TEST_APP_DIR, shell: false });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: TEST_APP_DIR,
    encoding: "utf-8",
    shell: false,
  }).trim();
  return sha;
}

/**
 * Create an app that CRASHES on start (exits immediately with code 1). The
 * orchestrator's port-wait will fail because the app process is gone.
 */
function setupCrashingApp(): string {
  rmSync(CRASH_APP_DIR, { recursive: true, force: true });
  mkdirSync(CRASH_APP_DIR, { recursive: true });
  // server.js exits with code 1 immediately — the orchestrator's port-wait
  // will fail because the app process is gone.
  const serverJs = `process.stderr.write("CRASHING_ON_PURPOSE\\n");
process.exit(1);
`;
  writeFileSync(join(CRASH_APP_DIR, "server.js"), serverJs);
  writeFileSync(join(CRASH_APP_DIR, "package.json"), JSON.stringify({
    name: "forge-e2e-crash-app",
    version: "1.0.0",
    scripts: { start: "node server.js" },
  }, null, 2));

  execFileSync("git", ["init"], { cwd: CRASH_APP_DIR, shell: false });
  execFileSync("git", ["config", "user.email", "test@forge"], { cwd: CRASH_APP_DIR, shell: false });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: CRASH_APP_DIR, shell: false });
  execFileSync("git", ["add", "."], { cwd: CRASH_APP_DIR, shell: false });
  execFileSync("git", ["commit", "-m", "init"], { cwd: CRASH_APP_DIR, shell: false });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: CRASH_APP_DIR,
    encoding: "utf-8",
    shell: false,
  }).trim();
  return sha;
}

function makePlan(port: number = 3000) {
  return {
    install: { binary: "/bin/echo", args: ["install-step"], timeoutMs: 10000 },
    build: { binary: "/bin/echo", args: ["build-step"], timeoutMs: 10000 },
    start: {
      binary: "node",
      args: ["/workspace/repo/server.js"],
      env: { PORT: String(port) },
      timeoutMs: 30000,
    },
    port,
    startupTimeoutMs: 10000,
    healthChecks: [
      {
        name: "health",
        path: "/health",
        expectedStatus: 200,
        timeoutMs: 5000,
        required: "required" as const,
      },
    ],
    apiJourneys: [],
  };
}

/**
 * Run executeRuntimeVerificationInWorker with the standard test config.
 * Returns the envelope + the values needed for verification.
 */
async function runVerification(opts: {
  executionId?: string;
  nonce?: string;
  port?: number;
  crashing?: boolean;
  launcherKeyFile?: string;
} = {}): Promise<{ envelope: ExecutionEvidenceEnvelope; sha: string; executionId: string; nonce: string }> {
  const useCrashApp = opts.crashing === true;
  const sha = useCrashApp ? setupCrashingApp() : setupTestApp();
  const executionId = opts.executionId || randomUUID();
  const nonce = opts.nonce || generateSubstrateNonce();
  const port = opts.port || 3000;
  const plan = makePlan(port);
  const envelope = await executeRuntimeVerificationInWorker({
    executionId,
    workerId: "e2e-test-worker",
    leaseId: "lease-1",
    repositoryHeadSha: sha,
    repositoryUrl: useCrashApp ? CRASH_APP_DIR : TEST_APP_DIR,
    architectureHash: null,
    runtimePlanHash: "e2e-plan-hash",
    plan,
    nonce,
    launcherKeyFile: opts.launcherKeyFile || LAUNCHER_KEY_FILE,
    workerPrivateKeyPem: WORKER_KEY.privateKeyPem,
    totalTimeoutMs: 120000,
  });
  return { envelope, sha, executionId, nonce };
}

// ===========================================================================
// TEST 1 — FULL E2E: valid path (worker → substrate → evidence → verification)
// ===========================================================================
// The complete happy path: a worker with an Ed25519 key runs the orchestrator
// inside the real substrate (with a launcher that has its OWN Ed25519 key).
// The substrate produces a launcher-signed attestation. The worker wraps it
// in an Ed25519-signed envelope. ALL of the following must hold:
//   - envelope.substrateAttestation is non-null.
//   - verifyEvidenceEnvelope(envelope, workerPublicKey) === true.
//   - verifyLauncherAttestation(att, launcherPublicKey, nonce, executionId).valid === true.
//   - isSubstrateTrusted(att, launcherPublicKey, nonce, executionId) === true.
//   - envelope.passed === true (the test app's /health returned 200).
//   - att.workloadExitCode === 0 (orchestrator exited successfully).
//   - att.executionId === executionId (binding).
//   - att.nonce === nonce (binding).

let test1Envelope: ExecutionEvidenceEnvelope | null = null;
let test1ExecutionId = "";
let test1Nonce = "";

{
  const { envelope, executionId, nonce } = await runVerification();
  test1Envelope = envelope;
  test1ExecutionId = executionId;
  test1Nonce = nonce;

  const att = envelope.substrateAttestation;
  const attNonNull = att !== null && att !== undefined;
  const sigValid = verifyEvidenceEnvelope(envelope, WORKER_KEY.publicKeyPem);
  const launcherResult = attNonNull
    ? verifyLauncherAttestation(att, LAUNCHER_KEY.publicKeyPem, nonce, executionId)
    : { valid: false, reasons: ["attestation is null"] };
  const trusted = attNonNull
    ? isSubstrateTrusted(att, LAUNCHER_KEY.publicKeyPem, nonce, executionId)
    : false;
  const passedBool = envelope.passed === true;
  const exitCode0 = attNonNull && att.workloadExitCode === 0;
  const execMatch = attNonNull && att.executionId === executionId;
  const nonceMatch = attNonNull && att.nonce === nonce;

  const ok = attNonNull && sigValid && launcherResult.valid && trusted && passedBool && exitCode0 && execMatch && nonceMatch;
  const details = !attNonNull
    ? "substrateAttestation is null"
    : `sigValid=${sigValid} launcherValid=${launcherResult.valid} trusted=${trusted} passed=${envelope.passed} exitCode=${att.workloadExitCode} execMatch=${execMatch} nonceMatch=${nonceMatch}`;
  record(
    "Test 1: FULL E2E — valid path (worker → substrate → evidence → verification all pass)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 2 — fabricated attestation rejected (random launcherSignature)
// ===========================================================================
// Take the valid envelope from test 1. Replace launcherSignature with a
// random 128-char hex string (looks structurally like an Ed25519 sig but
// won't verify). verifyLauncherAttestation must return valid=false.

{
  if (!test1Envelope || !test1Envelope.substrateAttestation) {
    record(
      "Test 2: fabricated attestation rejected (random launcherSignature)",
      false,
      "test1Envelope or attestation is null — cannot run tamper test"
    );
  } else {
    const tampered: SandboxAttestation = {
      ...test1Envelope.substrateAttestation,
      launcherSignature: "ab".repeat(64), // 128 hex chars = 64 bytes (Ed25519 sig length)
    };
    const result = verifyLauncherAttestation(
      tampered,
      LAUNCHER_KEY.publicKeyPem,
      test1Nonce,
      test1ExecutionId
    );
    const trusted = isSubstrateTrusted(
      tampered,
      LAUNCHER_KEY.publicKeyPem,
      test1Nonce,
      test1ExecutionId
    );
    const ok = !result.valid && !trusted;
    const details = `verifyLauncherAttestation.valid=${result.valid} isSubstrateTrusted=${trusted} reasons=${result.reasons.slice(0, 2).join("; ")}`;
    record(
      "Test 2: fabricated attestation rejected (random launcherSignature)",
      ok,
      details
    );
  }
}

// ===========================================================================
// TEST 3 — worker-key forgery rejected (sign with WORKER key, not launcher)
// ===========================================================================
// A compromised worker might try to forge the launcher signature by signing
// canonicalFactsJson with the WORKER's private key (which it has). The
// control plane verifies against the LAUNCHER's public key, so the signature
// won't validate (launcher key ≠ worker key).

{
  if (!test1Envelope || !test1Envelope.substrateAttestation) {
    record(
      "Test 3: worker-key forgery rejected (sign canonicalFactsJson with worker key)",
      false,
      "test1Envelope or attestation is null — cannot run forgery test"
    );
  } else {
    const orig = test1Envelope.substrateAttestation;
    // Sign canonicalFactsJson with the WORKER's private key.
    const data = Buffer.from(orig.canonicalFactsJson, "utf-8");
    const forgedSig = cryptoSign(null, data, WORKER_KEY.privateKeyPem).toString("hex");
    const forged: SandboxAttestation = {
      ...orig,
      launcherSignature: forgedSig,
    };
    const result = verifyLauncherAttestation(
      forged,
      LAUNCHER_KEY.publicKeyPem,
      test1Nonce,
      test1ExecutionId
    );
    const ok = !result.valid;
    const details = `forgedValid=${result.valid} (must be false — worker key ≠ launcher key) reasons=${result.reasons.slice(0, 2).join("; ")}`;
    record(
      "Test 3: worker-key forgery rejected (sign canonicalFactsJson with worker key — launcher key ≠ worker key)",
      ok,
      details
    );
  }
}

// ===========================================================================
// TEST 4 — wrong nonce rejected
// ===========================================================================
// verifyLauncherAttestation must reject when expectedNonce ≠ attestation.nonce.
// This is the anti-replay check: a launcher-signed attestation from execution
// A cannot be replayed for execution B (different nonce).

{
  if (!test1Envelope || !test1Envelope.substrateAttestation) {
    record(
      "Test 4: wrong nonce rejected",
      false,
      "test1Envelope or attestation is null — cannot run nonce test"
    );
  } else {
    const result = verifyLauncherAttestation(
      test1Envelope.substrateAttestation,
      LAUNCHER_KEY.publicKeyPem,
      "wrong-nonce-" + randomUUID(),
      test1ExecutionId
    );
    const mentionsNonce = result.reasons.some((r) => r.toLowerCase().includes("nonce"));
    const ok = !result.valid && mentionsNonce;
    const details = `valid=${result.valid} mentionsNonce=${mentionsNonce} reasons=${result.reasons.slice(0, 2).join("; ")}`;
    record(
      "Test 4: wrong nonce rejected (anti-replay — attestation from execution A cannot be replayed for execution B)",
      ok,
      details
    );
  }
}

// ===========================================================================
// TEST 5 — wrong executionId rejected
// ===========================================================================
// verifyLauncherAttestation must reject when expectedExecutionId ≠ attestation.executionId.
// This binds the attestation to a specific execution.

{
  if (!test1Envelope || !test1Envelope.substrateAttestation) {
    record(
      "Test 5: wrong executionId rejected",
      false,
      "test1Envelope or attestation is null — cannot run execId test"
    );
  } else {
    const result = verifyLauncherAttestation(
      test1Envelope.substrateAttestation,
      LAUNCHER_KEY.publicKeyPem,
      test1Nonce,
      "wrong-exec-" + randomUUID()
    );
    const mentionsExec = result.reasons.some((r) => r.toLowerCase().includes("executionid"));
    const ok = !result.valid && mentionsExec;
    const details = `valid=${result.valid} mentionsExecId=${mentionsExec} reasons=${result.reasons.slice(0, 2).join("; ")}`;
    record(
      "Test 5: wrong executionId rejected (attestation is bound to a specific execution)",
      ok,
      details
    );
  }
}

// ===========================================================================
// TEST 6 — wrong launcher public key rejected (different launcher keypair)
// ===========================================================================
// The control plane pins ONE launcher public key. If the worker uses a
// different launcher key (e.g., by replacing the launcher binary or
// compromising the launcher key file), the signature won't verify against
// the pinned key.

{
  if (!test1Envelope || !test1Envelope.substrateAttestation) {
    record(
      "Test 6: wrong launcher public key rejected (different launcher keypair)",
      false,
      "test1Envelope or attestation is null — cannot run key test"
    );
  } else {
    // Generate a DIFFERENT launcher keypair.
    const differentKey = generateLauncherKeyPair();
    const result = verifyLauncherAttestation(
      test1Envelope.substrateAttestation,
      differentKey.publicKeyPem,
      test1Nonce,
      test1ExecutionId
    );
    const ok = !result.valid;
    const details = `valid=${result.valid} (must be false — pinned key ≠ signing key) reasons=${result.reasons.slice(0, 2).join("; ")}`;
    record(
      "Test 6: wrong launcher public key rejected (control plane pins ONE key; different keypair fails)",
      ok,
      details
    );
  }
}

// ===========================================================================
// TEST 7 — no launcher public key configured → fail-closed
// ===========================================================================
// If FORGE_LAUNCHER_PUBLIC_KEY is not set (or empty), isSubstrateTrusted
// must return false. This is the correct fail-closed behavior: no pinned
// key, no trust, no production.

{
  if (!test1Envelope || !test1Envelope.substrateAttestation) {
    record(
      "Test 7: no launcher public key configured → fail-closed (production blocked)",
      false,
      "test1Envelope or attestation is null — cannot run fail-closed test"
    );
  } else {
    // Empty key → untrusted.
    const trustedEmpty = isSubstrateTrusted(
      test1Envelope.substrateAttestation,
      "",
      test1Nonce,
      test1ExecutionId
    );
    // Also verify with the launcher verifier directly — it must report the
    // empty-key reason.
    const verifyResult = verifyLauncherAttestation(
      test1Envelope.substrateAttestation,
      "",
      test1Nonce,
      test1ExecutionId
    );
    const mentionsEmpty = verifyResult.reasons.some((r) =>
      r.toLowerCase().includes("empty") || r.toLowerCase().includes("not provisioned")
    );
    const ok = !trustedEmpty && !verifyResult.valid && mentionsEmpty;
    const details = `trustedEmpty=${trustedEmpty} verifyValid=${verifyResult.valid} mentionsEmpty=${mentionsEmpty} reasons=${verifyResult.reasons.slice(0, 2).join("; ")}`;
    record(
      "Test 7: no launcher public key configured → fail-closed (production blocked)",
      ok,
      details
    );
  }
}

// ===========================================================================
// TEST 8 — envelope tampering breaks worker signature
// ===========================================================================
// Take the valid envelope. Change envelope.passed from true to false. The
// worker signed the ORIGINAL envelope hash (which covered passed=true).
// After tampering, either the recomputed hash won't match envelopeHash, OR
// the signature won't match the new hash. Either way, verifyEvidenceEnvelope
// must return false.

{
  if (!test1Envelope) {
    record(
      "Test 8: envelope tampering breaks worker signature (change envelope.passed)",
      false,
      "test1Envelope is null — cannot run tamper test"
    );
  } else {
    // Deep-clone the envelope (it has nested substrateAttestation).
    const tampered: ExecutionEvidenceEnvelope = JSON.parse(JSON.stringify(test1Envelope));
    tampered.passed = !tampered.passed; // flip true→false (or false→true)
    // NOTE: do NOT recompute envelopeHash — the worker signed the original
    // hash. The tampered envelope now has a stale hash that doesn't match
    // its content, OR if we recomputed, the signature wouldn't match the
    // new hash. Either path is a valid tamper detection.
    const sigValid = verifyEvidenceEnvelope(tampered, WORKER_KEY.publicKeyPem);
    const ok = !sigValid;
    const details = `sigValid=${sigValid} (must be false — envelope.passed was flipped)`;
    record(
      "Test 8: envelope tampering breaks worker signature (change envelope.passed)",
      ok,
      details
    );
  }
}

// ===========================================================================
// TEST 9 — attestation bound into envelope hash
// ===========================================================================
// The attestation must be cryptographically bound into the worker's signed
// envelope hash. Proof: change substrateInstanceId in the attestation, then
// recompute computeEnvelopeHash. The hash must DIFFER from the original.
// (If it didn't differ, a worker could swap in any attestation after signing.)

{
  if (!test1Envelope || !test1Envelope.substrateAttestation) {
    record(
      "Test 9: attestation bound into envelope hash (different substrateInstanceId → different hash)",
      false,
      "test1Envelope or attestation is null — cannot run hash-binding test"
    );
  } else {
    // Strip the signature field — computeEnvelopeHash takes the envelope
    // WITHOUT the signature.
    const { signature: _origSig, ...originalWithoutSig } = test1Envelope;
    const originalHash = computeEnvelopeHash(originalWithoutSig);

    const tamperedAtt: SandboxAttestation = {
      ...test1Envelope.substrateAttestation,
      substrateInstanceId: "tampered-instance-id-" + randomUUID(),
    };
    const { signature: _tamperedSig, ...tamperedWithoutSig } = {
      ...test1Envelope,
      substrateAttestation: tamperedAtt,
    };
    const tamperedHash = computeEnvelopeHash(tamperedWithoutSig);

    const hashesDiffer = originalHash !== tamperedHash;
    const ok = hashesDiffer;
    const details = `originalHash=${originalHash.slice(0, 16)}... tamperedHash=${tamperedHash.slice(0, 16)}... differ=${hashesDiffer}`;
    record(
      "Test 9: attestation bound into envelope hash (different substrateInstanceId → different envelopeHash)",
      ok,
      details
    );
  }
}

// ===========================================================================
// TEST 10 — failed app still produces valid attestation
// ===========================================================================
// Create an app that CRASHES on start (exits immediately with code 1). Run
// executeRuntimeVerificationInWorker. The workload fails:
//   - envelope.passed === false.
//   - envelope.substrateAttestation is STILL non-null (the substrate ran).
//   - isSubstrateTrusted === true (the attestation is still valid — the
//     substrate ran correctly, just the workload failed).
//   - att.workloadExitCode !== 0 (the orchestrator exited with failure,
//     because the workload failed and orchestrator calls process.exit(passed ? 0 : 1)).

{
  const { envelope, executionId, nonce } = await runVerification({ crashing: true });
  const att = envelope.substrateAttestation;
  const attNonNull = att !== null && att !== undefined;
  const passedFalse = envelope.passed === false;
  const trusted = attNonNull
    ? isSubstrateTrusted(att, LAUNCHER_KEY.publicKeyPem, nonce, executionId)
    : false;
  const exitNonZero = attNonNull && att.workloadExitCode !== 0 && att.workloadExitCode !== null;
  const ok = attNonNull && passedFalse && trusted && exitNonZero;
  const details = `attNonNull=${attNonNull} passed=${envelope.passed} trusted=${trusted} exitCode=${att?.workloadExitCode}`;
  record(
    "Test 10: failed app still produces valid attestation (substrate ran, workload failed, orchestrator exited non-zero)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 11 — production predicate requires trusted attestation
// ===========================================================================
// canReachProductionReadyWithRuntime requires executionEnvironmentSandboxed
// AND substrateAttestationVerified. Construct evidence with both false →
// predicate fails. With both true (and all other conditions passing) →
// predicate passes. The failure reason must mention substrate/attestation/
// sandboxed when the trust is missing.

{
  const baseEvidence: ProductionReadinessEvidence = {
    architectureFrozen: true,
    allTasksCompleted: true,
    allTasksIntegrated: true,
    staticReadinessPassed: true,
    runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true,
    repositoryHeadVerified: true,
    // Will be overridden per-case:
    executionEnvironmentSandboxed: false,
    substrateAttestationVerified: false,
  };

  // Case A: no trusted attestation → NOT production-ready.
  const evidenceWithoutTrust: ProductionReadinessEvidence = {
    ...baseEvidence,
    executionEnvironmentSandboxed: false,
    substrateAttestationVerified: false,
  };
  const caseA = canReachProductionReadyWithRuntime(evidenceWithoutTrust);
  const caseAReason = getProductionReadinessFailureReason(evidenceWithoutTrust) ?? "";
  const caseAMentionsTrust =
    caseAReason.toLowerCase().includes("substrate") ||
    caseAReason.toLowerCase().includes("attestation") ||
    caseAReason.toLowerCase().includes("sandboxed");

  // Case B: trusted attestation → production-ready (all other conditions pass).
  const evidenceWithTrust: ProductionReadinessEvidence = {
    ...baseEvidence,
    executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
  };
  const caseB = canReachProductionReadyWithRuntime(evidenceWithTrust);

  const ok = !caseA && caseAMentionsTrust && caseB;
  const details = `caseA(noTrust)=${caseA} caseAReason="${caseAReason}" caseB(trust)=${caseB}`;
  record(
    "Test 11: production predicate requires trusted attestation (no trust → blocked; trust → ready; reason mentions substrate)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 12 — real substrate isolation in the E2E path
// ===========================================================================
// The E2E path (test 1) must have actually run inside the real substrate,
// not a mock. Proof: the attestation's namespace inodes differ from the
// host's, seccompMode=2, seccompProfileHash matches the required filter.

{
  if (!test1Envelope || !test1Envelope.substrateAttestation) {
    record(
      "Test 12: real substrate isolation in the E2E path (namespace inodes differ from host, seccompMode=2, profile hash matches)",
      false,
      "test1Envelope or attestation is null — cannot run isolation test"
    );
  } else {
    const att = test1Envelope.substrateAttestation;
    const hostInodes = getHostNamespaceInodes();
    // Read the host user inode directly too (defense-in-depth — getHostNamespaceInodes
    // is the production helper, but we want to independently confirm).
    let hostUserInode = "";
    try {
      hostUserInode = readlinkSync("/proc/self/ns/user") ?? "";
    } catch {
      hostUserInode = "";
    }

    const userDiffers = att.userNamespaceInode !== hostInodes.user;
    const userDiffersDirect = att.userNamespaceInode !== hostUserInode;
    const pidDiffers = att.pidNamespaceInode !== hostInodes.pid;
    const netDiffers = att.netNamespaceInode !== hostInodes.net;
    const mntDiffers = att.mntNamespaceInode !== hostInodes.mnt;
    const seccompModeValid = att.seccompMode === 2;
    const seccompHashValid = att.seccompProfileHash === REQUIRED_SECCOMP_PROFILE_HASH;

    const ok = userDiffers && userDiffersDirect && pidDiffers && netDiffers && mntDiffers && seccompModeValid && seccompHashValid;
    const details = `userDiffers=${userDiffers} userDiffersDirect=${userDiffersDirect} pidDiffers=${pidDiffers} netDiffers=${netDiffers} mntDiffers=${mntDiffers} seccompMode=${att.seccompMode} hashValid=${seccompHashValid} att.user=${att.userNamespaceInode} host.user=${hostInodes.user}`;
    record(
      "Test 12: real substrate isolation in the E2E path (namespace inodes differ from host, seccompMode=2, profile hash matches)",
      ok,
      details
    );
  }
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n=== e2e-substrate-trust-invariants ===\n");
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  if (!r.passed) {
    console.log(`  ${r.details}`);
  }
}
console.log(`\n=== e2e-substrate-trust-invariants: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("\n❌ E2E SUBSTRATE TRUST INVARIANTS NOT SATISFIED — control plane may accept forged attestations");
  process.exit(1);
} else {
  console.log("\n✅ E2E substrate trust enforced — worker → substrate → evidence → control-plane verification all hold");
  process.exit(0);
}
