// Forge — Phase 18X-C: E2E Launcher Key Isolation Invariants.
//
// This is the DEFINITIVE END-TO-END acceptance test for Phase 18X. It
// exercises the FULL path:
//
//   control-plane capability (Ed25519-signed)
//       ↓
//   worker (relays capability — has ONLY its worker key, NEVER the launcher key)
//       ↓
//   substrate supervisor (TRUSTED — verifies capability, holds launcher key IN MEMORY)
//       ↓
//   substrate (real linux namespace + seccomp BPF + rlimits + cap-drop)
//       ↓
//   launcher (reads key from anonymous fd, observes kernel facts, signs with launcher Ed25519)
//       ↓
//   worker (receives signed attestation, NEVER the launcher key, builds envelope, signs with worker key)
//       ↓
//   control plane (verifies BOTH signatures + nonce + executionId binding)
//
// AND it proves the worker CANNOT forge the launcher attestation at every
// layer — even if the worker's own key is fully compromised.
//
// ARCHITECTURE UNDER TEST (the closed P0):
//
//   1. Worker env has ZERO launcher key access (no env var, no file path,
//      no field, no code path).
//   2. Launcher key file is DELETED at supervisor startup (key only in memory).
//   3. Supervisor NEVER returns the launcher key in any response.
//   4. Supervisor rejects unsigned / tampered / expired / missing capabilities.
//   5. Attestation is bound to the capability's nonce + executionId (anti-replay).
//   6. Attestation's workload output is signed by the launcher (output binding).
//   7. Tampering with the attestation breaks the worker envelope signature.
//   8. Real substrate isolation is proven (namespace inodes differ from host).
//   9. Failed workloads still produce valid attestations (substrate ran, app failed).
//  10. Production predicate requires trusted substrate attestation.
//  11. Capability cannot be replayed across executions.
//
// Run with: bun run tests/e2e-launcher-key-isolation-invariants.ts

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readlinkSync } from "node:fs";
import {
  randomUUID,
  generateKeyPairSync,
  sign as cryptoSign,
  createHash,
} from "node:crypto";

import {
  verifyLauncherAttestation,
  isSubstrateTrusted,
  generateLauncherKeyPair,
  REQUIRED_SECCOMP_PROFILE_HASH,
  type SandboxAttestation,
} from "@/lib/substrate-attestation";
import {
  signExecutionCapability,
  verifyExecutionCapability,
  deriveWorkloadFromPlan,
  computeWorkloadHash,
  type ExecutionCapability,
  type ExecutionCapabilityInput,
} from "@/lib/execution-capability";
import {
  generateWorkerKeyPair,
  verifyEvidenceEnvelope,
  computeEnvelopeHash,
  computeResultHash,
  signEvidenceEnvelope,
  type ExecutionEvidenceEnvelope,
} from "@/lib/runtime-execution-contract";
import {
  canReachProductionReadyWithRuntime,
  getProductionReadinessFailureReason,
  type ProductionReadinessEvidence,
} from "@/lib/runtime-verification";
import { getHostNamespaceInodes } from "@/lib/substrate-namespace";
import { executeRuntimeVerificationInWorker, generateSubstrateNonce } from "../mini-services/execution-worker/runtime/verify.js";
import { startTestSupervisor, type TestSupervisor } from "./lib/test-supervisor.js";
import { setupTestRepo as setupTestRepoHelper, setupTestWorkspace, makeTestPlan } from "./lib/test-capability.js";

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

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

// ===========================================================================
// Test fixtures — minimal Node.js HTTP server apps (real git repo, real SHA)
// ===========================================================================

const TEST_APP_DIR = "/tmp/forge-e2e-launcher-iso-test-app";
const CRASH_APP_DIR = "/tmp/forge-e2e-launcher-iso-crash-app";

function setupTestApp(): string {
  // Phase 18Y: setupTestApp returns the SHA only (the caller uses TEST_APP_DIR
  // as both the repoPath and the repositoryUrl). This is used by tests that
  // call executeRuntimeVerificationInWorker (which clones TEST_APP_DIR into
  // its own workspace, so the workspace/repo layout is correct).
  return setupTestRepoHelper(TEST_APP_DIR);
}

function setupCrashingApp(): string {
  rmSync(CRASH_APP_DIR, { recursive: true, force: true });
  mkdirSync(CRASH_APP_DIR, { recursive: true });
  // server.js exits immediately — the orchestrator's port-wait will fail.
  const serverJs = `process.stderr.write("CRASHING_ON_PURPOSE\\n"); process.exit(1);`;
  writeFileSync(join(CRASH_APP_DIR, "server.js"), serverJs);
  writeFileSync(join(CRASH_APP_DIR, "package.json"), JSON.stringify({
    name: "forge-e2e-launcher-iso-crash-app",
    version: "1.0.0",
    scripts: { start: "node server.js" },
  }, null, 2));
  execFileSync("git", ["init"], { cwd: CRASH_APP_DIR, shell: false });
  execFileSync("git", ["config", "user.email", "test@forge"], { cwd: CRASH_APP_DIR, shell: false });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: CRASH_APP_DIR, shell: false });
  execFileSync("git", ["add", "."], { cwd: CRASH_APP_DIR, shell: false });
  execFileSync("git", ["commit", "-m", "init"], { cwd: CRASH_APP_DIR, shell: false });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: CRASH_APP_DIR, encoding: "utf-8", shell: false,
  }).trim();
}

function makePlan(port: number = 3000) {
  return makeTestPlan(port);
}

// ===========================================================================
// Start ONE substrate supervisor for the whole suite.
// ===========================================================================
//
// Phase 18X: the supervisor is a TRUSTED mini-service that holds the launcher
// key IN MEMORY (file deleted at startup). The worker module POSTs to it. The
// test-supervisor helper generates a launcher keypair, writes the private key
// to a temp file, spawns the supervisor with FORGE_LAUNCHER_KEY_FILE pointing
// at it, and the supervisor reads + DELETES the file before serving /health.

const SUPERVISOR: TestSupervisor = await startTestSupervisor();
const LAUNCHER_PUBLIC_KEY = SUPERVISOR.launcherPublicKey;
const WORKER_KEY = generateWorkerKeyPair("e2e-launcher-iso-worker");
console.log(
  `[e2e-test] Supervisor started at ${SUPERVISOR.url} ` +
  `(launcher key file deleted at startup: ${SUPERVISOR.launcherKeyFilePath})`
);

// ===========================================================================
// Helper: run executeRuntimeVerificationInWorker with the standard test config.
// ===========================================================================

async function runVerification(opts: {
  executionId?: string;
  nonce?: string;
  port?: number;
  crashing?: boolean;
} = {}): Promise<{
  envelope: ExecutionEvidenceEnvelope;
  sha: string;
  executionId: string;
  nonce: string;
}> {
  const useCrashApp = opts.crashing === true;
  const sha = useCrashApp ? setupCrashingApp() : setupTestApp();
  const executionId = opts.executionId || randomUUID();
  const nonce = opts.nonce || generateSubstrateNonce();
  const port = opts.port || 3000;
  const plan = makePlan(port);
  // Phase 18Y: the capability MUST include the full runtimePlan +
  // workloadHash. The supervisor DERIVES the workload from cap.runtimePlan
  // and verifies workloadHash matches.
  const capability = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId: "lease-e2e-iso",
    repositoryHeadSha: sha,
    runtimePlanHash: "e2e-iso-plan-hash",
    architectureHash: null,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });
  const envelope = await executeRuntimeVerificationInWorker({
    executionId,
    workerId: "e2e-launcher-iso-worker",
    leaseId: "lease-e2e-iso",
    repositoryHeadSha: sha,
    repositoryUrl: useCrashApp ? CRASH_APP_DIR : TEST_APP_DIR,
    architectureHash: null,
    runtimePlanHash: "e2e-iso-plan-hash",
    plan,
    nonce,
    capability,
    supervisorUrl: SUPERVISOR.url,
    workerPrivateKeyPem: WORKER_KEY.privateKeyPem,
    totalTimeoutMs: 120000,
  });
  return { envelope, sha, executionId, nonce };
}

// ===========================================================================
// TEST 1 — FULL E2E: control-plane → worker → supervisor → substrate → attestation → verification
// ===========================================================================
//
// The complete happy path: a worker with an Ed25519 key calls
// executeRuntimeVerificationInWorker with a control-plane-signed capability.
// The worker POSTs { capability, workload, repoPath } to the supervisor. The
// supervisor verifies the capability signature, runs runInSubstrate with the
// launcher key from MEMORY, and returns the signed attestation. The worker
// wraps it in an Ed25519-signed envelope.
//
// ALL of the following must hold:
//   - envelope.substrateAttestation is non-null.
//   - verifyEvidenceEnvelope(envelope, workerPublicKey) === true.
//   - verifyLauncherAttestation(att, launcherPublicKey, nonce, executionId).valid === true.
//   - isSubstrateTrusted(att, launcherPublicKey, nonce, executionId) === true.
//   - envelope.passed === true (the test app's /health returned 200).
//   - att.executionId === capability.executionId (binding to capability).
//   - att.nonce === capability.nonce (binding to capability).

let test1Envelope: ExecutionEvidenceEnvelope | null = null;
let test1ExecutionId = "";
let test1Nonce = "";
let test1Capability: ExecutionCapability | null = null;

{
  const { envelope, executionId, nonce } = await runVerification();
  test1Envelope = envelope;
  test1ExecutionId = executionId;
  test1Nonce = nonce;

  // Reconstruct the capability (the test-supervisor signed it; we can re-derive
  // by inspecting envelope.substrateAttestation.executionId/nonce which must
  // match the capability). We don't have the capability object here, but we
  // can construct one for use in later tests.
  test1Capability = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId: "lease-e2e-iso",
    repositoryHeadSha: envelope.repositoryHeadSha,
    runtimePlanHash: envelope.runtimePlanHash,
    architectureHash: envelope.architectureHash,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });

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

  const ok =
    attNonNull &&
    sigValid &&
    launcherResult.valid &&
    trusted &&
    passedBool &&
    execMatch &&
    nonceMatch;
  const details = !attNonNull
    ? "substrateAttestation is null"
    : `sigValid=${sigValid} launcherValid=${launcherResult.valid} trusted=${trusted} ` +
      `passed=${envelope.passed} execMatch=${execMatch} nonceMatch=${nonceMatch}`;
  record(
    "Test 1: FULL E2E — control-plane → worker → supervisor → substrate → attestation → verification",
    ok,
    details
  );
}

// ===========================================================================
// TEST 2 — Worker CANNOT forge the launcher signature (no key access)
// ===========================================================================
//
// A compromised worker might try to forge the launcher signature by signing
// canonicalFactsJson with the WORKER's private key (which it has). The control
// plane verifies against the LAUNCHER's public key, so the signature won't
// validate (launcher key ≠ worker key). This proves: even if the worker's own
// key is fully compromised, it CANNOT forge the launcher attestation because
// it doesn't have the launcher key.

{
  if (!test1Envelope || !test1Envelope.substrateAttestation) {
    record(
      "Test 2: worker CANNOT forge the launcher signature (sign canonicalFactsJson with worker key — launcher key ≠ worker key)",
      false,
      "test1Envelope or attestation is null — cannot run forgery test"
    );
  } else {
    const orig = test1Envelope.substrateAttestation;
    // Sign canonicalFactsJson with the WORKER's private key (simulating a
    // compromised worker that has its own key but NOT the launcher key).
    const data = Buffer.from(orig.canonicalFactsJson, "utf-8");
    const forgedSig = cryptoSign(null, data, WORKER_KEY.privateKeyPem).toString("hex");
    const forged: SandboxAttestation = {
      ...orig,
      launcherSignature: forgedSig,
    };
    const launcherResult = verifyLauncherAttestation(
      forged,
      LAUNCHER_PUBLIC_KEY,
      test1Nonce,
      test1ExecutionId
    );
    const trusted = isSubstrateTrusted(
      forged,
      LAUNCHER_PUBLIC_KEY,
      test1Nonce,
      test1ExecutionId
    );
    const ok = !launcherResult.valid && !trusted;
    const details =
      `forgedValid=${launcherResult.valid} (must be false — worker key ≠ launcher key) ` +
      `trusted=${trusted} reasons=${launcherResult.reasons.slice(0, 2).join("; ")}`;
    record(
      "Test 2: worker CANNOT forge the launcher signature (worker key ≠ launcher key — P0 closed)",
      ok,
      details
    );
  }
}

// ===========================================================================
// TEST 3 — Worker env has NO launcher key (the P0 source-inspection proof)
// ===========================================================================
//
// Source inspection — the worker has ZERO access to the launcher key:
//   - poller.ts: no FORGE_LAUNCHER_KEY_FILE read (only in comments).
//   - runtime/verify.ts: no launcherKeyFile parameter, no readFileSync for the
//     launcher key, no "PRIVATE KEY" import for the launcher.
//   - start-worker.sh: FORGE_LAUNCHER_KEY_FILE is NOT set (only in comments).
//   - RuntimeExecutionPolicy type has NO launcherKeyFile field.
//   - runInSubstrate takes launcherKeyPem (string), NOT launcherKeyFile (path).

{
  const poller = readFile("mini-services/execution-worker/poller.ts");
  // Strip comments before checking for FORGE_LAUNCHER_KEY_FILE references —
  // comments are documentation only, not executable code paths.
  const pollerStripped = poller
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const pollerHasLauncherKeyFileInCode = pollerStripped.includes("FORGE_LAUNCHER_KEY_FILE") ||
    pollerStripped.includes("LAUNCHER_KEY_FILE");

  const verify = readFile("mini-services/execution-worker/runtime/verify.ts");
  const verifyStripped = verify
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const verifyHasLauncherKeyFileParam =
    verifyStripped.includes("launcherKeyFile:") ||
    verifyStripped.includes("launcherKeyFile?") ||
    verifyStripped.includes("launcherKeyFile =");
  const verifyReadsLauncherKeyFromFile = /readFileSync\([^)]*launcher/i.test(verifyStripped);
  // The worker must NEVER handle the launcher PEM directly. After stripping
  // comments, the source must not contain the "PRIVATE KEY" marker (which
  // would indicate the worker is parsing/importing/validating a launcher
  // PEM somewhere). It also must not import any module that exports the
  // launcher private key.
  const verifyHandlesLauncherPem = verifyStripped.includes("PRIVATE KEY");
  const verifyImportsLauncherKey = /from\s+["'][^"']*launcher[^"']*private[^"']*["]/i.test(verifyStripped);

  const startSh = readFile("mini-services/execution-worker/start-worker.sh");
  const startShStripped = startSh
    .replace(/#.*/g, "");
  const startShSetsLauncherKeyFile = /\bFORGE_LAUNCHER_KEY_FILE\s*[:=]/.test(startShStripped);

  const contract = readFile("src/lib/runtime-execution-contract.ts");
  const contractHasLauncherKeyFileField =
    contract.includes("launcherKeyFile:") ||
    contract.includes("launcherKeyFile?") ||
    contract.includes("launcherKeyFile =");

  const substrateNs = readFile("src/lib/substrate-namespace.ts");
  const runInSubstrateTakesKeyPem = /runInSubstrate[\s\S]{0,800}launcherKeyPem\s*:/.test(substrateNs);
  const runInSubstrateTakesKeyFile = /runInSubstrate[\s\S]{0,800}launcherKeyFile\s*:/.test(substrateNs);

  const ok =
    !pollerHasLauncherKeyFileInCode &&
    !verifyHasLauncherKeyFileParam &&
    !verifyReadsLauncherKeyFromFile &&
    !verifyHandlesLauncherPem &&
    !verifyImportsLauncherKey &&
    !startShSetsLauncherKeyFile &&
    !contractHasLauncherKeyFileField &&
    runInSubstrateTakesKeyPem &&
    !runInSubstrateTakesKeyFile;
  const details =
    `pollerHasLauncherKeyFileInCode=${pollerHasLauncherKeyFileInCode} ` +
    `verifyHasLauncherKeyFileParam=${verifyHasLauncherKeyFileParam} ` +
    `verifyReadsLauncherKeyFromFile=${verifyReadsLauncherKeyFromFile} ` +
    `verifyHandlesLauncherPem=${verifyHandlesLauncherPem} ` +
    `verifyImportsLauncherKey=${verifyImportsLauncherKey} ` +
    `startShSetsLauncherKeyFile=${startShSetsLauncherKeyFile} ` +
    `contractHasLauncherKeyFileField=${contractHasLauncherKeyFileField} ` +
    `runInSubstrateTakesKeyPem=${runInSubstrateTakesKeyPem} ` +
    `runInSubstrateTakesKeyFile=${runInSubstrateTakesKeyFile}`;
  record(
    "Test 3: worker env has NO launcher key access (source inspection — P0 architectural closure)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 4 — Launcher key file is DELETED at supervisor startup
// ===========================================================================
//
// The supervisor reads the launcher key into memory and DELETES the file at
// startup. After the supervisor is ready (/health returns 200), the file MUST
// NOT exist on disk. The key is ONLY in the supervisor's process memory.

{
  // The main supervisor was started above with startTestSupervisor which
  // writes the launcher key to a temp file then spawns the supervisor. By the
  // time startTestSupervisor returns, /health has returned 200 — meaning the
  // supervisor has finished startup (including the file deletion).
  const fileStillExists = existsSync(SUPERVISOR.launcherKeyFilePath);
  const ok = !fileStillExists;
  const details = fileStillExists
    ? `launcher key file STILL EXISTS at ${SUPERVISOR.launcherKeyFilePath} — VIOLATION (supervisor should have deleted it at startup)`
    : `launcher key file deleted at startup: ${SUPERVISOR.launcherKeyFilePath}`;
  record(
    "Test 4: launcher key file is DELETED at supervisor startup (key only in memory)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 5 — Supervisor NEVER returns the launcher key
// ===========================================================================
//
// Phase 18Y: POST /execute with a valid capability + repoPath (NO workload
// field — the supervisor derives it from cap.runtimePlan). The response
// body must NOT contain "PRIVATE KEY" (the launcher key PEM marker). The
// response must contain an attestation with launcherSignature but NOT the
// launcher key PEM.

{
  const { repoPath, sha } = setupTestWorkspace("e2e-iso-5");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const plan = makePlan(3000);
  const cap = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId: "lease-1",
    repositoryHeadSha: sha,
    runtimePlanHash: "plan-hash",
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
  const respText = await resp.text();
  const containsPrivateKey = respText.includes("PRIVATE KEY");
  const containsLauncherKeyPemPrefix =
    SUPERVISOR.launcherPrivateKey.length > 0 &&
    respText.includes(SUPERVISOR.launcherPrivateKey.slice(0, 50));
  let hasAttestation = false;
  let hasLauncherSignature = false;
  try {
    const body = JSON.parse(respText) as { attestation?: { launcherSignature?: string } };
    hasAttestation = !!body.attestation;
    hasLauncherSignature = !!(body.attestation && body.attestation.launcherSignature);
  } catch { /* ignore parse errors */ }
  const ok =
    resp.status === 200 &&
    !containsPrivateKey &&
    !containsLauncherKeyPemPrefix &&
    hasAttestation &&
    hasLauncherSignature;
  const details =
    `status=${resp.status} containsPrivateKey=${containsPrivateKey} ` +
    `containsLauncherKeyPemPrefix=${containsLauncherKeyPemPrefix} ` +
    `hasAttestation=${hasAttestation} hasLauncherSignature=${hasLauncherSignature}`;
  record(
    "Test 5: supervisor NEVER returns the launcher key (response has attestation + launcherSignature, NOT the key PEM)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 6 — Supervisor rejects invalid capability (wrong signature) → HTTP 403
// ===========================================================================
//
// A capability signed by a DIFFERENT key (not the control plane's) must be
// rejected. The worker cannot forge a capability — it doesn't have the
// control plane's private key.

{
  // Sign the capability with a DIFFERENT key (not the control plane's).
  const otherKey = generateKeyPairSync("ed25519");
  const otherPrivPem = otherKey.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const { repoPath, sha } = setupTestWorkspace("e2e-iso-6");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const plan = makePlan(3000);
  const capInput: ExecutionCapabilityInput = {
    executionId,
    nonce,
    leaseId: "lease-1",
    repositoryHeadSha: sha,
    runtimePlanHash: "plan-hash",
    architectureHash: null,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
    runtimePlan: plan as unknown as Record<string, unknown>,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const forgedCap = signExecutionCapability(capInput, otherPrivPem);
  const resp = await fetch(`${SUPERVISOR.url}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: forgedCap,
      repoPath,
    }),
  });
  let detail = "";
  try {
    const errBody = await resp.json() as { error?: string; reasons?: string[] };
    detail = `${errBody.error ?? ""}: ${(errBody.reasons ?? []).slice(0, 2).join("; ")}`;
  } catch {
    detail = await resp.text();
  }
  const mentionsSigOrInvalid =
    /signature|invalid|capability/i.test(detail);
  const ok = resp.status === 403 && mentionsSigOrInvalid;
  record(
    "Test 6: supervisor rejects capability with wrong signature (HTTP 403 + error mentions signature/invalid/capability)",
    ok,
    `status=${resp.status} detail=${detail.slice(0, 200)}`
  );
}

// ===========================================================================
// TEST 7 — Supervisor rejects expired capability → HTTP 403
// ===========================================================================
//
// A capability whose expiresAt is in the past must be rejected.

{
  const { repoPath, sha } = setupTestWorkspace("e2e-iso-7");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const plan = makePlan(3000);
  const cap = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId: "lease-1",
    repositoryHeadSha: sha,
    runtimePlanHash: "plan-hash",
    architectureHash: null,
    expiresAt: new Date(Date.now() - 60000).toISOString(), // EXPIRED 60s ago
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
  let detail = "";
  try {
    const errBody = await resp.json() as { error?: string; reasons?: string[] };
    detail = `${errBody.error ?? ""}: ${(errBody.reasons ?? []).slice(0, 2).join("; ")}`;
  } catch {
    detail = await resp.text();
  }
  const mentionsExpired = /expired|expiry/i.test(detail);
  const ok = resp.status === 403 && mentionsExpired;
  record(
    "Test 7: supervisor rejects expired capability (HTTP 403 + error mentions expired)",
    ok,
    `status=${resp.status} detail=${detail.slice(0, 200)}`
  );
}

// ===========================================================================
// TEST 8 — Supervisor rejects missing capability → HTTP 403 or 400
// ===========================================================================
//
// POST /execute without a `capability` field must be rejected.
// Phase 18Y: the request body is { capability, repoPath } — no workload.
// We POST { repoPath } only (no capability).

{
  const { repoPath } = setupTestWorkspace("e2e-iso-8");
  const resp = await fetch(`${SUPERVISOR.url}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // No capability field. Phase 18Y: NO workload field either.
      repoPath,
    }),
  });
  const ok = resp.status === 403 || resp.status === 400;
  let detail = "";
  try { detail = JSON.stringify(await resp.json()); } catch { detail = await resp.text(); }
  record(
    "Test 8: supervisor rejects request with NO capability (HTTP 403 or 400)",
    ok,
    `status=${resp.status} detail=${detail.slice(0, 200)}`
  );
}

// ===========================================================================
// TEST 9 — Capability binds executionId + nonce (worker can't substitute values)
// ===========================================================================
//
// The supervisor passes the CAPABILITY's nonce + executionId to runInSubstrate,
// NOT any value from the request body. The worker cannot override these by
// sending different values in the workload. The attestation's nonce +
// executionId MUST match the capability's values.
//
// (The repoSha is bound via the control plane's submission-time check —
// the supervisor doesn't read repoSha from the request body, only from the
// capability. The repoPath is taken from the request body but that's the
// filesystem path, not the cryptographic SHA — the SHA is bound by the
// capability's repositoryHeadSha field, which the control plane verifies at
// submission time.)

{
  const { repoPath, sha } = setupTestWorkspace("e2e-iso-9");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const plan = makePlan(3000);
  const cap = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId: "lease-1",
    repositoryHeadSha: sha,
    runtimePlanHash: "plan-hash",
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
  let detail = "";
  let attExecId = "";
  let attNonce = "";
  try {
    const body = await resp.json() as { attestation?: SandboxAttestation };
    attExecId = body.attestation?.executionId ?? "";
    attNonce = body.attestation?.nonce ?? "";
  } catch (err) {
    detail = `parse failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  const ok =
    resp.status === 200 &&
    attExecId === executionId &&
    attNonce === nonce;
  const details =
    `status=${resp.status} attExecId=${attExecId.slice(0, 8)}... expectedExecId=${executionId.slice(0, 8)}... ` +
    `attNonce=${attNonce.slice(0, 8)}... expectedNonce=${nonce.slice(0, 8)}... ${detail}`;
  record(
    "Test 9: capability binds executionId + nonce (attestation matches CAPABILITY values, not request body)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 10 — Attestation output binding (launcher observed + signed the actual workload output)
// ===========================================================================
//
// Phase 18Y: the workload is ALWAYS `node /workspace/orchestrator.js`. The
// launcher observes the orchestrator's stdout + exit code, includes their
// hashes in canonicalFactsJson, and signs with the launcher key. The
// control plane can verify the launcher observed the ACTUAL output, not
// worker-claimed output.
//
// We run a real test app (server.js listening on /health) via the standard
// plan. The orchestrator's stdout is captured in `result.stdout`. The
// attestation's workloadStdoutHash MUST equal SHA-256 of that stdout.

{
  const { repoPath, sha } = setupTestWorkspace("e2e-iso-10");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const plan = makePlan(3000);
  const cap = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId: "lease-1",
    repositoryHeadSha: sha,
    runtimePlanHash: "plan-hash",
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
  const body = await resp.json() as { attestation?: SandboxAttestation; result?: { stdout?: string } };
  const att = body.attestation;
  // The orchestrator's stdout is in result.stdout. The launcher observed
  // that stdout and hashed it. Verify the hash matches.
  const orchestratorStdout = body.result?.stdout ?? "";
  const expectedStdoutHash = sha256(orchestratorStdout);
  const stdoutHashMatches = !!att && att.workloadStdoutHash === expectedStdoutHash;
  const exitCodeMatches = !!att && att.workloadExitCode === 0;
  // The launcher signature covers the workload output hash — verify it.
  const launcherValid = att
    ? verifyLauncherAttestation(att, LAUNCHER_PUBLIC_KEY, nonce, executionId).valid
    : false;
  const ok =
    resp.status === 200 &&
    stdoutHashMatches &&
    exitCodeMatches &&
    launcherValid;
  const details =
    `status=${resp.status} stdoutHashMatches=${stdoutHashMatches} ` +
    `exitCodeMatches=${exitCodeMatches} launcherValid=${launcherValid} ` +
    `actualStdoutHash=${att?.workloadStdoutHash ?? "(none)"} expected=${expectedStdoutHash} ` +
    `actualExitCode=${att?.workloadExitCode ?? "(none)"}`;
  record(
    "Test 10: attestation output binding (workloadStdoutHash = SHA-256 of orchestrator stdout; launcher signed it)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 11 — Tampered attestation breaks the worker envelope signature
// ===========================================================================
//
// Take the valid envelope from test 1. Change substrateAttestation.workloadExitCode
// from 0 to 1. The worker's envelope signature is over the envelope hash,
// which includes the attestation — so tampering with the attestation (without
// recomputing + re-signing) MUST break verifyEvidenceEnvelope.

{
  if (!test1Envelope || !test1Envelope.substrateAttestation) {
    record(
      "Test 11: tampered attestation breaks the worker envelope signature",
      false,
      "test1Envelope or attestation is null — cannot run tamper test"
    );
  } else {
    // Deep-clone the envelope (JSON round-trip is sufficient for our purposes).
    const tampered: ExecutionEvidenceEnvelope = JSON.parse(JSON.stringify(test1Envelope));
    // Tamper with the attestation's workloadExitCode (was 0 → now 1).
    const originalExitCode = tampered.substrateAttestation!.workloadExitCode;
    tampered.substrateAttestation!.workloadExitCode = originalExitCode === 0 ? 1 : 0;
    // Do NOT recompute resultHash / envelopeHash / signature — the worker's
    // original signature is over the ORIGINAL envelope hash.
    const sigStillValid = verifyEvidenceEnvelope(tampered, WORKER_KEY.publicKeyPem);
    const ok = !sigStillValid;
    const details =
      `sigStillValid=${sigStillValid} (must be false) ` +
      `originalExitCode=${originalExitCode} tamperedExitCode=${tampered.substrateAttestation!.workloadExitCode}`;
    record(
      "Test 11: tampered attestation breaks the worker envelope signature (attestation is Ed25519-bound into the envelope)",
      ok,
      details
    );
  }
}

// ===========================================================================
// TEST 12 — Real substrate isolation in the E2E path
// ===========================================================================
//
// From the valid E2E run (test 1), prove the substrate actually entered a
// real isolation boundary:
//   - attestation.userNamespaceInode differs from the host's user namespace inode.
//   - seccompMode === 2 (strict).
//   - seccompProfileHash === REQUIRED_SECCOMP_PROFILE_HASH.
//   - networkMode === "hermetic-loopback".

{
  if (!test1Envelope || !test1Envelope.substrateAttestation) {
    record(
      "Test 12: real substrate isolation in the E2E path (namespace inodes differ from host, seccomp, hermetic net)",
      false,
      "test1Envelope or attestation is null — cannot run isolation test"
    );
  } else {
    const att = test1Envelope.substrateAttestation;
    const hostUserInode = (() => { try { return readlinkSync("/proc/self/ns/user") ?? ""; } catch { return ""; } })();
    const userNsDiffers = !!att.userNamespaceInode && att.userNamespaceInode !== hostUserInode;
    const seccompModeOk = att.seccompMode === 2;
    const seccompHashOk = att.seccompProfileHash === REQUIRED_SECCOMP_PROFILE_HASH;
    const netModeOk = att.networkMode === "hermetic-loopback";
    const ok = userNsDiffers && seccompModeOk && seccompHashOk && netModeOk;
    const details =
      `userNsDiffers=${userNsDiffers} (att=${att.userNamespaceInode} host=${hostUserInode}) ` +
      `seccompModeOk=${seccompModeOk} (mode=${att.seccompMode}) ` +
      `seccompHashOk=${seccompHashOk} ` +
      `netModeOk=${netModeOk} (mode=${att.networkMode})`;
    record(
      "Test 12: real substrate isolation in the E2E path (namespace inodes differ from host, seccompMode=2, profile hash matches, hermetic-loopback)",
      ok,
      details
    );
  }
}

// ===========================================================================
// TEST 13 — Failed app still produces a valid (trusted) attestation
// ===========================================================================
//
// Create a test app that crashes on start (exits immediately). Run
// executeRuntimeVerificationInWorker. The substrate ran correctly (the
// attestation is still valid + trusted), but the workload failed
// (envelope.passed === false). This proves: a failed workload does NOT
// invalidate the substrate attestation — the substrate ran, the workload
// just happened to fail.

{
  let envelope: ExecutionEvidenceEnvelope | null = null;
  let runErr: Error | null = null;
  try {
    const res = await runVerification({ crashing: true });
    envelope = res.envelope;
  } catch (err) {
    runErr = err instanceof Error ? err : new Error(String(err));
  }
  if (!envelope) {
    record(
      "Test 13: failed app still produces a valid (trusted) attestation (substrate ran, workload failed)",
      false,
      `runVerification threw: ${runErr?.message ?? "(unknown)"}`
    );
  } else {
    const att = envelope.substrateAttestation;
    const attNonNull = att !== null && att !== undefined;
    const passedBool = envelope.passed === false; // workload MUST fail
    const trusted = attNonNull
      ? isSubstrateTrusted(att, LAUNCHER_PUBLIC_KEY, envelope.executionId, envelope.executionId)
      : false;
    // For test 13, we used a fresh executionId/nonce via runVerification.
    // We need the nonce — the envelope's attestation carries it. Use that
    // for the launcher verification.
    const actualNonce = att?.nonce ?? "";
    const actualExecId = att?.executionId ?? "";
    const trustedWithCorrectBinding = attNonNull
      ? isSubstrateTrusted(att, LAUNCHER_PUBLIC_KEY, actualNonce, actualExecId)
      : false;
    const ok = attNonNull && passedBool && trustedWithCorrectBinding;
    const details =
      `attNonNull=${attNonNull} passed=${envelope.passed} (must be false) ` +
      `trustedWithCorrectBinding=${trustedWithCorrectBinding} ` +
      `trustedUsingEnvelopeExecId=${trusted} (sanity, may be false if execId mismatch) ` +
      `failureReason=${(envelope.failureReason ?? "").slice(0, 80)}`;
    record(
      "Test 13: failed app still produces a valid (trusted) attestation (substrate ran, workload failed)",
      ok,
      details
    );
  }
}

// ===========================================================================
// TEST 14 — Production predicate requires trusted substrate
// ===========================================================================
//
// Construct ProductionReadinessEvidence:
//   - With executionEnvironmentSandboxed: false → canReachProductionReadyWithRuntime returns false.
//   - With executionEnvironmentSandboxed: true + substrateAttestationVerified: true + all
//     other conditions true → returns true.
//   - With executionEnvironmentSandboxed: false → getProductionReadinessFailureReason
//     mentions "substrate" or "attestation" or "sandboxed".

{
  const allTrue: ProductionReadinessEvidence = {
    architectureFrozen: true,
    allTasksCompleted: true,
    allTasksIntegrated: true,
    staticReadinessPassed: true,
    runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true,
    executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
    repositoryHeadVerified: true,
  };
  const withoutTrust: ProductionReadinessEvidence = {
    ...allTrue,
    executionEnvironmentSandboxed: false,
    substrateAttestationVerified: false,
  };
  const allTruePasses = canReachProductionReadyWithRuntime(allTrue);
  const withoutTrustFails = !canReachProductionReadyWithRuntime(withoutTrust);
  const failureReason = getProductionReadinessFailureReason(withoutTrust) ?? "";
  const reasonMentionsTrust =
    /substrate|attestation|sandboxed|unsandboxed/i.test(failureReason);
  const ok = allTruePasses && withoutTrustFails && reasonMentionsTrust;
  const details =
    `allTruePasses=${allTruePasses} withoutTrustFails=${withoutTrustFails} ` +
    `reasonMentionsTrust=${reasonMentionsTrust} ` +
    `failureReason=${failureReason.slice(0, 200)}`;
  record(
    "Test 14: production predicate requires trusted substrate (no trust → blocked; trust → ready; reason mentions substrate/attestation/sandboxed)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 15 — Capability is execution-bound (can't replay across executions)
// ===========================================================================
//
// Sign a capability for executionId "exec-A" with nonce "nonce-A". Run the
// substrate with capability A. Try to verify the resulting attestation with
// capability B's nonce/executionId — verification MUST fail (the attestation
// is bound to capability A's nonce/executionId, NOT capability B's).
//
// This proves: an attestation from execution A CANNOT be replayed for execution B.

{
  const executionIdA = randomUUID();
  const nonceA = randomUUID();
  const executionIdB = randomUUID();
  const nonceB = randomUUID();

  // Phase 18Y: set up a real workspace + repo (the supervisor verifies git HEAD + clean tree).
  const { repoPath, sha } = setupTestWorkspace("e2e-iso-15");
  const plan = makePlan(3000);

  // Sign capability A and run the substrate.
  const capA = SUPERVISOR.signCapability({
    executionId: executionIdA,
    nonce: nonceA,
    leaseId: "lease-1",
    repositoryHeadSha: sha,
    runtimePlanHash: "plan-hash",
    architectureHash: null,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });
  const resp = await fetch(`${SUPERVISOR.url}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: capA,
      repoPath,
    }),
  });
  const body = await resp.json() as { attestation?: SandboxAttestation };
  const att = body.attestation;

  if (!att) {
    record(
      "Test 15: capability is execution-bound (attestation from exec A CANNOT be replayed for exec B)",
      false,
      `no attestation returned (status=${resp.status})`
    );
  } else {
    // Verify against capability A's nonce/executionId — should be valid.
    const verifyA = verifyLauncherAttestation(att, LAUNCHER_PUBLIC_KEY, nonceA, executionIdA);
    // Verify against capability B's nonce/executionId — should be INVALID.
    const verifyB = verifyLauncherAttestation(att, LAUNCHER_PUBLIC_KEY, nonceB, executionIdB);
    const trustedB = isSubstrateTrusted(att, LAUNCHER_PUBLIC_KEY, nonceB, executionIdB);
    const ok = verifyA.valid && !verifyB.valid && !trustedB;
    const details =
      `verifyA.valid=${verifyA.valid} (must be true — attestation matches capability A) ` +
      `verifyB.valid=${verifyB.valid} (must be false — attestation does NOT match capability B) ` +
      `trustedB=${trustedB} (must be false) ` +
      `reasonsB=${verifyB.reasons.slice(0, 2).join("; ")}`;
    record(
      "Test 15: capability is execution-bound (attestation from exec A CANNOT be replayed for exec B)",
      ok,
      details
    );
  }
}

// ===========================================================================
// Stop the supervisor (graceful — SIGTERM with 5s grace → SIGKILL).
// ===========================================================================

await SUPERVISOR.stop();

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n=== e2e-launcher-key-isolation-invariants ===\n");
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  if (!r.passed) {
    console.log(`  ${r.details}`);
  }
}
console.log(
  `\n=== e2e-launcher-key-isolation-invariants: ${passed} passed, ${failed} failed ===`
);
if (failed > 0) {
  console.log(
    "\n❌ E2E LAUNCHER KEY ISOLATION NOT SATISFIED — the P0 may not be closed"
  );
  process.exit(1);
} else {
  console.log(
    "\n✅ E2E launcher key isolation enforced — full path (control-plane → worker → supervisor → substrate → attestation → verification) holds; worker cannot forge the attestation at any layer"
  );
  process.exit(0);
}
