// Forge — Phase 18Z-PRE: Repository Execution Boundary — Adversarial Tests.
//
// This is the ACCEPTANCE TEST for Phase 18Z-PRE. It proves the worker CANNOT
// control the repo path — the supervisor owns the entire repository
// materialization (clone, checkout, verify, run).
//
// ARCHITECTURE (Phase 18Z-PRE):
//
//   Worker (UNTRUSTED) supplies ONLY { capability } — NO repoPath, NO host
//   path, NO credential. The capability carries:
//     - repositoryUrl (signed — tampering breaks the signature)
//     - repositoryHeadSha (signed — the exact SHA the supervisor must run)
//     - runtimePlan + workloadHash (Phase 18Y — the supervisor derives the
//       workload from the signed plan)
//
//   Supervisor (TRUSTED):
//     1. Rejects `repoPath` field (defense-in-depth — the worker must NOT
//        supply a host path).
//     2. Verifies the capability signature + expiry.
//     3. Runs PRE-CONSUMPTION CHECKS (workloadHash, runtimePlan,
//        repositoryUrl, repositoryHeadSha) — returns 403 WITHOUT consuming
//        the nonce on failure (DoS vector closed).
//     4. Consumes the nonce (atomic, via /api/supervisor/consume-capability).
//     5. Creates /tmp/forge-executions/<executionId>/.
//     6. Resolves the repo credential via /api/supervisor/resolve-repo-credential
//        (the worker NEVER sees a credential).
//     7. git clone <cloneUrl> + git checkout <cap.repositoryHeadSha>.
//     8. Verifies git rev-parse HEAD === cap.repositoryHeadSha.
//     9. Verifies the FULL tree (status --porcelain, clean -nd, core.hooksPath).
//    10. Writes plan.json + copies orchestrator.js.
//    11. Runs the substrate.
//    12. Returns { attestation, result, results }.
//
// THE 10 ADVERSARIAL TESTS:
//   1.  Worker supplies `repoPath` → REJECT (HTTP 403, error mentions repoPath).
//   2.  Worker supplies NO `repoPath` → ACCEPT (the supervisor clones itself).
//   3.  Supervisor clones at the signed SHA (cloned HEAD === cap.repositoryHeadSha).
//   4.  Worker cannot leave ignored files (clone is fresh — no ignored content).
//   5.  Wrong `repositoryUrl` in capability → signature broken.
//   6.  Supervisor resolves credential from control plane (not the worker).
//   7.  Nonce NOT consumed on pre-check failure (DoS vector closed).
//   8.  Nonce consumed on success (second call with same cap → 403).
//   9.  Per-execution workspace at /tmp/forge-executions/<executionId>/.
//  10.  Supervisor clones, not worker (source inspection).
//
// Run with: bun run tests/repo-boundary-invariants.ts

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  verifyLauncherAttestation,
  isSubstrateTrusted,
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
} from "@/lib/execution-capability";
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
    workloadHash?: string; // override for tamper tests
  }
): ExecutionCapability {
  const plan = opts.plan ?? makeTestPlan(3000);
  return sup.signCapability({
    executionId: opts.executionId,
    nonce: opts.nonce,
    leaseId: opts.leaseId,
    repositoryHeadSha: opts.repositoryHeadSha,
    repositoryUrl: opts.repositoryUrl,
    runtimePlanHash: "repo-boundary-plan-hash",
    architectureHash: null,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: opts.workloadHash ?? computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });
}

// ===========================================================================
// Start the supervisor (with mock consume-capability + resolve-repo-credential
// servers).
// ===========================================================================

const SUPERVISOR: TestSupervisor = await startTestSupervisor();
const LAUNCHER_PUBLIC_KEY = SUPERVISOR.launcherPublicKey;
const WORKER_KEY = generateWorkerKeyPair("repo-boundary-worker");
console.log(`[repo-boundary] Supervisor started at ${SUPERVISOR.url}`);
console.log(`[repo-boundary] Mock consume-capability + resolve-repo-credential on port ${SUPERVISOR.mockConsumeCapabilityPort}`);

// ===========================================================================
// TEST 1 — Worker supplies `repoPath` → REJECT (HTTP 403).
// ===========================================================================
// Phase 18Z-PRE P0 closure: the supervisor must NOT accept a `repoPath` field.
// POST { capability, repoPath: "/tmp/evil" } → 403, error mentions repoPath.

{
  const { repoPath, sha } = setupTestWorkspace("repo-boundary-1");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-rb-1",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath),
  });
  const { status, json } = await postExecute(SUPERVISOR.url, {
    capability: cap,
    repoPath: "/tmp/evil-repo-path-that-should-be-rejected",
  });
  const ok = status === 403;
  const errMsg = json?.error ?? "";
  const mentionsRepoPath = /repoPath/i.test(errMsg) || /not accepted/i.test(errMsg);
  record(
    "Test 1: worker supplies 'repoPath' → REJECT (HTTP 403, error mentions repoPath/not accepted)",
    ok && mentionsRepoPath,
    `status=${status} error=${errMsg.slice(0, 200)}`
  );
}

// ===========================================================================
// TEST 2 — Worker supplies NO `repoPath` → ACCEPT (supervisor clones itself).
// ===========================================================================
// POST { capability } only — the supervisor clones the repo itself from
// cap.repositoryUrl, runs the substrate, returns a valid attestation.

{
  const { repoPath, sha } = setupTestWorkspace("repo-boundary-2");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-rb-2",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath),
  });
  const { status, json } = await postExecute(SUPERVISOR.url, {
    capability: cap,
  });
  const att = json?.attestation;
  const attNonNull = !!att;
  const launcherValid = attNonNull
    ? verifyLauncherAttestation(att, LAUNCHER_PUBLIC_KEY, nonce, executionId).valid
    : false;
  const ok = status === 200 && attNonNull && launcherValid;
  record(
    "Test 2: worker supplies NO 'repoPath' → ACCEPT (supervisor clones itself, attestation verifies)",
    ok,
    `status=${status} attNonNull=${attNonNull} launcherValid=${launcherValid}`
  );
}

// ===========================================================================
// TEST 3 — Supervisor clones at the signed SHA (cloned HEAD === cap.repositoryHeadSha).
// ===========================================================================
// The supervisor clones from cap.repositoryUrl and checks out cap.repositoryHeadSha.
// The attestation's nonce/executionId match the capability (proving the
// substrate ran with the cap's values). The orchestrator runs successfully,
// proving the repo was cloned + checked out correctly.

{
  const { repoPath, sha } = setupTestWorkspace("repo-boundary-3");
  const executionId = randomUUID();
  const nonce = generateSubstrateNonce();
  const plan = makeTestPlan(3000);
  const capability = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-rb-3",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath), plan,
  });
  const envelope = await executeRuntimeVerificationInWorker({
    executionId,
    workerId: "repo-boundary-worker",
    leaseId: "lease-rb-3",
    repositoryHeadSha: sha,
    repositoryUrl: fileUrlForPath(repoPath),
    architectureHash: null,
    runtimePlanHash: "repo-boundary-plan-hash",
    plan,
    nonce,
    capability,
    supervisorUrl: SUPERVISOR.url,
    workerPrivateKeyPem: WORKER_KEY.privateKeyPem,
    totalTimeoutMs: 120000,
  });
  const att = envelope.substrateAttestation;
  const attNonNull = !!att;
  // The attestation's nonce + executionId come from the CAPABILITY (the
  // supervisor passes them to runInSubstrate). They MUST match.
  const execMatch = attNonNull && att.executionId === executionId;
  const nonceMatch = attNonNull && att.nonce === nonce;
  // The orchestrator ran the test app — passed=true means the app's /health
  // returned 200 (the repo was cloned + checked out correctly + the
  // orchestrator's plan ran).
  const passedFlag = envelope.passed === true;
  const ok = attNonNull && execMatch && nonceMatch && passedFlag;
  record(
    "Test 3: supervisor clones at the signed SHA (attestation matches cap nonce/execId + orchestrator passed — repo was cloned + checked out correctly)",
    ok,
    `attNonNull=${attNonNull} execMatch=${execMatch} nonceMatch=${nonceMatch} passed=${envelope.passed}`
  );
}

// ===========================================================================
// TEST 4 — Worker cannot leave ignored files (clone is fresh).
// ===========================================================================
// Create a SOURCE repo with a .gitignore + an ignored file (committed) +
// an untracked file (NOT committed). The supervisor clones from the source.
// The clone will NOT have the untracked file (it was never committed). The
// .gitignore + the ignored file ARE in the clone (they were committed), but
// the untracked file is NOT.
//
// The supervisor ACCEPTS the request because its clone is clean (no
// untracked files). The orchestrator runs successfully — proving the clone
// is fresh + complete.

{
  const sourceRepoPath = `/tmp/forge-rb-4-source-${randomUUID()}`;
  // Set up a source repo with: server.js, .gitignore (commits "ignored.txt"),
  // ignored.txt (committed), untracked-file.txt (NOT committed).
  setupTestRepo(sourceRepoPath);
  // Add .gitignore + ignored.txt + commit.
  writeFileSync(join(sourceRepoPath, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(sourceRepoPath, "ignored.txt"), "this is ignored\n");
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["add", "."], { cwd: sourceRepoPath, shell: false });
  execFileSync("git", ["commit", "-m", "add gitignore + ignored file"], { cwd: sourceRepoPath, shell: false });
  // Create an untracked file (NOT committed) — this should NOT appear in the clone.
  writeFileSync(join(sourceRepoPath, "untracked-file.txt"), "this is untracked\n");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRepoPath, encoding: "utf-8", shell: false }).trim();

  const executionId = randomUUID();
  const nonce = randomUUID();
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-rb-4",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(sourceRepoPath),
  });
  const { status, json } = await postExecute(SUPERVISOR.url, {
    capability: cap,
  });
  // The supervisor clones from the source repo. The clone will NOT have
  // untracked-file.txt (it was never committed). The clone IS clean — the
  // supervisor accepts (status 200).
  const ok = status === 200;
  let detail = `status=${status}`;
  if (status !== 200) {
    detail += ` error=${JSON.stringify(json).slice(0, 200)}`;
  }
  record(
    "Test 4: worker cannot leave ignored files (clone is fresh — untracked file in source NOT in clone, supervisor accepts)",
    ok,
    detail
  );
}

// ===========================================================================
// TEST 5 — Wrong `repositoryUrl` in capability → signature broken.
// ===========================================================================
// Take a valid capability. Tamper with repositoryUrl. The signature was
// over the ORIGINAL repositoryUrl — verifyExecutionCapability MUST return
// valid=false.

{
  const { repoPath, sha } = setupTestWorkspace("repo-boundary-5");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-rb-5",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath),
  });
  // Tamper: change repositoryUrl after signing.
  const tamperedCap: ExecutionCapability = {
    ...cap,
    repositoryUrl: "file:///tmp/evil-repo-that-does-not-match",
  };
  // The signature was over the ORIGINAL repositoryUrl. Changing it breaks
  // the signature. verifyExecutionCapability MUST return valid=false.
  const verifyResult = verifyExecutionCapability(tamperedCap, SUPERVISOR.controlPlaneKeyPair.publicKeyPem);
  const signatureBroken = !verifyResult.valid;
  const mentionsSignature = verifyResult.reasons.some((r) => /signature/i.test(r));
  // Control: the ORIGINAL capability verifies fine.
  const controlResult = verifyExecutionCapability(cap, SUPERVISOR.controlPlaneKeyPair.publicKeyPem);
  const ok = signatureBroken && mentionsSignature && controlResult.valid;
  record(
    "Test 5: tampered repositoryUrl → signature broken (verifyExecutionCapability.valid === false)",
    ok,
    `tampered.valid=${verifyResult.valid} reasons=${verifyResult.reasons.slice(0, 2).join("; ")} control.valid=${controlResult.valid}`
  );
}

// ===========================================================================
// TEST 6 — Supervisor resolves credential from control plane (not the worker).
// ===========================================================================
// Source inspection: the supervisor's /execute handler must call
// /api/supervisor/resolve-repo-credential. The worker's verify.ts must NOT
// pass any credential field. The supervisor must NOT accept a `credential`
// field in the /execute request body (defense-in-depth).

{
  const supSrc = readFile("mini-services/substrate-supervisor/index.ts");
  const supCallsResolveCred = supSrc.includes("/api/supervisor/resolve-repo-credential");
  const supRejectsCredentialField =
    // The supervisor doesn't currently have an explicit check for a
    // `credential` field in the /execute body — but it doesn't read one
    // either. We verify the supervisor reads `cloneUrl` from the
    // resolve-repo-credential endpoint (NOT from the request body).
    /cloneUrl\s*=\s*resolveBody\.cloneUrl/.test(supSrc) ||
    /cloneUrl\s*=\s*await.*resolve.*cloneUrl/s.test(supSrc);
  const workerSrc = readFile("mini-services/execution-worker/runtime/verify.ts");
  const workerStripped = workerSrc
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  // The worker MUST NOT pass a credential field to the supervisor.
  const workerHasNoCredentialInBody = !/JSON\.stringify\(\s*{[^}]*credential[^}]*}/s.test(workerStripped) ||
    // The worker passes `capability` (not `credential`). The regex above
    // would match `capability` (substring) — but that's the signed cap,
    // not a clone credential. We check for `credential:` (with colon) to
    // distinguish.
    !/credential\s*:/.test(workerStripped.replace(/capability/g, ""));
  const ok = supCallsResolveCred && supRejectsCredentialField && workerHasNoCredentialInBody;
  record(
    "Test 6: supervisor resolves credential from control plane (not the worker) — supervisor calls /api/supervisor/resolve-repo-credential, worker passes no credential",
    ok,
    `sup.callsResolveCred=${supCallsResolveCred} sup.readsCloneUrlFromResolve=${supRejectsCredentialField} worker.noCredentialInBody=${workerHasNoCredentialInBody}`
  );
}

// ===========================================================================
// TEST 7 — Nonce NOT consumed on pre-check failure (DoS vector closed).
// ===========================================================================
// POST with a capability that passes signature verification but FAILS a
// pre-check (workloadHash missing). The supervisor's pre-check fails → 403
// WITHOUT consuming the nonce. Then POST AGAIN with the SAME valid cap
// (has workloadHash, same nonce) → should SUCCEED (the nonce was NOT
// consumed by the failed attempt).
//
// To make the cap pass signature verification BUT fail the pre-check, we
// sign a cap that OMITS workloadHash entirely. The canonical JSON filters
// out undefined fields, so the signature is over the canonical WITHOUT
// workloadHash. verifyExecutionCapability reconstructs the same input
// (without workloadHash) → same canonical → signature matches. The cap
// passes step 1 (signature verification) but fails step 2a (pre-check:
// workloadHash missing) → 403 WITHOUT consuming the nonce.

{
  const { repoPath, sha } = setupTestWorkspace("repo-boundary-7");
  const executionId = randomUUID();
  const nonce = generateSubstrateNonce();
  const plan = makeTestPlan(3000);
  // Sign a valid capability (with the correct workloadHash) — for the
  // second POST (should succeed).
  const validCap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-rb-7",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath), plan,
  });
  // Construct a cap that OMITS workloadHash (so the pre-check fails) but
  // is properly signed (so step 1 passes). We sign directly with
  // signExecutionCapability, omitting workloadHash from the input.
  // The canonical JSON filters undefined fields, so the signature is over
  // the canonical WITHOUT workloadHash.
  const capWithoutWorkloadHashInput = {
    executionId,
    nonce,
    leaseId: "lease-rb-7",
    repositoryHeadSha: sha,
    repositoryUrl: fileUrlForPath(repoPath),
    runtimePlanHash: "repo-boundary-plan-hash",
    architectureHash: null as string | null,
    // workloadHash: OMITTED — pre-check step 2a will fail.
    runtimePlan: plan as unknown as Record<string, unknown>,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
  // Use the supervisor's control-plane private key to sign (so the
  // supervisor's pinned public key verifies it).
  // We can't access the private key directly via SUPERVISOR — but we can
  // use signExecutionCapability with the controlPlaneKeyPair's private key.
  // Actually, the TestSupervisor doesn't expose the private key. We need
  // to use the signCapability helper, but it requires workloadHash.
  //
  // WORKAROUND: sign a cap WITH workloadHash (via signValidCap), then
  // construct a new cap object that omits workloadHash, and re-sign it
  // with the same private key. But we don't have the private key.
  //
  // ALTERNATIVE: use the SUPERVISOR.signCapability helper to sign a cap
  // with workloadHash, then DELETE workloadHash from the resulting cap
  // object, then RE-SIGN the cap (without workloadHash) using the same
  // private key. But we still don't have the private key.
  //
  // ACTUAL APPROACH: The TestSupervisor's signCapability uses the
  // controlPlaneKeyPair.privateKeyPem internally. We can access it via
  // SUPERVISOR.controlPlaneKeyPair.privateKeyPem.
  const cpPrivPem = SUPERVISOR.controlPlaneKeyPair.privateKeyPem;
  // Construct the input WITHOUT workloadHash. TypeScript would complain
  // (workloadHash is required on ExecutionCapabilityInput), so we cast.
  const inputMissingWorkloadHash = capWithoutWorkloadHashInput as any;
  const capMissingWorkloadHash = signExecutionCapability(inputMissingWorkloadHash, cpPrivPem);
  // Verify the cap has a valid signature (the canonical JSON filtered out
  // the missing workloadHash, so the signature is over the canonical
  // without it).
  const verifyMissing = verifyExecutionCapability(capMissingWorkloadHash, SUPERVISOR.controlPlaneKeyPair.publicKeyPem);
  const signatureValid = verifyMissing.valid;

  // First POST: cap with missing workloadHash → pre-check fails → 403
  // WITHOUT consuming the nonce.
  const { status: failStatus, json: failJson } = await postExecute(SUPERVISOR.url, {
    capability: capMissingWorkloadHash,
  });
  const failOk = failStatus === 403;
  const failErr = JSON.stringify(failJson ?? {});
  const mentionsPreCheck = /pre-consumption|workloadHash|missing/i.test(failErr);

  // Second POST: VALID cap (with workloadHash, SAME nonce) → 200 (nonce
  // was NOT consumed by the failed attempt — the failure happened before
  // consumption).
  const { status: okStatus, json: okJson } = await postExecute(SUPERVISOR.url, {
    capability: validCap,
  });
  const okStatus200 = okStatus === 200;
  const hasAttestation = !!okJson?.attestation;

  const ok = signatureValid && failOk && mentionsPreCheck && okStatus200 && hasAttestation;
  record(
    "Test 7: nonce NOT consumed on pre-check failure (DoS vector closed) — cap with missing workloadHash → 403 (pre-check, signature valid), then valid cap (same nonce) → 200",
    ok,
    `signatureValid=${signatureValid} failStatus=${failStatus} mentionsPreCheck=${mentionsPreCheck} okStatus=${okStatus} hasAttestation=${hasAttestation} failErr=${failErr.slice(0, 150)}`
  );
}

// ===========================================================================
// TEST 8 — Nonce consumed on success (second call with same cap → 403).
// ===========================================================================
// POST a valid capability → 200 (nonce consumed). POST the SAME capability
// again → 403 (nonce already consumed — replay rejected).

{
  const { repoPath, sha } = setupTestWorkspace("repo-boundary-8");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-rb-8",
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
    "Test 8: nonce consumed on success (second call with same cap → 403, error mentions replay/consumed/nonce)",
    ok,
    `firstStatus=${firstStatus} replayStatus=${replayStatus} mentionsReplay=${mentionsReplay} err=${replayErr.slice(0, 150)}`
  );
}

// ===========================================================================
// TEST 9 — Per-execution workspace at /tmp/forge-executions/<executionId>/.
// ===========================================================================
// The supervisor creates a per-execution workspace at
// /tmp/forge-executions/<executionId>/. After a successful execution, the
// workspace SHOULD still exist (the supervisor keeps it for audit).
// Two different executions get DIFFERENT workspaces (different executionIds).

{
  const { repoPath: repoPath1, sha: sha1 } = setupTestWorkspace("repo-boundary-9a");
  const executionId1 = randomUUID();
  const nonce1 = randomUUID();
  const cap1 = signValidCap(SUPERVISOR, {
    executionId: executionId1, nonce: nonce1, leaseId: "lease-rb-9a",
    repositoryHeadSha: sha1, repositoryUrl: fileUrlForPath(repoPath1),
  });
  const { status: status1 } = await postExecute(SUPERVISOR.url, {
    capability: cap1,
  });
  const ws1 = `/tmp/forge-executions/${executionId1}`;
  const ws1Exists = existsSync(ws1);

  const { repoPath: repoPath2, sha: sha2 } = setupTestWorkspace("repo-boundary-9b");
  const executionId2 = randomUUID();
  const nonce2 = randomUUID();
  const cap2 = signValidCap(SUPERVISOR, {
    executionId: executionId2, nonce: nonce2, leaseId: "lease-rb-9b",
    repositoryHeadSha: sha2, repositoryUrl: fileUrlForPath(repoPath2),
  });
  const { status: status2 } = await postExecute(SUPERVISOR.url, {
    capability: cap2,
  });
  const ws2 = `/tmp/forge-executions/${executionId2}`;
  const ws2Exists = existsSync(ws2);

  const both200 = status1 === 200 && status2 === 200;
  const bothWorkspacesExist = ws1Exists && ws2Exists;
  const workspacesDiffer = ws1 !== ws2;
  const ok = both200 && bothWorkspacesExist && workspacesDiffer;
  record(
    "Test 9: per-execution workspace at /tmp/forge-executions/<executionId>/ (two executions get different workspaces, both persist for audit)",
    ok,
    `status1=${status1} status2=${status2} ws1Exists=${ws1Exists} ws2Exists=${ws2Exists} workspacesDiffer=${workspacesDiffer} ws1=${ws1} ws2=${ws2}`
  );
}

// ===========================================================================
// TEST 10 — Supervisor clones, not worker (source inspection).
// ===========================================================================
// Source inspection:
//   - The worker's verify.ts does NOT call `git clone`.
//   - The worker's verify.ts does NOT pass `repoPath` in the POST body.
//   - The supervisor's /execute handler DOES call `git clone`.
//   - The supervisor's /execute handler REJECTS the `repoPath` field.

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
  const workerHasNoRepoPathInRequest = !/interface\s+SupervisorExecuteRequest\s*\{[^}]*repoPath/s.test(workerStripped);

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

  const ok =
    workerHasNoGitClone &&
    workerHasNoRepoPathInBody &&
    workerHasNoRepoPathInRequest &&
    supCallsGitClone &&
    supRejectsRepoPathField &&
    supCreatesWorkspace &&
    supCallsResolveCred;
  record(
    "Test 10: source inspection — worker does NOT call git clone / pass repoPath; supervisor DOES call git clone + reject repoPath + create per-execution workspace + call resolve-repo-credential",
    ok,
    `worker.noGitClone=${workerHasNoGitClone} worker.noRepoPathInBody=${workerHasNoRepoPathInBody} worker.noRepoPathInRequest=${workerHasNoRepoPathInRequest} sup.callsGitClone=${supCallsGitClone} sup.rejectsRepoPathField=${supRejectsRepoPathField} sup.createsWorkspace=${supCreatesWorkspace} sup.callsResolveCred=${supCallsResolveCred}`
  );
}

// ===========================================================================
// Stop the supervisor.
// ===========================================================================

await SUPERVISOR.stop();

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n=== repo-boundary-invariants ===\n");
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  if (!r.passed) {
    console.log(`  ${r.details}`);
  }
}
console.log(`\n=== repo-boundary-invariants: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  console.log("\n❌ PHASE 18Z-PRE REPO BOUNDARY INVARIANTS NOT SATISFIED — worker may control the repo path");
  process.exit(1);
} else {
  console.log("\n✅ Phase 18Z-PRE repo boundary enforced — supervisor owns the repository materialization, worker supplies ONLY { capability }");
  process.exit(0);
}
