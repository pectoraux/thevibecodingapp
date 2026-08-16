// Forge — Phase 18W-B: Worker Runtime Wiring Invariants.
//
// This is the ACCEPTANCE TEST for the real worker runtime verification wiring.
// It proves that:
//
//   1. The orchestrator runs INSIDE the substrate (a real Node.js HTTP server
//      starts, listens on the port, responds to /health, and is torn down).
//   2. The substrate attestation is REAL (non-null) — never the Phase 18V
//      placeholder null.
//   3. The attestation has a valid launcher signature (verifies against the
//      pinned launcher public key).
//   4. The attestation has valid namespace inodes (not host sentinels),
//      seccompMode=2, and the required seccomp profile hash.
//   5. The envelope is properly signed by the worker's Ed25519 key.
//   6. The attestation is BOUND to the execution: executionId + nonce match
//      the job's values.
//   7. The attestation records the workload results: workloadExitCode matches
//      the orchestrator's exit code, workloadStdoutHash matches SHA-256 of
//      the orchestrator's stdout.
//   8. A failed app (wrong port) produces a failed result (passed: false,
//      failureReason mentions startup failure) — BUT the attestation is still
//      present (the substrate ran, the workload just failed).
//   9. There is NO null-attestation path: if the substrate fails, the function
//      throws (test by passing a bad launcherKeyFile path).
//  10. The orchestrator handles a real app with all stages (install + build +
//      start + health check) and produces results for every stage.
//
// Run with: bun run tests/worker-runtime-wiring-invariants.ts

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

import { executeRuntimeVerificationInWorker, generateSubstrateNonce } from "../mini-services/execution-worker/runtime/verify.js";
import {
  verifySubstrateAttestation,
  verifyLauncherAttestation,
  isSubstrateTrusted,
  REQUIRED_SECCOMP_PROFILE_HASH,
  type SandboxAttestation,
} from "@/lib/substrate-attestation";
import {
  generateWorkerKeyPair,
  verifyEvidenceEnvelope,
  type ExecutionEvidenceEnvelope,
} from "@/lib/runtime-execution-contract";
import {
  deriveWorkloadFromPlan,
  computeWorkloadHash,
} from "@/lib/execution-capability";
import { startTestSupervisor, type TestSupervisor } from "./lib/test-supervisor.js";

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

const TEST_APP_DIR = "/tmp/forge-wiring-test-app";

// Phase 18X: the test starts a substrate supervisor (TRUSTED mini-service on
// port 3004). The supervisor holds the launcher key IN MEMORY (file deleted
// at startup). The worker module (executeRuntimeVerificationInWorker) POSTs
// { capability, workload } to the supervisor and receives { attestation }.
// The worker NEVER has the launcher key — only the supervisor does.
let SUPERVISOR: TestSupervisor | null = null;
let LAUNCHER_PUBLIC_KEY = "";

const WORKER_KEY = generateWorkerKeyPair("wiring-test-worker");

/**
 * Create a minimal Node.js HTTP server app at TEST_APP_DIR. The app responds
 * 200 OK on /health and 404 on anything else. Initialized as a git repo so
 * we have a real SHA to checkout.
 *
 * @param portOverride If provided, the server HARDCODES this port (ignoring
 *                     process.env.PORT). Used to simulate a failed startup
 *                     (app listens on a different port than the plan expects).
 */
function setupTestApp(portOverride?: number): string {
  rmSync(TEST_APP_DIR, { recursive: true, force: true });
  mkdirSync(TEST_APP_DIR, { recursive: true });
  const port = portOverride ?? 3000;
  // If portOverride is set, hardcode the port (ignore PORT env) so the plan's
  // env can't override the test's intent. Otherwise read PORT env (default 3000).
  const listenLine = portOverride
    ? `server.listen(${portOverride}, "127.0.0.1", () => {`
    : `server.listen(parseInt(process.env.PORT || "3000"), "127.0.0.1", () => {`;
  const serverJs = `const http = require("http");
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("OK"); return; }
  if (req.url === "/api/items") { res.writeHead(200); res.end(JSON.stringify({items:[]})); return; }
  res.writeHead(404); res.end("Not found");
});
${listenLine}
  console.log("SERVER_LISTENING");
});
`;
  writeFileSync(join(TEST_APP_DIR, "server.js"), serverJs);
  writeFileSync(join(TEST_APP_DIR, "package.json"), JSON.stringify({
    name: "forge-test-app",
    version: "1.0.0",
    scripts: { start: "node server.js" },
  }, null, 2));

  // Initialize as a git repo so we can clone + checkout at the SHA.
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
 * A standard plan that uses /bin/echo for install+build (fast, no network)
 * and `node /workspace/repo/server.js` for start.
 */
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
 * Phase 18X: the test signs an ExecutionCapability with the control-plane
 * private key (held by the test harness — in production, the control plane
 * signs it). The worker POSTs { capability, workload } to the supervisor
 * and receives { attestation }.
 */
async function runVerification(opts: {
  executionId?: string;
  nonce?: string;
  port?: number;
  portOverride?: number; // mismatch: app listens on different port than plan
  /** If true, the capability is omitted — supervisor should reject. */
  omitCapability?: boolean;
}): Promise<{ envelope: ExecutionEvidenceEnvelope; sha: string; executionId: string; nonce: string }> {
  const sha = setupTestApp(opts.portOverride);
  const executionId = opts.executionId || randomUUID();
  const nonce = opts.nonce || generateSubstrateNonce();
  const port = opts.port || 3000;
  const plan = makePlan(port);
  const capability = opts.omitCapability
    ? undefined
    : SUPERVISOR!.signCapability({
        executionId,
        nonce,
        leaseId: "lease-1",
        repositoryHeadSha: sha,
        runtimePlanHash: "test-plan-hash",
        architectureHash: null,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        runtimePlan: plan as unknown as Record<string, unknown>,
        workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
      });
  const envelope = await executeRuntimeVerificationInWorker({
    executionId,
    workerId: "wiring-test-worker",
    leaseId: "lease-1",
    repositoryHeadSha: sha,
    repositoryUrl: TEST_APP_DIR,
    architectureHash: null,
    runtimePlanHash: "test-plan-hash",
    plan,
    nonce,
    capability,
    supervisorUrl: SUPERVISOR!.url,
    workerPrivateKeyPem: WORKER_KEY.privateKeyPem,
    totalTimeoutMs: 120000,
  });
  return { envelope, sha, executionId, nonce };
}

// ===========================================================================
// Test fixture — start the substrate supervisor (Phase 18X)
// ===========================================================================

// Phase 18X: the supervisor is a TRUSTED mini-service that holds the launcher
// key in memory. The worker module POSTs to it. The test starts ONE
// supervisor for the whole suite (the supervisor is stateless across
// /execute calls — each call gets a fresh substrate).

SUPERVISOR = await startTestSupervisor();
LAUNCHER_PUBLIC_KEY = SUPERVISOR.launcherPublicKey;
console.log(`[wiring-test] Supervisor started at ${SUPERVISOR.url} (launcher key file deleted: ${SUPERVISOR.launcherKeyFilePath})`);

// ===========================================================================
// TEST 1 — orchestrator runs inside the substrate (real HTTP server)
// ===========================================================================
// The orchestrator must start the test app inside the substrate, wait for
// the port, run the health check, and report passed=true. The attestation
// must be non-null.

{
  const { envelope, executionId, nonce } = await runVerification({});
  const att = envelope.substrateAttestation;
  const attNonNull = att !== null && att !== undefined;
  const factsValid = attNonNull ? verifySubstrateAttestation(att).valid : false;
  const launcherResult = attNonNull ? verifyLauncherAttestation(att, LAUNCHER_PUBLIC_KEY, nonce, executionId).valid : false;
  const healthPassed = envelope.healthChecks.length > 0 && envelope.healthChecks[0].passed;
  const passedBool = envelope.passed;
  const ok = attNonNull && factsValid && launcherResult && healthPassed && passedBool;
  const details = !attNonNull
    ? "substrateAttestation is null"
    : !factsValid
      ? `facts invalid: ${verifySubstrateAttestation(att).reasons.slice(0, 2).join("; ")}`
      : !launcherResult
        ? `launcher signature invalid`
        : `healthPassed=${healthPassed} envelopePassed=${passedBool} attestation.substrateType=${att.substrateType}`;
  record(
    "Test 1: orchestrator runs inside the substrate (real HTTP server, real health check, real attestation)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 2 — attestation is real (NOT null) and launcher signature is valid
// ===========================================================================
// The substrate attestation must be present, the launcher signature must
// verify against the pinned launcher public key, the namespace inodes must
// be valid (not host sentinels), and seccompMode must be 2.

{
  const { envelope, executionId, nonce } = await runVerification({});
  const att = envelope.substrateAttestation;
  const factsResult = verifySubstrateAttestation(att);
  const launcherResult = verifyLauncherAttestation(att, LAUNCHER_PUBLIC_KEY, nonce, executionId);
  const nsValid =
    att &&
    att.userNamespaceInode &&
    att.pidNamespaceInode &&
    att.netNamespaceInode &&
    att.mntNamespaceInode;
  const seccompValid = att && att.seccompMode === 2;
  const seccompHashValid = att && att.seccompProfileHash === REQUIRED_SECCOMP_PROFILE_HASH;
  const ok =
    att !== null &&
    factsResult.valid &&
    launcherResult.valid &&
    !!nsValid &&
    !!seccompValid &&
    !!seccompHashValid;
  const details = !att
    ? "attestation is null"
    : `facts.valid=${factsResult.valid} launcher.valid=${launcherResult.valid} nsValid=${!!nsValid} seccompMode=${att.seccompMode} hashValid=${!!seccompHashValid}`;
  record(
    "Test 2: attestation is real (non-null) — launcher signature valid, namespace inodes valid, seccompMode=2",
    ok,
    details
  );
}

// ===========================================================================
// TEST 3 — envelope is properly signed by the worker's Ed25519 key
// ===========================================================================
// verifyEvidenceEnvelope(envelope, workerPublicKey) must return true. The
// envelope hash must match (no field tampering) and the Ed25519 signature
// must verify against the worker's registered public key.

{
  const { envelope } = await runVerification({});
  const sigValid = verifyEvidenceEnvelope(envelope, WORKER_KEY.publicKeyPem);
  // Negative control: verify with a DIFFERENT worker key should fail.
  const otherWorker = generateWorkerKeyPair("other-worker");
  const sigInvalidForOther = !verifyEvidenceEnvelope(envelope, otherWorker.publicKeyPem);
  const ok = sigValid && sigInvalidForOther;
  const details = `sigValid=${sigValid} rejectsOtherKey=${sigInvalidForOther}`;
  record(
    "Test 3: envelope is properly signed by the worker's Ed25519 key (and rejects other keys)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 4 — attestation is bound to the execution (executionId + nonce match)
// ===========================================================================
// att.executionId === job.executionId, att.nonce === job.nonce. This binds
// the attestation to a specific execution — preventing replay across
// executions.

{
  const { envelope, executionId, nonce } = await runVerification({});
  const att = envelope.substrateAttestation;
  const execMatch = att && att.executionId === executionId;
  const nonceMatch = att && att.nonce === nonce;
  // Verify the launcher verifier enforces this binding.
  const launcherOk = verifyLauncherAttestation(att, LAUNCHER_PUBLIC_KEY, nonce, executionId).valid;
  // Negative: wrong executionId should be rejected.
  const wrongExec = verifyLauncherAttestation(att, LAUNCHER_PUBLIC_KEY, nonce, "wrong-exec-" + randomUUID());
  const wrongExecRejected = !wrongExec.valid;
  // Negative: wrong nonce should be rejected.
  const wrongNonce = verifyLauncherAttestation(att, LAUNCHER_PUBLIC_KEY, "wrong-nonce-" + randomUUID(), executionId);
  const wrongNonceRejected = !wrongNonce.valid;
  const ok = !!execMatch && !!nonceMatch && launcherOk && wrongExecRejected && wrongNonceRejected;
  const details = `execMatch=${execMatch} nonceMatch=${nonceMatch} launcherOk=${launcherOk} wrongExecRejected=${wrongExecRejected} wrongNonceRejected=${wrongNonceRejected}`;
  record(
    "Test 4: attestation is bound to the execution (executionId + nonce match; wrong values rejected)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 5 — workload results are in the attestation (exitCode + stdoutHash)
// ===========================================================================
// att.workloadExitCode matches the orchestrator's exit code (0 on success).
// att.workloadStdoutHash matches SHA-256 of the orchestrator's stdout
// (captured in envelope.logs).

{
  const { envelope } = await runVerification({});
  const att = envelope.substrateAttestation;
  // The orchestrator writes nothing to stdout — just to results.json. The
  // launcher captures the empty stdout. workloadStdoutHash = SHA-256("").
  // But to make this test more meaningful, we also verify the hash matches
  // SHA-256 of envelope.logs (which is the orchestrator's stdout, truncated).
  const expectedStdoutHash = createHash("sha256").update(envelope.logs).digest("hex");
  const stdoutHashMatch = att && att.workloadStdoutHash === expectedStdoutHash;
  const exitCodeMatch = att && att.workloadExitCode === 0; // orchestrator exited 0 on success
  const ok = !!stdoutHashMatch && !!exitCodeMatch;
  const details = `workloadStdoutHash=${att?.workloadStdoutHash.slice(0, 16)}... expected=${expectedStdoutHash.slice(0, 16)}... match=${stdoutHashMatch} exitCode=${att?.workloadExitCode}`;
  record(
    "Test 5: workload results bound in attestation (exitCode matches, stdoutHash matches SHA-256 of orchestrator stdout)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 6 — failed app (wrong port) → failed result, but attestation present
// ===========================================================================
// If the app listens on a different port than the plan expects, the port
// wait times out, the result is passed=false, failureReason mentions startup,
// BUT the attestation is still present (the substrate ran, the workload
// just failed). This proves fail-closed for the workload WITHOUT fabricating
// the attestation.

{
  // App listens on 3001, plan expects 3000 — startup will fail.
  const { envelope } = await runVerification({ portOverride: 3001, port: 3000 });
  const att = envelope.substrateAttestation;
  const attNonNull = att !== null && att !== undefined;
  const passedBool = envelope.passed === false;
  const failureMentionsStartup =
    !!envelope.failureReason &&
    (envelope.failureReason.toLowerCase().includes("startup") ||
      envelope.failureReason.toLowerCase().includes("port") ||
      envelope.failureReason.toLowerCase().includes("not reachable"));
  // The attestation's launcher signature must STILL be valid — the substrate
  // ran, the workload just failed.
  const factsValid = attNonNull ? verifySubstrateAttestation(att).valid : false;
  const ok = attNonNull && passedBool && failureMentionsStartup && factsValid;
  const details = `attNonNull=${attNonNull} passed=${envelope.passed} failureReason="${envelope.failureReason}" factsValid=${factsValid}`;
  record(
    "Test 6: failed app (wrong port) → failed result + failureReason mentions startup, but attestation STILL present (substrate ran)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 7 — no null attestation path: supervisor rejects missing capability
// ===========================================================================
// Phase 18X: the supervisor verifies the ExecutionCapability before running
// the substrate. If the worker POSTs without a capability, the supervisor
// rejects with HTTP 403, and executeRuntimeVerificationInWorker THROWS —
// it NEVER returns an envelope with substrateAttestation=null. Test by
// omitting the capability.

{
  let threw = false;
  let threwWithMessage = "";
  let returnedNullAtt = false;
  try {
    const result = await runVerification({ omitCapability: true });
    if (result.envelope.substrateAttestation === null) {
      returnedNullAtt = true;
    }
  } catch (err: any) {
    threw = true;
    threwWithMessage = err && err.message ? err.message : String(err);
  }
  const ok = threw && !returnedNullAtt;
  const details = threw
    ? `threw: ${threwWithMessage.slice(0, 200)}`
    : returnedNullAtt
      ? "RETURNED envelope with substrateAttestation=null — CRITICAL invariant violation"
      : "returned envelope (did not throw)";
  record(
    "Test 7: no null-attestation path — supervisor rejects missing capability, executeRuntimeVerificationInWorker THROWS",
    ok,
    details
  );
}

// ===========================================================================
// TEST 8 — orchestrator handles a real app with all stages
// ===========================================================================
// Use a real app with install + build + start + health check stages. All
// stages must produce results in the envelope.

{
  const sha = setupTestApp();
  const executionId = randomUUID();
  const nonce = generateSubstrateNonce();
  const plan = makePlan(3000);
  const capability = SUPERVISOR!.signCapability({
    executionId,
    nonce,
    leaseId: "lease-1",
    repositoryHeadSha: sha,
    runtimePlanHash: "test-plan-hash",
    architectureHash: null,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });
  const envelope = await executeRuntimeVerificationInWorker({
    executionId,
    workerId: "wiring-test-worker",
    leaseId: "lease-1",
    repositoryHeadSha: sha,
    repositoryUrl: TEST_APP_DIR,
    architectureHash: null,
    runtimePlanHash: "test-plan-hash",
    plan,
    nonce,
    capability,
    supervisorUrl: SUPERVISOR!.url,
    workerPrivateKeyPem: WORKER_KEY.privateKeyPem,
    totalTimeoutMs: 120000,
  });

  // All stages must have produced results.
  const installRan = envelope.dependencyInstallResult.success === true;
  const buildRan = envelope.buildResult.success === true;
  const startupRan = envelope.startupResult.success === true;
  const healthRan = envelope.healthChecks.length === 1 && envelope.healthChecks[0].passed === true;
  const teardownRan = envelope.teardownResult.success === true;
  const allStagesHaveResults = installRan && buildRan && startupRan && healthRan && teardownRan;

  // The attestation must be non-null and trusted.
  const attNonNull = envelope.substrateAttestation !== null;
  const trusted = attNonNull && isSubstrateTrusted(envelope.substrateAttestation, LAUNCHER_PUBLIC_KEY, nonce, executionId);

  // The envelope signature must verify.
  const sigValid = verifyEvidenceEnvelope(envelope, WORKER_KEY.publicKeyPem);

  const ok = allStagesHaveResults && attNonNull && trusted && sigValid;
  const details = `install=${installRan} build=${buildRan} startup=${startupRan} health=${healthRan} teardown=${teardownRan} attNonNull=${attNonNull} trusted=${trusted} sigValid=${sigValid}`;
  record(
    "Test 8: orchestrator handles a real app — all stages produce results, attestation trusted, envelope signed",
    ok,
    details
  );
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n=== worker-runtime-wiring-invariants ===\n");
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  if (!r.passed) {
    console.log(`  ${r.details}`);
  }
}
console.log(`\n=== worker-runtime-wiring-invariants: ${passed} passed, ${failed} failed ===`);
if (SUPERVISOR) {
  await SUPERVISOR.stop();
}
if (failed > 0) {
  console.log("\n❌ WORKER RUNTIME WIRING INVARIANTS NOT SATISFIED — null attestation stub may still be present");
  process.exit(1);
} else {
  console.log("\n✅ Worker runtime wiring enforced — real substrate attestation, no null stub");
  process.exit(0);
}
