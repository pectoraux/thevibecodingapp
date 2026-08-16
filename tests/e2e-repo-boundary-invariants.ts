// Forge — Phase 18Z-PRE-B: DEFINITIVE Adversarial E2E Test Suite for the
// Repository Execution Boundary.
//
// This is the ACCEPTANCE TEST for Phase 18Z-PRE. It exercises the REAL
// supervisor + REAL substrate end-to-end and proves the worker CANNOT control
// the repository materialization. The supervisor owns the entire clone +
// checkout + verify + run pipeline; the worker supplies ONLY `{ capability }`.
//
// ARCHITECTURE (Phase 18Z-PRE — the FINAL closure):
//
//   Control Plane signs capability {
//     executionId, nonce, leaseId,
//     repositoryHeadSha, repositoryUrl (SIGNED),
//     runtimePlanHash, architectureHash,
//     workloadHash, runtimePlan (FULL plan, SIGNED),
//     expiresAt
//   }
//       ↓
//   Worker (UNTRUSTED) supplies ONLY { capability }
//     — NO repoPath, NO workload, NO plan, NO credential, NO execution recipe.
//       ↓
//   Supervisor (TRUSTED — holds launcher key IN MEMORY, file deleted):
//     1. REJECT if `repoPath` is present in the request body (defense-in-depth).
//     2. REJECT if `workload` is present (Phase 18Y).
//     3. verifyExecutionCapability(capability, FORGE_CONTROL_PLANE_PUBLIC_KEY).
//     4. PRE-CONSUMPTION CHECKS (workloadHash, runtimePlan, repositoryUrl,
//        repositoryHeadSha) — returns 403 WITHOUT consuming the nonce on
//        failure (DoS vector closed).
//     5. CONSUME THE NONCE (atomic — /api/supervisor/consume-capability).
//     6. CREATE per-execution workspace: /tmp/forge-executions/<executionId>/.
//     7. RESOLVE the repo credential via /api/supervisor/resolve-repo-credential
//        (the supervisor NEVER asks the worker for a credential).
//     8. CLONE the repo at the signed SHA (the supervisor does the clone).
//     9. VERIFY git rev-parse HEAD === cap.repositoryHeadSha.
//    10. VERIFY the FULL tree (status --porcelain, clean -nd, core.hooksPath).
//    11. Write plan.json + copy orchestrator.js.
//    12. Run the substrate (with the launcher key it holds in memory).
//    13. Return { attestation, result, results } — NEVER the launcher key.
//
// THE 14 ADVERSARIAL TESTS (matches the user's acceptance criteria):
//
//   1.  FULL E2E happy path — supervisor clones the repo, attestation verifies,
//       envelope.passed === true, workspace exists with server.js.
//   2.  Worker-supplied repoPath → REJECT (the P0).
//   3.  Ignored-file attack → REJECT (supervisor clones fresh — evil/ NOT in
//       the clone).
//   4.  Wrong SHA in capability → REJECT (git checkout fails).
//   5.  Wrong repositoryUrl → signature broken.
//   6.  Supervisor resolves credential from control plane (not the worker).
//   7.  Nonce NOT consumed on pre-check failure (DoS prevention).
//   8.  Nonce consumed on success (single-use).
//   9.  Per-execution workspace isolation.
//  10.  Supervisor clones, not worker (source inspection).
//  11.  Tampered capability signature → REJECT.
//  12.  Supervisor verifies repo SHA after cloning (wrong SHA from a different
//       repo → REJECT).
//  13.  Real substrate isolation in the E2E path (user ns inode ≠ host,
//       seccompMode === 2, seccompProfileHash matches).
//  14.  Production predicate requires trusted substrate (closure check).
//
// Run with: bun run tests/e2e-repo-boundary-invariants.ts

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";

import {
  verifyLauncherAttestation,
  isSubstrateTrusted,
  REQUIRED_SECCOMP_PROFILE_HASH,
  type SandboxAttestation,
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
  type ExecutionCapability,
  type ExecutionCapabilityInput,
} from "@/lib/execution-capability";
import {
  canReachProductionReadyWithRuntime,
  getProductionReadinessFailureReason,
  type ProductionReadinessEvidence,
} from "@/lib/runtime-verification";
import { getHostNamespaceInodes } from "@/lib/substrate-namespace";
import { executeRuntimeVerificationInWorker, generateSubstrateNonce } from "../mini-services/execution-worker/runtime/verify.js";
import { startTestSupervisor, type TestSupervisor } from "./lib/test-supervisor.js";
import {
  setupTestWorkspace,
  setupTestRepo,
  makeTestPlan,
  fileUrlForPath,
  type TestOrchestratorPlan,
} from "./lib/test-capability.js";

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

/** Helper: POST a body to the supervisor's /execute and return the response. */
async function postExecute(
  url: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: any; text: string }> {
  const resp = await fetch(`${url}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any = null;
  let text = "";
  try {
    text = await resp.text();
    json = JSON.parse(text);
  } catch {
    // non-JSON response; leave json null
  }
  return { status: resp.status, json, text };
}

/** Helper: sign a capability with the full plan + derived workloadHash + repositoryUrl. */
function signValidCap(
  sup: TestSupervisor,
  opts: {
    executionId: string;
    nonce: string;
    leaseId: string;
    repositoryHeadSha: string;
    repositoryUrl: string;
    plan?: TestOrchestratorPlan;
    expiresAt?: string;
    /** Override workloadHash (for tamper tests). */
    workloadHash?: string;
    /** Override repositoryUrl (defaults to opts.repositoryUrl). */
  }
): ExecutionCapability {
  const plan = opts.plan ?? makeTestPlan(3000);
  return sup.signCapability({
    executionId: opts.executionId,
    nonce: opts.nonce,
    leaseId: opts.leaseId,
    repositoryHeadSha: opts.repositoryHeadSha,
    repositoryUrl: opts.repositoryUrl,
    runtimePlanHash: "e2e-repo-boundary-plan-hash",
    architectureHash: null,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: opts.workloadHash ?? computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });
}

// ===========================================================================
// Start the supervisor (with mock consume-capability + resolve-repo-credential
// servers — the mock records every call to /api/supervisor/resolve-repo-credential).
// ===========================================================================

const SUPERVISOR: TestSupervisor = await startTestSupervisor();
const LAUNCHER_PUBLIC_KEY = SUPERVISOR.launcherPublicKey;
const WORKER_KEY = generateWorkerKeyPair("e2e-repo-boundary-worker");
console.log(`[e2e-repo-boundary] Supervisor started at ${SUPERVISOR.url}`);
console.log(`[e2e-repo-boundary] Mock consume-capability + resolve-repo-credential on port ${SUPERVISOR.mockConsumeCapabilityPort}`);

// Host namespace inodes — captured BEFORE any substrate runs, so we can
// assert the attestation's inodes differ from the host's (Test 13).
const HOST_INODES = getHostNamespaceInodes();
console.log(`[e2e-repo-boundary] Host namespace inodes: user=${HOST_INODES.user} pid=${HOST_INODES.pid}`);

// ===========================================================================
// TEST 1 — FULL E2E happy path (supervisor clones the repo).
// ===========================================================================
// Sign a capability with repositoryUrl: file://<repoPath> + repositoryHeadSha: <sha>.
// POST { capability } (NO repoPath). The supervisor clones the repo, checks out
// the SHA, writes plan.json + orchestrator.js, runs the substrate, returns the
// signed attestation. Assert:
//   - HTTP 200, response has `attestation` + `result`.
//   - isSubstrateTrusted(attestation, launcherPublicKey, nonce, executionId) === true.
//   - envelope.passed === true (the test app's /health check passed).
//   - The supervisor cloned the repo (the workspace at
//     /tmp/forge-executions/<executionId>/repo/server.js exists).

let test1Attestation: SandboxAttestation | null = null;
let test1ExecutionId = "";
let test1Nonce = "";

{
  const { repoPath, sha } = setupTestWorkspace("e2e-rb-1");
  const executionId = randomUUID();
  const nonce = generateSubstrateNonce();
  const plan = makeTestPlan(3000);
  const capability = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-e2e-rb-1",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath), plan,
  });
  test1ExecutionId = executionId;
  test1Nonce = nonce;

  const envelope = await executeRuntimeVerificationInWorker({
    executionId,
    workerId: "e2e-repo-boundary-worker",
    leaseId: "lease-e2e-rb-1",
    repositoryHeadSha: sha,
    repositoryUrl: repoPath,
    architectureHash: null,
    runtimePlanHash: "e2e-repo-boundary-plan-hash",
    plan,
    nonce,
    capability,
    supervisorUrl: SUPERVISOR.url,
    workerPrivateKeyPem: WORKER_KEY.privateKeyPem,
    totalTimeoutMs: 120000,
  });
  const att = envelope.substrateAttestation;
  test1Attestation = att;
  const attNonNull = !!att;
  const trusted = attNonNull
    ? isSubstrateTrusted(att, LAUNCHER_PUBLIC_KEY, nonce, executionId)
    : false;
  const envelopePassed = envelope.passed === true;
  const wsRepoServerJs = `/tmp/forge-executions/${executionId}/repo/server.js`;
  const workspaceCloned = existsSync(wsRepoServerJs);
  const ok = attNonNull && trusted && envelopePassed && workspaceCloned;
  record(
    "Test 1: FULL E2E happy path — supervisor clones the repo, attestation verifies, envelope.passed === true, workspace has server.js",
    ok,
    `attNonNull=${attNonNull} trusted=${trusted} envelopePassed=${envelopePassed} workspaceCloned=${workspaceCloned} (expected ${wsRepoServerJs})`
  );
}

// ===========================================================================
// TEST 2 — Worker-supplied repoPath → REJECT (the P0).
// ===========================================================================
// POST { capability, repoPath: "/tmp/forge-evil-repo" } to the supervisor.
// The supervisor MUST reject (HTTP 403) — the worker has ZERO host-path
// authority over the repository materialization.

{
  const { repoPath, sha } = setupTestWorkspace("e2e-rb-2");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-e2e-rb-2",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath),
  });
  const { status, json } = await postExecute(SUPERVISOR.url, {
    capability: cap,
    repoPath: "/tmp/forge-evil-repo-path-that-should-be-rejected",
  });
  const errMsg = json?.error ?? "";
  const mentionsRepoPath =
    /repoPath/i.test(errMsg) ||
    /not accepted/i.test(errMsg) ||
    /derived/i.test(errMsg) ||
    /clones the repo itself/i.test(errMsg);
  const ok = status === 403 && mentionsRepoPath;
  record(
    "Test 2: worker-supplied repoPath → REJECT (HTTP 403, error mentions repoPath/not accepted/derived/clones itself)",
    ok,
    `status=${status} errMsg=${errMsg.slice(0, 200)}`
  );
}

// ===========================================================================
// TEST 3 — Ignored-file attack → REJECT (supervisor clones fresh).
// ===========================================================================
// Create a SOURCE repo. Add a .gitignore that ignores `evil/`. Create
// `evil/payload.sh` with malicious content. Commit ONLY the .gitignore (NOT
// the evil directory — it's ignored, but it's still on disk in the source).
// Sign a capability with the repo's HEAD SHA.
// POST { capability }.
// The supervisor clones the repo FRESH — `evil/` is NOT in the clone (it was
// never committed, only ignored + untracked).
// Assert:
//   - The cloned workspace does NOT contain `evil/payload.sh`.
//   - Execution succeeds (the ignored content didn't contaminate the execution).

{
  const sourceRepoPath = `/tmp/forge-e2e-rb-3-source-${randomUUID()}`;
  setupTestRepo(sourceRepoPath);
  // Add .gitignore that ignores the evil/ directory.
  writeFileSync(join(sourceRepoPath, ".gitignore"), "evil/\n");
  // Create the evil/ directory + payload (UNTRACKED, IGNORED).
  mkdirSync(join(sourceRepoPath, "evil"), { recursive: true });
  writeFileSync(
    join(sourceRepoPath, "evil", "payload.sh"),
    "#!/bin/sh\necho 'PWNED — malicious payload executed'\nrm -rf /\n"
  );
  // Commit ONLY the .gitignore (NOT the evil directory — it's ignored).
  execFileSync("git", ["add", ".gitignore"], { cwd: sourceRepoPath, shell: false });
  execFileSync("git", ["commit", "-m", "add .gitignore (evil/ is ignored)"], {
    cwd: sourceRepoPath, shell: false,
  });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRepoPath, encoding: "utf-8", shell: false,
  }).trim();

  const executionId = randomUUID();
  const nonce = randomUUID();
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-e2e-rb-3",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(sourceRepoPath),
  });
  const { status, json } = await postExecute(SUPERVISOR.url, {
    capability: cap,
  });
  const statusOk = status === 200;
  const evilInClone = existsSync(`/tmp/forge-executions/${executionId}/repo/evil/payload.sh`);
  const ok = statusOk && !evilInClone;
  let detail = `status=${status} evilInClone=${evilInClone}`;
  if (status !== 200) {
    detail += ` error=${JSON.stringify(json ?? {}).slice(0, 200)}`;
  }
  record(
    "Test 3: ignored-file attack → supervisor clones fresh (evil/payload.sh NOT in clone, execution succeeds)",
    ok,
    detail
  );
}

// ===========================================================================
// TEST 4 — Wrong SHA in capability → REJECT.
// ===========================================================================
// Sign a capability with `repositoryHeadSha: "deadbeef..."` (a valid-looking
// 40-hex SHA that doesn't exist in the repo). POST → the supervisor clones the
// repo, tries `git checkout <sha>` → fails (SHA not found) → 403.

{
  const { repoPath, sha } = setupTestWorkspace("e2e-rb-4");
  const executionId = randomUUID();
  const nonce = randomUUID();
  // A 40-hex-char SHA that doesn't exist in the repo.
  const wrongSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  // Sanity check: the wrong SHA doesn't equal the real SHA.
  if (wrongSha === sha) {
    throw new Error("Test 4 setup: wrongSha accidentally matches real SHA");
  }
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-e2e-rb-4",
    repositoryHeadSha: wrongSha, repositoryUrl: fileUrlForPath(repoPath),
  });
  const { status, json } = await postExecute(SUPERVISOR.url, {
    capability: cap,
  });
  const errMsg = JSON.stringify(json ?? {});
  const mentionsShaOrCheckout =
    /SHA/i.test(errMsg) ||
    /checkout/i.test(errMsg) ||
    /repository/i.test(errMsg) ||
    /commit/i.test(errMsg);
  const ok = status === 403 && mentionsShaOrCheckout;
  record(
    "Test 4: wrong SHA in capability → REJECT (HTTP 403, error mentions SHA/checkout/repository/commit)",
    ok,
    `status=${status} errMsg=${errMsg.slice(0, 250)}`
  );
}

// ===========================================================================
// TEST 5 — Wrong repositoryUrl → signature broken.
// ===========================================================================
// Take a valid capability. Change `repositoryUrl` to a different URL. The
// signature was over the ORIGINAL repositoryUrl — verifyExecutionCapability
// MUST return valid=false (repositoryUrl is signed).

{
  const { repoPath, sha } = setupTestWorkspace("e2e-rb-5");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-e2e-rb-5",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath),
  });
  // Tamper: change repositoryUrl after signing.
  const tampered: ExecutionCapability = {
    ...cap,
    repositoryUrl: "file:///tmp/different-repo-that-does-not-match",
  };
  const verifyResult = verifyExecutionCapability(tampered, SUPERVISOR.controlPlaneKeyPair.publicKeyPem);
  const signatureBroken = !verifyResult.valid;
  const mentionsSignature = verifyResult.reasons.some((r) => /signature/i.test(r));
  // Control: the ORIGINAL capability verifies fine.
  const controlResult = verifyExecutionCapability(cap, SUPERVISOR.controlPlaneKeyPair.publicKeyPem);
  const ok = signatureBroken && mentionsSignature && controlResult.valid;
  record(
    "Test 5: wrong repositoryUrl → signature broken (verifyExecutionCapability.valid === false, control cap still verifies)",
    ok,
    `tampered.valid=${verifyResult.valid} mentionsSignature=${mentionsSignature} control.valid=${controlResult.valid} reasons=${verifyResult.reasons.slice(0, 2).join("; ")}`
  );
}

// ===========================================================================
// TEST 6 — Supervisor resolves credential from control plane (not the worker).
// ===========================================================================
// POST { capability } to the supervisor. Assert:
//   - The supervisor called /api/supervisor/resolve-repo-credential (the mock
//     recorded the call with the cap's executionId + repositoryUrl).
//   - The worker's request body did NOT contain any credential (source
//     inspection of verify.ts — no `credential:` field in the POST body).
//   - The supervisor's clone URL came from the control-plane response (source
//     inspection of index.ts — `cloneUrl = resolveBody.cloneUrl`).

{
  const { repoPath, sha } = setupTestWorkspace("e2e-rb-6");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-e2e-rb-6",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath),
  });

  // Snapshot the call count BEFORE the POST.
  const callsBefore = SUPERVISOR.resolveRepoCredentialCalls.length;

  const { status } = await postExecute(SUPERVISOR.url, {
    capability: cap,
  });

  const callsAfter = SUPERVISOR.resolveRepoCredentialCalls.length;
  const callCountDelta = callsAfter - callsBefore;
  const matchingCall = SUPERVISOR.resolveRepoCredentialCalls
    .slice(callsBefore)
    .find((c) => c.executionId === executionId && c.repositoryUrl === fileUrlForPath(repoPath));
  const mockWasCalled = callCountDelta >= 1 && !!matchingCall;

  // Source inspection: the worker passes NO credential field to the supervisor.
  const workerSrc = readFile("mini-services/execution-worker/runtime/verify.ts");
  const workerStripped = workerSrc
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  // The worker's POST body is JSON.stringify({ capability: ... }). It must NOT
  // contain a `credential:` field (with colon — distinguishes from `capability:`).
  const workerBodyHasCredential = /credential\s*:/.test(workerStripped.replace(/capability/g, ""));
  // Source inspection: the supervisor reads cloneUrl from the resolve response
  // (NOT from the worker's request body).
  const supSrc = readFile("mini-services/substrate-supervisor/index.ts");
  const supervisorReadsCloneUrlFromResolveResponse =
    /cloneUrl\s*=\s*resolveBody\.cloneUrl/.test(supSrc) ||
    /cloneUrl\s*=\s*\(?\s*await\s+resolveResp\.json\(\)\s*\)?\.cloneUrl/.test(supSrc);
  const supervisorCallsResolve = supSrc.includes("/api/supervisor/resolve-repo-credential");

  const ok =
    status === 200 &&
    mockWasCalled &&
    !workerBodyHasCredential &&
    supervisorReadsCloneUrlFromResolveResponse &&
    supervisorCallsResolve;
  record(
    "Test 6: supervisor resolves credential from control plane (not the worker) — mock recorded the call, worker body has no credential, supervisor reads cloneUrl from resolve response",
    ok,
    `status=${status} mockWasCalled=${mockWasCalled} workerBodyHasCredential=${workerBodyHasCredential} supervisorReadsCloneUrlFromResolveResponse=${supervisorReadsCloneUrlFromResolveResponse} supervisorCallsResolve=${supervisorCallsResolve}`
  );
}

// ===========================================================================
// TEST 7 — Nonce NOT consumed on pre-check failure (DoS prevention).
// ===========================================================================
// Sign a cap with `repositoryUrl: ""` (empty string). The signature is VALID
// (the canonical JSON includes `"repositoryUrl":""` — empty string is a defined
// value, not undefined). The supervisor's pre-check 2f
// (`cap.repositoryUrl.length === 0`) fails → 403 WITHOUT consuming the nonce.
// Then POST a VALID cap (same nonce, valid repositoryUrl) → 200 (the nonce was
// NOT consumed by the failed attempt — the DoS vector is closed).

{
  const { repoPath, sha } = setupTestWorkspace("e2e-rb-7");
  const executionId = randomUUID();
  const nonce = generateSubstrateNonce();
  const plan = makeTestPlan(3000);

  // VALID cap — for the second POST (should succeed).
  const validCap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-e2e-rb-7",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath), plan,
  });

  // BAD cap — repositoryUrl is "" (empty string). The signature is VALID
  // (the canonical JSON includes `"repositoryUrl":""`). The supervisor's
  // pre-check fails (cap.repositoryUrl.length === 0) → 403 WITHOUT consuming
  // the nonce.
  const badInput: ExecutionCapabilityInput = {
    executionId,
    nonce,
    leaseId: "lease-e2e-rb-7",
    repositoryHeadSha: sha,
    repositoryUrl: "", // ← empty → pre-check 2f fails
    runtimePlanHash: "e2e-repo-boundary-plan-hash",
    architectureHash: null,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
    runtimePlan: plan as unknown as Record<string, unknown>,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
  const badCap = signExecutionCapability(badInput, SUPERVISOR.controlPlaneKeyPair.privateKeyPem);

  // Sanity check: the bad cap's signature verifies (so step 1 passes).
  const badCapVerify = verifyExecutionCapability(badCap, SUPERVISOR.controlPlaneKeyPair.publicKeyPem);
  const badCapSignatureValid = badCapVerify.valid;

  // First POST: bad cap → pre-check fails → 403 WITHOUT consuming the nonce.
  const { status: failStatus, json: failJson } = await postExecute(SUPERVISOR.url, {
    capability: badCap,
  });
  const failStatusOk = failStatus === 403;
  const failErr = JSON.stringify(failJson ?? {});
  const mentionsPreCheck =
    /pre-consumption|pre-check|workloadHash|missing|repositoryUrl/i.test(failErr);

  // Second POST: VALID cap (same nonce) → 200 (nonce was NOT consumed by the
  // failed attempt — the DoS vector is closed).
  const { status: okStatus, json: okJson } = await postExecute(SUPERVISOR.url, {
    capability: validCap,
  });
  const okStatus200 = okStatus === 200;
  const hasAttestation = !!okJson?.attestation;

  const ok = badCapSignatureValid && failStatusOk && mentionsPreCheck && okStatus200 && hasAttestation;
  record(
    "Test 7: nonce NOT consumed on pre-check failure (DoS prevention) — bad cap (empty repositoryUrl, signature valid) → 403, then valid cap (same nonce) → 200",
    ok,
    `badCapSignatureValid=${badCapSignatureValid} failStatus=${failStatus} mentionsPreCheck=${mentionsPreCheck} okStatus=${okStatus} hasAttestation=${hasAttestation} failErr=${failErr.slice(0, 200)}`
  );
}

// ===========================================================================
// TEST 8 — Nonce consumed on success (single-use).
// ===========================================================================
// POST a valid capability → 200 (nonce consumed). POST the SAME capability
// again → 403 (nonce already consumed — replay rejected).

{
  const { repoPath, sha } = setupTestWorkspace("e2e-rb-8");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-e2e-rb-8",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath),
  });
  // First use — should succeed (nonce consumed).
  const { status: firstStatus } = await postExecute(SUPERVISOR.url, {
    capability: cap,
  });
  const firstOk = firstStatus === 200;
  // Second use — REPLAY. Same capability (same nonce). The supervisor calls
  // consume-capability, which returns 403 (nonce already consumed).
  const { status: replayStatus, json: replayJson } = await postExecute(SUPERVISOR.url, {
    capability: cap,
  });
  const replayRejected = replayStatus === 403;
  const replayErr = JSON.stringify(replayJson ?? {});
  const mentionsReplay =
    /replay/i.test(replayErr) ||
    /consumed/i.test(replayErr) ||
    /nonce/i.test(replayErr);
  const ok = firstOk && replayRejected && mentionsReplay;
  record(
    "Test 8: nonce consumed on success (single-use) — first POST → 200, second POST (replay) → 403, error mentions replay/consumed/nonce",
    ok,
    `firstStatus=${firstStatus} replayStatus=${replayStatus} mentionsReplay=${mentionsReplay} err=${replayErr.slice(0, 200)}`
  );
}

// ===========================================================================
// TEST 9 — Per-execution workspace isolation.
// ===========================================================================
// Run two different executions (different executionIds, different nonces,
// different repos). Assert:
//   - The workspaces are at /tmp/forge-executions/<executionId1>/ and
//     /tmp/forge-executions/<executionId2>/ — DIFFERENT directories.
//   - No cross-contamination (execution 1's workspace has repo 1's server.js
//     but NOT repo 2's marker file, and vice versa).

{
  // Repo 1 has a unique marker file `marker-rb9-1.txt`.
  const { repoPath: repoPath1, sha: sha1 } = setupTestWorkspace("e2e-rb-9a");
  writeFileSync(join(repoPath1, "marker-rb9-1.txt"), "marker for execution 1\n");
  execFileSync("git", ["add", "."], { cwd: repoPath1, shell: false });
  execFileSync("git", ["commit", "-m", "add marker 1"], { cwd: repoPath1, shell: false });
  const sha1Final = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath1, encoding: "utf-8", shell: false,
  }).trim();

  // Repo 2 has a different marker file `marker-rb9-2.txt`.
  const { repoPath: repoPath2, sha: sha2 } = setupTestWorkspace("e2e-rb-9b");
  writeFileSync(join(repoPath2, "marker-rb9-2.txt"), "marker for execution 2\n");
  execFileSync("git", ["add", "."], { cwd: repoPath2, shell: false });
  execFileSync("git", ["commit", "-m", "add marker 2"], { cwd: repoPath2, shell: false });
  const sha2Final = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath2, encoding: "utf-8", shell: false,
  }).trim();

  const executionId1 = randomUUID();
  const nonce1 = randomUUID();
  const cap1 = signValidCap(SUPERVISOR, {
    executionId: executionId1, nonce: nonce1, leaseId: "lease-e2e-rb-9a",
    repositoryHeadSha: sha1Final, repositoryUrl: fileUrlForPath(repoPath1),
  });
  const { status: status1 } = await postExecute(SUPERVISOR.url, {
    capability: cap1,
  });

  const executionId2 = randomUUID();
  const nonce2 = randomUUID();
  const cap2 = signValidCap(SUPERVISOR, {
    executionId: executionId2, nonce: nonce2, leaseId: "lease-e2e-rb-9b",
    repositoryHeadSha: sha2Final, repositoryUrl: fileUrlForPath(repoPath2),
  });
  const { status: status2 } = await postExecute(SUPERVISOR.url, {
    capability: cap2,
  });

  const ws1 = `/tmp/forge-executions/${executionId1}`;
  const ws2 = `/tmp/forge-executions/${executionId2}`;
  const both200 = status1 === 200 && status2 === 200;
  const workspacesDiffer = ws1 !== ws2;
  // Cross-contamination check: ws1 has marker-rb9-1.txt but NOT marker-rb9-2.txt.
  const ws1HasMarker1 = existsSync(`${ws1}/repo/marker-rb9-1.txt`);
  const ws1HasMarker2 = existsSync(`${ws1}/repo/marker-rb9-2.txt`);
  const ws2HasMarker1 = existsSync(`${ws2}/repo/marker-rb9-1.txt`);
  const ws2HasMarker2 = existsSync(`${ws2}/repo/marker-rb9-2.txt`);
  const noCrossContamination = ws1HasMarker1 && !ws1HasMarker2 && !ws2HasMarker1 && ws2HasMarker2;
  const ok = both200 && workspacesDiffer && noCrossContamination;
  record(
    "Test 9: per-execution workspace isolation — two executions get different workspaces, no cross-contamination (ws1 has marker1 only, ws2 has marker2 only)",
    ok,
    `status1=${status1} status2=${status2} workspacesDiffer=${workspacesDiffer} ws1HasMarker1=${ws1HasMarker1} ws1HasMarker2=${ws1HasMarker2} ws2HasMarker1=${ws2HasMarker1} ws2HasMarker2=${ws2HasMarker2}`
  );
}

// ===========================================================================
// TEST 10 — Supervisor clones, not worker (source inspection).
// ===========================================================================
// Grep `mini-services/execution-worker/runtime/verify.ts`:
//   - The POST body is { capability } (no `repoPath` field).
//   - The module does NOT call `git clone`.
//   - The module does NOT reference `repoPath`.
// Grep `mini-services/substrate-supervisor/index.ts`:
//   - The /execute handler rejects requests with a `repoPath` field.
//   - It calls `git clone` itself.
//   - It calls /api/supervisor/resolve-repo-credential.
//   - It consumes the nonce AFTER pre-checks (verify the ordering in source:
//     the pre-check block must come BEFORE the consume-capability fetch).

{
  const workerSrc = readFile("mini-services/execution-worker/runtime/verify.ts");
  const workerStripped = workerSrc
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  // The worker MUST NOT call `git clone`.
  const workerHasNoGitClone =
    !/execFileSync\(\s*["']git["']\s*,\s*\[[^\]]*["']clone["']/.test(workerStripped) &&
    !/\bgit\s+clone\b/.test(workerStripped);
  // The worker MUST NOT pass `repoPath` in the POST body.
  const workerHasNoRepoPathInBody = !/JSON\.stringify\(\s*{[^}]*repoPath/s.test(workerStripped);
  // The worker's SupervisorExecuteRequest interface must NOT have a repoPath field.
  const workerHasNoRepoPathInRequest =
    !/interface\s+SupervisorExecuteRequest\s*\{[^}]*repoPath/s.test(workerStripped);

  const supSrc = readFile("mini-services/substrate-supervisor/index.ts");
  // The supervisor MUST call `git clone` (it owns the clone).
  const supCallsGitClone = /git.*clone/.test(supSrc.replace(/\\/g, ""));
  // The supervisor MUST reject the `repoPath` field.
  const supRejectsRepoPathField =
    /repoPath/.test(supSrc) &&
    /does NOT accept/.test(supSrc) &&
    /Phase 18Z-PRE/.test(supSrc);
  // The supervisor MUST create a per-execution workspace.
  const supCreatesWorkspace = supSrc.includes("/tmp/forge-executions");
  // The supervisor MUST call resolve-repo-credential.
  const supCallsResolveCred = supSrc.includes("/api/supervisor/resolve-repo-credential");
  // The supervisor MUST consume the nonce AFTER pre-checks. We verify the
  // ORDERING by locating the actual pre-check block (preCheckReasons.push is
  // called inside the pre-check) and the actual consume fetch
  // (`fetch(consumeUrl` — the runtime fetch). We use the RAW source (not a
  // comment-stripped version) because the supervisor's header doc-block
  // contains `/api/supervisor/*` which the naive block-comment regex would
  // misinterpret as a comment start (the `/*` is inside a string literal).
  // The header doc-block doesn't contain `preCheckReasons.push` or
  // `fetch(consumeUrl`, so searching the raw source is safe.
  const preCheckIndex = supSrc.indexOf("preCheckReasons.push");
  const consumeIndex = supSrc.indexOf("fetch(consumeUrl");
  const orderingCorrect =
    preCheckIndex >= 0 &&
    consumeIndex >= 0 &&
    preCheckIndex < consumeIndex;

  const ok =
    workerHasNoGitClone &&
    workerHasNoRepoPathInBody &&
    workerHasNoRepoPathInRequest &&
    supCallsGitClone &&
    supRejectsRepoPathField &&
    supCreatesWorkspace &&
    supCallsResolveCred &&
    orderingCorrect;
  record(
    "Test 10: source inspection — worker does NOT call git clone / pass repoPath / have repoPath in interface; supervisor DOES call git clone + reject repoPath + create per-execution workspace + call resolve-repo-credential + consume nonce AFTER pre-checks (ordering verified)",
    ok,
    `worker.noGitClone=${workerHasNoGitClone} worker.noRepoPathInBody=${workerHasNoRepoPathInBody} worker.noRepoPathInRequest=${workerHasNoRepoPathInRequest} sup.callsGitClone=${supCallsGitClone} sup.rejectsRepoPathField=${supRejectsRepoPathField} sup.createsWorkspace=${supCreatesWorkspace} sup.callsResolveCred=${supCallsResolveCred} orderingCorrect=${orderingCorrect} (preCheckIndex=${preCheckIndex}, consumeIndex=${consumeIndex})`
  );
}

// ===========================================================================
// TEST 11 — Tampered capability signature → REJECT.
// ===========================================================================
// Take a valid capability. Change the `signature` to random hex. POST → the
// supervisor's verifyExecutionCapability fails → 403.

{
  const { repoPath, sha } = setupTestWorkspace("e2e-rb-11");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-e2e-rb-11",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath),
  });
  // Tamper: replace the signature with random hex (128 chars = 64 bytes).
  const tampered: ExecutionCapability = {
    ...cap,
    signature: randomBytes(64).toString("hex"),
  };
  const { status, json } = await postExecute(SUPERVISOR.url, {
    capability: tampered,
  });
  const errMsg = JSON.stringify(json ?? {});
  const mentionsInvalid =
    /invalid/i.test(errMsg) ||
    /signature/i.test(errMsg) ||
    /capability/i.test(errMsg);
  const ok = status === 403 && mentionsInvalid;
  record(
    "Test 11: tampered capability signature → REJECT (HTTP 403, error mentions invalid/signature/capability)",
    ok,
    `status=${status} errMsg=${errMsg.slice(0, 200)}`
  );
}

// ===========================================================================
// TEST 12 — Supervisor verifies repo SHA after cloning.
// ===========================================================================
// Create repo A with SHA "abc123". Sign a cap with repositoryHeadSha: "abc123"
// → POST → 200 (the SHA matches).
// Now sign a cap with repositoryHeadSha: "def456" (a SHA from a DIFFERENT repo
// that doesn't exist in repo A) → POST → the supervisor clones repo A, tries
// `git checkout def456` → fails (SHA not found in repo A) → 403.

{
  const { repoPath: repoPathA, sha: shaAInitial } = setupTestWorkspace("e2e-rb-12a");
  // Write a unique marker so repo A has a distinct SHA.
  writeFileSync(join(repoPathA, "marker-rb12-a.txt"), "marker A\n");
  execFileSync("git", ["add", "."], { cwd: repoPathA, shell: false });
  execFileSync("git", ["commit", "-m", "marker A"], { cwd: repoPathA, shell: false });
  const shaA = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoPathA, encoding: "utf-8", shell: false,
  }).trim();
  void shaAInitial;

  // Repo B — a different repo with a different SHA (different marker).
  const { repoPath: repoPathB, sha: shaBInitial } = setupTestWorkspace("e2e-rb-12b");
  writeFileSync(join(repoPathB, "marker-rb12-b.txt"), "marker B (different content)\n");
  execFileSync("git", ["add", "."], { cwd: repoPathB, shell: false });
  execFileSync("git", ["commit", "-m", "marker B"], { cwd: repoPathB, shell: false });
  const shaB = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoPathB, encoding: "utf-8", shell: false,
  }).trim();
  void shaBInitial;

  // Sanity: the two SHAs are different.
  if (shaA === shaB) {
    throw new Error("Test 12 setup: repoA SHA accidentally matches repoB SHA");
  }

  // POST 1: cap with repo A's URL + repo A's SHA → 200 (SHA matches).
  const executionId1 = randomUUID();
  const nonce1 = randomUUID();
  const cap1 = signValidCap(SUPERVISOR, {
    executionId: executionId1, nonce: nonce1, leaseId: "lease-e2e-rb-12a",
    repositoryHeadSha: shaA, repositoryUrl: fileUrlForPath(repoPathA),
  });
  const { status: status1 } = await postExecute(SUPERVISOR.url, {
    capability: cap1,
  });
  const status1Ok = status1 === 200;

  // POST 2: cap with repo A's URL + repo B's SHA → 403 (SHA doesn't exist in repo A).
  const executionId2 = randomUUID();
  const nonce2 = randomUUID();
  const cap2 = signValidCap(SUPERVISOR, {
    executionId: executionId2, nonce: nonce2, leaseId: "lease-e2e-rb-12b",
    repositoryHeadSha: shaB, repositoryUrl: fileUrlForPath(repoPathA),
  });
  const { status: status2, json: json2 } = await postExecute(SUPERVISOR.url, {
    capability: cap2,
  });
  const status2Rejected = status2 === 403;
  const err2 = JSON.stringify(json2 ?? {});
  const mentionsCheckoutOrSha =
    /checkout/i.test(err2) ||
    /SHA/i.test(err2) ||
    /repositoryHeadSha/i.test(err2);

  const ok = status1Ok && status2Rejected && mentionsCheckoutOrSha;
  record(
    "Test 12: supervisor verifies repo SHA after cloning — correct SHA → 200, SHA from a DIFFERENT repo → 403 (git checkout fails, error mentions checkout/SHA/repositoryHeadSha)",
    ok,
    `status1=${status1} status2=${status2} mentionsCheckoutOrSha=${mentionsCheckoutOrSha} err2=${err2.slice(0, 200)}`
  );
}

// ===========================================================================
// TEST 13 — Real substrate isolation in the E2E path.
// ===========================================================================
// From Test 1's attestation:
//   - attestation.userNamespaceInode !== host's user namespace inode (proves
//     the substrate entered a new user namespace).
//   - attestation.seccompMode === 2 (seccomp filter mode).
//   - attestation.seccompProfileHash === REQUIRED_SECCOMP_PROFILE_HASH.

{
  const att = test1Attestation;
  const attNonNull = !!att;
  const userNsDiffers =
    attNonNull &&
    !!att!.userNamespaceInode &&
    att!.userNamespaceInode !== HOST_INODES.user;
  const seccompModeOk = attNonNull && att!.seccompMode === 2;
  const seccompHashOk =
    attNonNull && att!.seccompProfileHash === REQUIRED_SECCOMP_PROFILE_HASH;
  const ok = attNonNull && userNsDiffers && seccompModeOk && seccompHashOk;
  record(
    "Test 13: real substrate isolation in the E2E path — userNamespaceInode differs from host, seccompMode === 2, seccompProfileHash matches REQUIRED_SECCOMP_PROFILE_HASH",
    ok,
    `attNonNull=${attNonNull} att.userNs=${att?.userNamespaceInode ?? "(null)"} host.userNs=${HOST_INODES.user} userNsDiffers=${userNsDiffers} seccompMode=${att?.seccompMode ?? "(null)"} (expected 2) seccompModeOk=${seccompModeOk} seccompHashOk=${seccompHashOk}`
  );
}

// ===========================================================================
// TEST 14 — Production predicate requires trusted substrate (closure check).
// ===========================================================================
// Construct ProductionReadinessEvidence with executionEnvironmentSandboxed: false
// + substrateAttestationVerified: false. Assert:
//   - canReachProductionReadyWithRuntime(evidence) === false.
//   - getProductionReadinessFailureReason(evidence) mentions "substrate" or
//     "attestation" or "sandboxed".

{
  const evidence: ProductionReadinessEvidence = {
    architectureFrozen: true,
    allTasksCompleted: true,
    allTasksIntegrated: true,
    staticReadinessPassed: true,
    runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true,
    executionEnvironmentSandboxed: false, // ← NOT sandboxed
    substrateAttestationVerified: false,  // ← NO verified attestation
    repositoryHeadVerified: true,
  };
  const canReach = canReachProductionReadyWithRuntime(evidence);
  const blocked = !canReach;
  const reason = getProductionReadinessFailureReason(evidence) ?? "";
  const mentionsSubstrateOrAttestationOrSandboxed =
    /substrate/i.test(reason) ||
    /attestation/i.test(reason) ||
    /sandboxed/i.test(reason);
  const ok = blocked && mentionsSubstrateOrAttestationOrSandboxed;
  record(
    "Test 14: production predicate requires trusted substrate — executionEnvironmentSandboxed=false + substrateAttestationVerified=false → canReachProductionReadyWithRuntime === false, reason mentions substrate/attestation/sandboxed",
    ok,
    `blocked=${blocked} reason=${reason.slice(0, 250)}`
  );
}

// ===========================================================================
// Stop the supervisor.
// ===========================================================================

await SUPERVISOR.stop();

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n=== e2e-repo-boundary-invariants ===\n");
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  if (!r.passed) {
    console.log(`  ${r.details}`);
  }
}
console.log(`\n=== e2e-repo-boundary-invariants: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  console.log("\n❌ PHASE 18Z-PRE-B E2E REPO BOUNDARY INVARIANTS NOT SATISFIED — worker may control the repo path or the nonce DoS vector is open");
  process.exit(1);
} else {
  console.log("\n✅ Phase 18Z-PRE-B: repository execution boundary is closed — supervisor owns the repository materialization, worker supplies ONLY { capability }, nonce consumed AFTER pre-checks (DoS vector closed)");
  process.exit(0);
}
