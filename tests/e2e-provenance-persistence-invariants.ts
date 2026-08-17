// Forge — Phase 18Z.1-B: E2E Provenance + Persistence Closure Invariants.
//
// This is the DEFINITIVE adversarial acceptance test for Phase 18Z.1's TWO
// closures:
//
//   CLOSURE 1 (P0): workerId is no longer worker-controlled.
//     - workerId is a SIGNED field on ExecutionCapability (canonicalCapabilityJson
//       covers it).
//     - The supervisor REJECTS `workerId` from the request body (HTTP 403).
//     - The supervisor reads workerId from the signed capability
//       (`cap.workerId`) and binds it into the artifact manifest.
//     - verifyArtifactManifest checks the FULL 4-tuple binding:
//       { executionId, workerId, repositorySha, substrateInstanceId }.
//
//   CLOSURE 2 (P1): artifact persistence is fail-closed.
//     - The supervisor's persistence loop collects failures into
//       `persistFailures[]`; if ANY entry fails (path traversal, file not
//       found, store.store throws hash mismatch, post-store retrieve error,
//       post-store hash mismatch) → HTTP 500, manifest NOT returned.
//     - ArtifactStore.store(content, wrongSha256) THROWS "Content hash
//       mismatch".
//     - The control plane INDEPENDENTLY re-verifies every artifact is
//       retrievable (defense-in-depth); `artifactRetrievable` is part of the
//       production predicate (`canReachProductionReadyWithRuntime`).
//
// Tests:
//   1. worker-supplied workerId → REJECT (the P0)
//   2. manifest workerId matches capability (not body)
//   3. verifyArtifactManifest rejects wrong expected.workerId
//   4. verifyArtifactManifest rejects wrong expected.repositorySha
//   5. verifyArtifactManifest rejects wrong expected.substrateInstanceId
//   6. tampered manifest workerId → manifestHash mismatch
//   7. artifact persistence failure is fail-closed (supervisor source inspection)
//   8. ArtifactStore.store rejects hash mismatch
//   9. control plane verifies artifact retrievability (artifactRetrievable gate)
//   10. full E2E: valid execution produces retrievable artifacts
//   11. ExecutionCapability includes workerId as signed field
//   12. job-spec route signs workerId from token (source inspection)
//
// Run with: bun run tests/e2e-provenance-persistence-invariants.ts

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  computeManifestHash,
  signArtifactManifest,
  verifyArtifactManifest,
  makeTestManifest,
  type ArtifactManifest,
} from "@/lib/artifact-manifest";
import { ArtifactStore } from "@/lib/artifact-store";
import { generateLauncherKeyPair } from "@/lib/substrate-attestation";
import {
  generateWorkerKeyPair,
  verifyEvidenceEnvelope,
} from "@/lib/runtime-execution-contract";
import {
  canReachProductionReadyWithRuntime,
  getProductionReadinessFailureReason,
  type ProductionReadinessEvidence,
} from "@/lib/runtime-verification";
import {
  signExecutionCapability,
  verifyExecutionCapability,
  deriveWorkloadFromPlan,
  computeWorkloadHash,
} from "@/lib/execution-capability";

import { executeRuntimeVerificationInWorker, generateSubstrateNonce } from "../mini-services/execution-worker/runtime/verify.js";
import { startTestSupervisor, type TestSupervisor } from "./lib/test-supervisor.js";
import { setupTestWorkspace, makeTestPlan, fileUrlForPath } from "./lib/test-capability.js";

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
// Setup — generate launcher + worker keypairs, start the supervisor.
// ===========================================================================

const LAUNCHER_KEY = generateLauncherKeyPair();
const WORKER_KEY = generateWorkerKeyPair("e2e-provenance-worker");

const EXECUTION_ID = "exec-provenance-A";
const REPOSITORY_SHA = "0123456789abcdef0123456789abcdef01234567";
const WORKER_ID = "worker-provenance-A";
const SUBSTRATE_INSTANCE_ID = "33333333-3333-3333-3333-333333333333";

// Set FORGE_ARTIFACT_STORE_ROOT to a known temp dir BEFORE startTestSupervisor
// because the helper passes process.env through to the spawned child. The
// supervisor reads the env var at module load time.
const ARTIFACT_STORE_ROOT = mkdtempSync(join(tmpdir(), "forge-artifacts-18Z1-B-"));
process.env.FORGE_ARTIFACT_STORE_ROOT = ARTIFACT_STORE_ROOT;
console.log(`[e2e-provenance] Artifact store root: ${ARTIFACT_STORE_ROOT}`);

const SUPERVISOR: TestSupervisor = await startTestSupervisor();
const LAUNCHER_PUBLIC_KEY = SUPERVISOR.launcherPublicKey;
console.log(`[e2e-provenance] Supervisor started at ${SUPERVISOR.url}`);

// This is the SAME store root the supervisor uses (it reads
// FORGE_ARTIFACT_STORE_ROOT at module load time). We instantiate our own
// ArtifactStore at the same path to retrieve artifacts the supervisor
// persisted. The store is content-addressed so concurrent access is safe.
const ARTIFACT_STORE = new ArtifactStore(ARTIFACT_STORE_ROOT);

// ===========================================================================
// Helper — sign a valid capability with workerId bound in.
// ===========================================================================

function signValidCap(
  sup: TestSupervisor,
  opts: {
    executionId: string;
    nonce: string;
    leaseId: string;
    /** Phase 18Z.1: workerId bound into the capability. */
    workerId: string;
    repositoryHeadSha: string;
    repositoryUrl: string;
    expiresAt?: string;
  }
): ReturnType<typeof signExecutionCapability> {
  const plan = makeTestPlan(3000);
  return sup.signCapability({
    executionId: opts.executionId,
    nonce: opts.nonce,
    leaseId: opts.leaseId,
    workerId: opts.workerId,
    repositoryHeadSha: opts.repositoryHeadSha,
    repositoryUrl: opts.repositoryUrl,
    runtimePlanHash: "e2e-provenance-plan-hash",
    architectureHash: null,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });
}

/** POST a body to the supervisor's /execute. */
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

// ===========================================================================
// Shared state for Test 10 (full E2E).
// ===========================================================================

let test10Envelope: Awaited<ReturnType<typeof executeRuntimeVerificationInWorker>> | null = null;
let test10ExecutionId = "";
let test10WorkerId = "";
let test10Sha = "";

// ===========================================================================
// TEST 1 — worker-supplied workerId → REJECT (the P0).
// ===========================================================================
// POST to supervisor /execute with { capability, workerId: "impostor" }. The
// supervisor MUST reject the `workerId` field — it derives workerId from the
// signed capability, never from the worker's request body. The worker cannot
// forge a different identity by injecting a workerId field.

{
  const { repoPath, sha } = setupTestWorkspace("e2e-provenance-1");
  const executionId = randomUUID();
  const nonce = randomUUID();
  const cap = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-provenance-1",
    workerId: "real-worker-1",
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath),
  });
  const { status, json } = await postExecute(SUPERVISOR.url, {
    capability: cap,
    workerId: "impostor",
  });
  const ok = status === 403;
  const errMsg = json?.error ?? "";
  const mentions = /workerId/i.test(errMsg)
    || /not accepted/i.test(errMsg)
    || /capability/i.test(errMsg);
  record(
    "Test 1: worker-supplied 'workerId' field → REJECT (HTTP 403, error mentions workerId/not accepted/capability)",
    ok && mentions,
    `status=${status} error=${errMsg.slice(0, 160)}`
  );
}

// ===========================================================================
// TEST 2 — manifest workerId matches capability (not body).
// ===========================================================================
// Sign a capability with workerId: "real-worker". POST { capability } (NO body
// workerId). The supervisor runs the substrate, the launcher signs the
// manifest using cap.workerId (the value from the signed capability). Assert
// the returned manifest's workerId === "real-worker".

{
  const { repoPath, sha } = setupTestWorkspace("e2e-provenance-2");
  const executionId = randomUUID();
  const nonce = generateSubstrateNonce();
  const workerId = "real-worker";
  const plan = makeTestPlan(3000);
  const capability = signValidCap(SUPERVISOR, {
    executionId, nonce, leaseId: "lease-provenance-2",
    workerId,
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath),
  });

  const envelope = await executeRuntimeVerificationInWorker({
    executionId,
    workerId, // worker self-identifies for the envelope signature (must match cap.workerId)
    leaseId: "lease-provenance-2",
    repositoryHeadSha: sha,
    repositoryUrl: repoPath,
    architectureHash: null,
    runtimePlanHash: "e2e-provenance-plan-hash",
    plan,
    nonce,
    capability,
    supervisorUrl: SUPERVISOR.url,
    workerPrivateKeyPem: WORKER_KEY.privateKeyPem,
    totalTimeoutMs: 120000,
  });

  const manifest = envelope.artifactManifest;
  const manifestNonNull = manifest !== null && manifest !== undefined;
  // The manifest's workerId MUST match the capability's workerId, NOT any
  // worker-supplied body value. The worker never sent a workerId in the body
  // (executeRuntimeVerificationInWorker posts only { capability }).
  const workerIdMatches = manifestNonNull && manifest!.workerId === workerId;
  // Defense-in-depth: the manifest verifies with the right expected.workerId.
  const verification = manifestNonNull
    ? verifyArtifactManifest(manifest, LAUNCHER_PUBLIC_KEY, {
        executionId,
        workerId,
        repositorySha: sha,
        substrateInstanceId: envelope.substrateAttestation?.substrateInstanceId ?? "",
      })
    : { valid: false, reasons: ["manifest is null"] };

  const ok = manifestNonNull && workerIdMatches && verification.valid;
  record(
    "Test 2: manifest workerId matches capability (not body) — POST { capability } only, manifest.workerId === cap.workerId",
    ok,
    `manifestNonNull=${manifestNonNull} workerIdMatches=${workerIdMatches} verify.valid=${verification.valid} manifest.workerId=${manifestNonNull ? manifest!.workerId : "(null)"} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 3 — verifyArtifactManifest rejects wrong expected.workerId.
// ===========================================================================
// Take a valid manifest (workerId = "real-worker"). Call
// verifyArtifactManifest(manifest, pubKey, { executionId, workerId: "wrong",
// repositorySha, substrateInstanceId }). Assert valid === false AND reason
// mentions "workerId mismatch".

{
  const manifest = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  });
  const verification = verifyArtifactManifest(
    manifest,
    LAUNCHER_KEY.publicKeyPem,
    {
      executionId: EXECUTION_ID,
      workerId: "wrong-worker-id",
      repositorySha: REPOSITORY_SHA,
      substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    }
  );
  const workerIdReason = verification.reasons.some((r) =>
    r.includes("workerId mismatch")
  );
  record(
    "Test 3: verifyArtifactManifest rejects wrong expected.workerId (reason mentions 'workerId mismatch')",
    !verification.valid && workerIdReason,
    `valid=${verification.valid} workerIdReason=${workerIdReason} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 4 — verifyArtifactManifest rejects wrong expected.repositorySha.
// ===========================================================================
// Same pattern as Test 3, but the expected.repositorySha is wrong. Assert
// valid === false AND reason mentions "repositorySha mismatch".

{
  const manifest = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  });
  const verification = verifyArtifactManifest(
    manifest,
    LAUNCHER_KEY.publicKeyPem,
    {
      executionId: EXECUTION_ID,
      workerId: WORKER_ID,
      repositorySha: "f".repeat(40), // wrong SHA
      substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    }
  );
  const repoReason = verification.reasons.some((r) =>
    r.includes("repositorySha mismatch")
  );
  record(
    "Test 4: verifyArtifactManifest rejects wrong expected.repositorySha (reason mentions 'repositorySha mismatch')",
    !verification.valid && repoReason,
    `valid=${verification.valid} repoReason=${repoReason} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 5 — verifyArtifactManifest rejects wrong expected.substrateInstanceId.
// ===========================================================================
// Same pattern as Tests 3-4, but the expected.substrateInstanceId is wrong.

{
  const manifest = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  });
  const verification = verifyArtifactManifest(
    manifest,
    LAUNCHER_KEY.publicKeyPem,
    {
      executionId: EXECUTION_ID,
      workerId: WORKER_ID,
      repositorySha: REPOSITORY_SHA,
      substrateInstanceId: "99999999-9999-9999-9999-999999999999", // wrong
    }
  );
  const subInstReason = verification.reasons.some((r) =>
    r.includes("substrateInstanceId mismatch")
  );
  record(
    "Test 5: verifyArtifactManifest rejects wrong expected.substrateInstanceId (reason mentions 'substrateInstanceId mismatch')",
    !verification.valid && subInstReason,
    `valid=${verification.valid} subInstReason=${subInstReason} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 6 — tampered manifest workerId → manifestHash mismatch.
// ===========================================================================
// Take a valid manifest. Change the manifest's workerId WITHOUT recomputing
// manifestHash or re-signing. The manifestHash no longer matches the content
// (workerId is part of the canonical form) → verifyArtifactManifest rejects
// with "manifestHash does not match manifest content".

{
  const manifest = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  });
  // Tamper: change workerId without recomputing manifestHash or re-signing.
  const tampered: ArtifactManifest = {
    ...manifest,
    workerId: "tampered-worker-id",
  };
  const verification = verifyArtifactManifest(
    tampered,
    LAUNCHER_KEY.publicKeyPem,
    {
      executionId: EXECUTION_ID,
      // Use the TAMPERED workerId as expected, so the binding check would
      // pass — but the manifestHash check should fail (the hash was computed
      // over the ORIGINAL workerId, not the tampered value).
      workerId: "tampered-worker-id",
      repositorySha: REPOSITORY_SHA,
      substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    }
  );
  const hashReason = verification.reasons.some((r) =>
    r.includes("manifestHash does not match")
  );
  record(
    "Test 6: tampered manifest workerId (without re-signing) → manifestHash mismatch (content changed, signature no longer covers it)",
    !verification.valid && hashReason,
    `valid=${verification.valid} hashReason=${hashReason} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 7 — artifact persistence failure is fail-closed (supervisor source inspection).
// ===========================================================================
// Read the supervisor's source code. Assert:
//   - It collects failures into a `persistFailures` array.
//   - It returns HTTP 500 if persistFailures.length > 0.
//   - The manifest is NOT returned when persistence fails (the 500 path
//     `return`s before the success response).
//
// This is a source-inspection test (not a runtime test) because:
//   - The launcher is real and produces a CORRECT manifest. We can't make it
//     produce a wrong-sha256 manifest without modifying the C launcher.
//   - Mocking the store would require refactoring the supervisor to accept an
//     injected store, which is out of scope for 18Z.1-B (it's a test-only
//     concern).
//   - The combination of THIS source inspection + Test 8 (ArtifactStore.store
//     rejects hash mismatch) + Test 10 (real E2E produces retrievable
//     artifacts) covers the closure: if the store ever throws, the supervisor
//     catches it into persistFailures and returns 500.

{
  const supervisorPath = resolve(
    process.cwd(),
    "mini-services/substrate-supervisor/index.ts"
  );
  const src = readFileSync(supervisorPath, "utf-8");

  // Extract the persistence block — from `if (manifest && Array.isArray(manifest.entries))`
  // through the `return;` that follows the 500 sendJson. This isolates the
  // fail-closed persistence code from the unrelated "best-effort" comment
  // about reading results.json at line 651.
  const persistBlockMatch = src.match(
    /if\s*\(manifest\s*&&\s*Array\.isArray\(manifest\.entries\)\)\s*\{[\s\S]*?sendJson\(res,\s*500,[\s\S]*?return;/
  );
  const persistBlock = persistBlockMatch ? persistBlockMatch[0] : "";

  // 1. The supervisor collects failures into a persistFailures array.
  const hasPersistFailuresArray = persistBlock.includes("persistFailures");
  // 2. The supervisor returns HTTP 500 if persistFailures.length > 0 (and
  //    `return`s — does NOT fall through to the 200 path).
  const has500OnFailure = /persistFailures\.length\s*>\s*0/.test(persistBlock)
    && /sendJson\(\s*res,\s*500/.test(persistBlock)
    && /return;/.test(persistBlock);
  // 3. The supervisor catches store.store errors (hash mismatch) into
  //    persistFailures (fail-closed, not best-effort).
  const catchesStoreError = /artifactStore\.store\(content,\s*entry\.sha256\)/.test(persistBlock)
    && /storeErr/.test(persistBlock)
    && /persistFailures\.push/.test(persistBlock);
  // 4. The persistence block does NOT silently log + return 200 on store
  //    failure (no console.warn inside the block — pre-18Z.1 behavior was
  //    best-effort logging that let a worker submit a manifest whose
  //    artifacts were never actually persisted).
  const noBestEffortLogging = !/console\.warn/.test(persistBlock)
    && !/console\.log.*artifact/i.test(persistBlock);
  // 5. The manifest is NOT returned when persistence fails — the 500 path
  //    returns BEFORE the success response. (Proven by the `return;` in
  //    check #2.)
  const manifestNotReturnedOnFailure = has500OnFailure;

  const ok = hasPersistFailuresArray && has500OnFailure && catchesStoreError && noBestEffortLogging && manifestNotReturnedOnFailure;
  record(
    "Test 7: artifact persistence failure is fail-closed (supervisor source inspection — persistFailures[] array, HTTP 500 + return on length>0, catches store.store error, no best-effort logging in persistence block, manifest not returned on failure)",
    ok,
    `persistBlockLen=${persistBlock.length} hasPersistFailuresArray=${hasPersistFailuresArray} has500OnFailure=${has500OnFailure} catchesStoreError=${catchesStoreError} noBestEffortLogging=${noBestEffortLogging} manifestNotReturnedOnFailure=${manifestNotReturnedOnFailure}`
  );
}

// ===========================================================================
// TEST 8 — ArtifactStore.store rejects hash mismatch.
// ===========================================================================
// const store = new ArtifactStore(tmpDir);
// store.store(Buffer.from("content"), "0000...wrong") → throws "Content hash
// mismatch" (the store verifies the declared hash matches the content's
// actual SHA-256 — fail-closed).

{
  const storeRoot = mkdtempSync(join(tmpdir(), "forge-artifact-store-mismatch-18Z1-"));
  const store = new ArtifactStore(storeRoot);
  const content = Buffer.from("actual-content-for-18Z1-mismatch-test", "utf-8");
  const wrongSha = "0".repeat(64); // doesn't match content
  let threw = false;
  let errMsg = "";
  try {
    store.store(content, wrongSha);
  } catch (err) {
    threw = true;
    errMsg = err instanceof Error ? err.message : String(err);
  }
  const ok = threw && /mismatch/i.test(errMsg);
  record(
    "Test 8: ArtifactStore.store rejects hash mismatch (declared sha256 ≠ actual → throws 'Content hash mismatch')",
    ok,
    `threw=${threw} errMsg=${errMsg.slice(0, 140)}`
  );
  rmSync(storeRoot, { recursive: true, force: true });
}

// ===========================================================================
// TEST 9 — control plane verifies artifact retrievability.
// ===========================================================================
// Construct a ProductionReadinessEvidence with artifactRetrievable: false
// (all other conditions true). Assert:
//   - canReachProductionReadyWithRuntime(evidence) === false.
//   - getProductionReadinessFailureReason(evidence) mentions "artifact" or
//     "retrievable".

{
  const evidenceFail: ProductionReadinessEvidence = {
    architectureFrozen: true,
    allTasksCompleted: true,
    allTasksIntegrated: true,
    staticReadinessPassed: true,
    runtimeVerificationPassed: true,
    runtimeEvidencePersisted: true,
    executionEnvironmentSandboxed: true,
    substrateAttestationVerified: true,
    artifactManifestVerified: true,
    artifactRetrievable: false, // The failure we're testing.
    repositoryHeadVerified: true,
  };
  const canReachFail = canReachProductionReadyWithRuntime(evidenceFail);
  const reasonFail = getProductionReadinessFailureReason(evidenceFail) ?? "";
  const reasonMentions = /artifact/i.test(reasonFail) || /retrievable/i.test(reasonFail);

  // Pass case: all conditions true (including artifactRetrievable).
  const evidencePass: ProductionReadinessEvidence = {
    ...evidenceFail,
    artifactRetrievable: true,
  };
  const canReachPass = canReachProductionReadyWithRuntime(evidencePass);

  const ok = canReachFail === false && reasonMentions && canReachPass === true;
  record(
    "Test 9: control plane verifies artifact retrievability (artifactRetrievable=false → blocked, reason mentions artifact/retrievable; true + all others → canReach=true)",
    ok,
    `canReachFail=${canReachFail} reasonMentions=${reasonMentions} reason=${reasonFail.slice(0, 160)} canReachPass=${canReachPass}`
  );
}

// ===========================================================================
// TEST 10 — full E2E: valid execution produces retrievable artifacts.
// ===========================================================================
// Start supervisor, sign capability with workerId, run execution via
// executeRuntimeVerificationInWorker. Assert:
//   - The manifest is valid (verifyArtifactManifest returns true).
//   - All artifacts are retrievable from the ArtifactStore.
//   - The retrieved content hashes to the declared sha256.
//   - artifactRetrievable would be true (the control plane's check passes).

{
  const { repoPath, sha } = setupTestWorkspace("e2e-provenance-10");
  const executionId = randomUUID();
  const workerId = "e2e-provenance-worker-10";
  const plan = makeTestPlan(3000);
  const capability = signValidCap(SUPERVISOR, {
    executionId, nonce: generateSubstrateNonce(),
    leaseId: "lease-provenance-10",
    workerId,
    repositoryHeadSha: sha, repositoryUrl: fileUrlForPath(repoPath),
  });
  test10ExecutionId = executionId;
  test10WorkerId = workerId;
  test10Sha = sha;

  const envelope = await executeRuntimeVerificationInWorker({
    executionId,
    workerId,
    leaseId: "lease-provenance-10",
    repositoryHeadSha: sha,
    repositoryUrl: repoPath,
    architectureHash: null,
    runtimePlanHash: "e2e-provenance-plan-hash",
    plan,
    nonce: capability.nonce,
    capability,
    supervisorUrl: SUPERVISOR.url,
    workerPrivateKeyPem: WORKER_KEY.privateKeyPem,
    totalTimeoutMs: 120000,
  });
  test10Envelope = envelope;

  const manifest = envelope.artifactManifest;
  const manifestNonNull = manifest !== null && manifest !== undefined;
  const verification = manifestNonNull
    ? verifyArtifactManifest(manifest, LAUNCHER_PUBLIC_KEY, {
        executionId,
        workerId,
        repositorySha: sha,
        substrateInstanceId: envelope.substrateAttestation?.substrateInstanceId ?? "",
      })
    : { valid: false, reasons: ["manifest is null"] };

  // Every entry must be retrievable + content hash must match.
  let allRetrievable = false;
  let retrievabilityDetails = "";
  if (manifestNonNull) {
    let allOk = true;
    const details: string[] = [];
    for (const entry of manifest!.entries) {
      try {
        if (!ARTIFACT_STORE.exists(entry.sha256)) {
          allOk = false;
          details.push(`${entry.artifactId}=MISSING`);
          continue;
        }
        const content = ARTIFACT_STORE.retrieve(entry.sha256);
        const actualHash = createHash("sha256").update(content).digest("hex");
        if (actualHash !== entry.sha256) {
          allOk = false;
          details.push(`${entry.artifactId}=HASH_MISMATCH`);
        } else {
          details.push(`${entry.artifactId}=OK`);
        }
      } catch (err) {
        allOk = false;
        details.push(`${entry.artifactId}=ERROR:${err instanceof Error ? err.message.slice(0, 60) : String(err)}`);
      }
    }
    allRetrievable = allOk;
    retrievabilityDetails = details.join(", ");
  }

  // The control plane's artifactRetrievable predicate would be true here.
  const controlPlaneArtifactRetrievable = manifestNonNull && verification.valid && allRetrievable;

  const ok = manifestNonNull && verification.valid && allRetrievable && controlPlaneArtifactRetrievable;
  record(
    "Test 10: full E2E — valid execution produces retrievable artifacts (manifest valid, all entries retrievable, content hashes match, artifactRetrievable would be true)",
    ok,
    `manifestNonNull=${manifestNonNull} verify.valid=${verification.valid} allRetrievable=${allRetrievable} artifactRetrievable=${controlPlaneArtifactRetrievable} entries=${manifestNonNull ? manifest!.entries.length : 0}\n  ${retrievabilityDetails}`
  );
}

// ===========================================================================
// TEST 11 — ExecutionCapability includes workerId as signed field.
// ===========================================================================
// Construct a capability with workerId: "test-worker-11". Verify
// verifyExecutionCapability(cap, pubKey).valid === true. Then tamper: change
// workerId to "other" → verifyExecutionCapability === false (the signature no
// longer matches the canonical form because workerId is part of it).

{
  const executionId = randomUUID();
  const nonce = randomUUID();
  const leaseId = "lease-cap-11";
  const workerId = "test-worker-11";
  const repoSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const repoUrl = "file:///tmp/test-repo-11";
  const plan = makeTestPlan(3000);
  const cap = SUPERVISOR.signCapability({
    executionId,
    nonce,
    leaseId,
    workerId,
    repositoryHeadSha: repoSha,
    repositoryUrl: repoUrl,
    runtimePlanHash: "e2e-provenance-cap-plan-hash",
    architectureHash: null,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    runtimePlan: plan as unknown as Record<string, unknown>,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
  });

  // 1. Valid capability verifies.
  const validResult = verifyExecutionCapability(cap, SUPERVISOR.controlPlaneKeyPair.publicKeyPem);
  const validOk = validResult.valid;

  // 2. Tampered workerId → signature broken.
  const tampered: typeof cap = {
    ...cap,
    workerId: "other-worker",
  };
  const tamperedResult = verifyExecutionCapability(tampered, SUPERVISOR.controlPlaneKeyPair.publicKeyPem);
  const tamperedRejected = !tamperedResult.valid;
  // The reason should mention signature (since workerId is in the canonical
  // form, changing it invalidates the signature).
  const signatureReason = tamperedResult.reasons.some((r) =>
    /signature/i.test(r) || /INVALID/i.test(r)
  );

  const ok = validOk && tamperedRejected && signatureReason;
  record(
    "Test 11: ExecutionCapability includes workerId as signed field (valid cap verifies; tampering workerId breaks signature)",
    ok,
    `validOk=${validOk} tamperedRejected=${tamperedRejected} signatureReason=${signatureReason} validReasons=${JSON.stringify(validResult.reasons.slice(0, 2))} tamperedReasons=${JSON.stringify(tamperedResult.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 12 — job-spec route signs workerId from token (source inspection).
// ===========================================================================
// Read src/app/api/worker/job-spec/route.ts. Assert it contains
// `workerId: token.workerId` or `workerId:.*token` — proving the capability
// is signed with the workerId derived from the authenticated token (NOT from
// the request body).

{
  const routePath = resolve(
    process.cwd(),
    "src/app/api/worker/job-spec/route.ts"
  );
  const src = readFileSync(routePath, "utf-8");
  // Look for the workerId field assignment from token.
  const hasWorkerIdFromToken = /workerId:\s*token\.workerId/.test(src)
    || /workerId:\s*token\.\w+/.test(src);
  // Defense-in-depth: also confirm the comment block explaining 18Z.1 is
  // present (so future maintainers know the rationale).
  const hasComment = /Phase 18Z\.1/.test(src) && /workerId/.test(src);

  const ok = hasWorkerIdFromToken && hasComment;
  record(
    "Test 12: job-spec route signs workerId from token (source inspection — `workerId: token.workerId` + Phase 18Z.1 comment)",
    ok,
    `hasWorkerIdFromToken=${hasWorkerIdFromToken} hasComment=${hasComment}`
  );
}

// ===========================================================================
// Stop the supervisor.
// ===========================================================================

await SUPERVISOR.stop();

// Clean up the artifact store root (test-only).
try {
  rmSync(ARTIFACT_STORE_ROOT, { recursive: true, force: true });
} catch {
  // Best-effort — don't fail the test on cleanup.
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n=== e2e-provenance-persistence-invariants ===\n");
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  if (!r.passed) {
    console.log(`  ${r.details}`);
  }
}
console.log(`\n=== e2e-provenance-persistence-invariants: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  console.log("\n❌ PHASE 18Z.1-B ADVERSARIAL TESTS FAILED — provenance + persistence closure not satisfied");
  process.exit(1);
} else {
  console.log("\n✅ Phase 18Z.1-B adversarial tests PASSED — workerId is signed-into-the-capability (worker cannot forge it), artifact persistence is fail-closed (supervisor returns 500 + control plane independently re-verifies retrievability). All 12 attack vectors REJECTED, real substrate produces retrievable artifacts end-to-end.");
  process.exit(0);
}
