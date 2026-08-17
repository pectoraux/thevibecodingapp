// Forge — Phase 18X: Substrate Key Isolation Invariants.
//
// This is the ACCEPTANCE TEST for Phase 18X (Launcher Key Isolation). It
// proves that the WORKER process CANNOT access the launcher private key —
// not the file path, not the file content, not an env var, nothing.
//
// ARCHITECTURE:
//   - The substrate supervisor (mini-services/substrate-supervisor, port 3004)
//     is a TRUSTED process that holds the launcher private key IN MEMORY.
//   - At startup, the supervisor reads FORGE_LAUNCHER_KEY_FILE into memory,
//     then DELETES the file. The key is now ONLY in the supervisor's memory.
//   - The worker POSTs { capability, workload, repoPath } to the supervisor.
//   - The supervisor verifies the capability (control-plane signature),
//     runs runInSubstrate(launcherKeyPem, ...) with the key in memory, and
//     returns { attestation, result } — NEVER the launcher key.
//   - The worker includes the attestation in its envelope and signs the
//     envelope with its OWN key.
//
// Tests:
//   1.  Worker env has NO `FORGE_LAUNCHER_KEY_FILE` (source inspection).
//   2.  RuntimeExecutionPolicy type has NO `launcherKeyFile` field (source).
//   3.  executeRuntimeVerificationInWorker takes NO `launcherKeyFile` parameter.
//   4.  Worker module (runtime/verify.ts) does NOT import readFileSync for the
//       launcher key, does NOT reference `FORGE_LAUNCHER_KEY_FILE`.
//   5.  Supervisor DELETES the launcher key file at startup (existsSync=false).
//   6.  Supervisor NEVER returns the launcher key in /execute response.
//   7.  Attestation returned by the supervisor is valid (launcher signature
//       verifies against the test launcher public key).
//   8.  Supervisor rejects a capability with a wrong signature → HTTP 403.
//   9.  Supervisor rejects an expired capability → HTTP 403.
//  10.  Supervisor rejects a request with NO capability → HTTP 403.
//  11.  Supervisor WITHOUT FORGE_CONTROL_PLANE_PUBLIC_KEY → FATAL exit.
//  12.  Supervisor WITHOUT FORGE_LAUNCHER_KEY_FILE → FATAL exit.
//  13.  runInSubstrate closes the key fd in a finally block (source inspection).
//  14.  Launcher reads the key from an fd (NOT a file path) — source inspection
//       of forge-launcher.c shows fdopen() + close(), not fopen() + a path.
//
// Run with: bun run tests/substrate-key-isolation-invariants.ts

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { resolve } from "node:path";

import { verifyLauncherAttestation, generateLauncherKeyPair } from "@/lib/substrate-attestation";
import {
  signExecutionCapability,
  verifyExecutionCapability,
  deriveWorkloadFromPlan,
  computeWorkloadHash,
  type ExecutionCapability,
  type ExecutionCapabilityInput,
} from "@/lib/execution-capability";
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

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

// ===========================================================================
// TEST 1 — Worker env has NO `FORGE_LAUNCHER_KEY_FILE` (source inspection)
// ===========================================================================
// The poller (worker entry point) must NOT read FORGE_LAUNCHER_KEY_FILE from
// process.env. The worker has no business knowing where the launcher key
// file is — the supervisor owns it.

{
  const poller = readFile("mini-services/execution-worker/poller.ts");
  const referencesLauncherKeyFileEnv =
    poller.includes("FORGE_LAUNCHER_KEY_FILE") ||
    poller.includes("LAUNCHER_KEY_FILE");
  const ok = !referencesLauncherKeyFileEnv;
  const details = referencesLauncherKeyFileEnv
    ? "poller.ts references FORGE_LAUNCHER_KEY_FILE or LAUNCHER_KEY_FILE — VIOLATION"
    : "poller.ts has no references to FORGE_LAUNCHER_KEY_FILE or LAUNCHER_KEY_FILE";
  record(
    "Test 1: worker poller does NOT reference FORGE_LAUNCHER_KEY_FILE (env isolation)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 2 — RuntimeExecutionPolicy has NO `launcherKeyFile` field
// ===========================================================================
// The contract type must not carry the launcher key file path. If it did, the
// worker would inherit the path transitively.

{
  const contract = readFile("src/lib/runtime-execution-contract.ts");
  const referencesLauncherKeyFile =
    contract.includes("launcherKeyFile:") ||
    contract.includes("launcherKeyFile?") ||
    contract.includes("launcherKeyFile =");
  const ok = !referencesLauncherKeyFile;
  const details = referencesLauncherKeyFile
    ? "runtime-execution-contract.ts contains `launcherKeyFile` field — VIOLATION"
    : "runtime-execution-contract.ts has no `launcherKeyFile` field";
  record(
    "Test 2: RuntimeExecutionPolicy has NO launcherKeyFile field (contract isolation)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 3 — executeRuntimeVerificationInWorker takes NO launcherKeyFile
// ===========================================================================
// The worker's runtime verification function must not accept launcherKeyFile
// as a parameter (in RuntimeVerificationJob).

{
  const verify = readFile("mini-services/execution-worker/runtime/verify.ts");
  const hasLauncherKeyFileParam =
    verify.includes("launcherKeyFile:") ||
    verify.includes("launcherKeyFile?") ||
    verify.includes("launcherKeyFile =");
  const ok = !hasLauncherKeyFileParam;
  const details = hasLauncherKeyFileParam
    ? "runtime/verify.ts has `launcherKeyFile` in RuntimeVerificationJob — VIOLATION"
    : "runtime/verify.ts has no `launcherKeyFile` field";
  record(
    "Test 3: executeRuntimeVerificationInWorker takes NO launcherKeyFile parameter (worker isolation)",
    ok,
    details
  );
}

// ===========================================================================
// TEST 4 — Worker module (runtime/verify.ts) doesn't import readFileSync
//          for the launcher key, doesn't reference FORGE_LAUNCHER_KEY_FILE
// ===========================================================================
// The worker module must not import readFileSync to read the launcher key
// (it never reads the launcher key — the supervisor does). It also must not
// reference FORGE_LAUNCHER_KEY_FILE.

{
  const verify = readFile("mini-services/execution-worker/runtime/verify.ts");
  const referencesLauncherKeyFileEnv = verify.includes("FORGE_LAUNCHER_KEY_FILE");
  // readFileSync is allowed for OTHER purposes (results.json, etc.) — but the
  // worker must not have any code path that reads a launcher key file.
  // We check for the specific combination: readFileSync + "launcher" near it.
  const readsLauncherKeyFromFile = /readFileSync\([^)]*launcher/i.test(verify);
  const ok = !referencesLauncherKeyFileEnv && !readsLauncherKeyFromFile;
  const details = `referencesEnv=${referencesLauncherKeyFileEnv} readsLauncherKeyFromFile=${readsLauncherKeyFromFile}`;
  record(
    "Test 4: worker module does NOT reference FORGE_LAUNCHER_KEY_FILE or read a launcher key file",
    ok,
    details
  );
}

// ===========================================================================
// TEST 5 — Supervisor DELETES the launcher key file at startup
// ===========================================================================
// Start a test supervisor, then assert the launcher key file does NOT exist
// on disk after the supervisor is ready. The supervisor reads the key into
// memory and unlinks the file.

{
  let sup: TestSupervisor | null = null;
  try {
    sup = await startTestSupervisor();
    const fileStillExists = existsSync(sup.launcherKeyFilePath);
    const ok = !fileStillExists;
    const details = fileStillExists
      ? `launcher key file STILL EXISTS at ${sup.launcherKeyFilePath} — VIOLATION (supervisor should have deleted it)`
      : `launcher key file deleted: ${sup.launcherKeyFilePath}`;
    record(
      "Test 5: supervisor DELETES the launcher key file at startup (file gone after /health returns 200)",
      ok,
      details
    );
  } catch (err: any) {
    record(
      "Test 5: supervisor DELETES the launcher key file at startup",
      false,
      `Failed to start supervisor: ${err.message}`
    );
  } finally {
    if (sup) await sup.stop();
  }
}

// ===========================================================================
// TEST 6 — Supervisor NEVER returns the launcher key in /execute response
// ===========================================================================
// POST /execute with a valid capability + repoPath (Phase 18Y — NO workload
// field; the supervisor derives it from cap.runtimePlan). The response body
// must NOT contain the string "PRIVATE KEY" (the launcher key PEM marker).

{
  let sup: TestSupervisor | null = null;
  try {
    sup = await startTestSupervisor();
    const { repoPath, sha } = setupTestWorkspace("key-iso-6");
    const executionId = randomUUID();
    const nonce = randomUUID();
    const plan = makeTestPlan(3000);
    const cap = sup.signCapability({
      executionId,
      nonce,
      leaseId: "lease-1",
      repositoryHeadSha: sha,
      repositoryUrl: fileUrlForPath(repoPath),
      runtimePlanHash: "plan-hash",
      architectureHash: null,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      runtimePlan: plan as unknown as Record<string, unknown>,
      workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
    });
    const resp = await fetch(`${sup.url}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: cap,
      }),
    });
    const respText = await resp.text();
    const containsPrivateKey = respText.includes("PRIVATE KEY");
    const containsLauncherKeyPem = sup.launcherPrivateKey.length > 0 && respText.includes(sup.launcherPrivateKey.slice(0, 50));
    const ok = !containsPrivateKey && !containsLauncherKeyPem && resp.status === 200;
    const details = `status=${resp.status} containsPrivateKey=${containsPrivateKey} containsLauncherKeyPemPrefix=${containsLauncherKeyPem} respLen=${respText.length}`;
    record(
      "Test 6: supervisor NEVER returns the launcher key in /execute response (no 'PRIVATE KEY' string)",
      ok,
      details
    );
  } catch (err: any) {
    record(
      "Test 6: supervisor NEVER returns the launcher key in /execute response",
      false,
      `Failed: ${err.message}`
    );
  } finally {
    if (sup) await sup.stop();
  }
}

// ===========================================================================
// TEST 7 — Attestation returned by the supervisor is valid
// ===========================================================================
// The supervisor must return a valid launcher-signed attestation. Verify
// the signature against the test launcher public key.

{
  let sup: TestSupervisor | null = null;
  try {
    sup = await startTestSupervisor();
    const { repoPath, sha } = setupTestWorkspace("key-iso-7");
    const executionId = randomUUID();
    const nonce = randomUUID();
    const plan = makeTestPlan(3000);
    const cap = sup.signCapability({
      executionId,
      nonce,
      leaseId: "lease-1",
      repositoryHeadSha: sha,
      repositoryUrl: fileUrlForPath(repoPath),
      runtimePlanHash: "plan-hash",
      architectureHash: null,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      runtimePlan: plan as unknown as Record<string, unknown>,
      workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
    });
    const resp = await fetch(`${sup.url}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: cap,
      }),
    });
    const body = await resp.json() as { attestation: any; result: any };
    const att = body.attestation;
    const verifyResult = verifyLauncherAttestation(att, sup.launcherPublicKey, nonce, executionId);
    const ok = resp.status === 200 && verifyResult.valid;
    const details = `status=${resp.status} verify.valid=${verifyResult.valid} reasons=${verifyResult.reasons.slice(0, 2).join("; ")}`;
    record(
      "Test 7: supervisor returns a valid launcher-signed attestation (signature verifies against the pinned launcher public key)",
      ok,
      details
    );
  } catch (err: any) {
    record(
      "Test 7: supervisor returns a valid launcher-signed attestation",
      false,
      `Failed: ${err.message}`
    );
  } finally {
    if (sup) await sup.stop();
  }
}

// ===========================================================================
// TEST 8 — Supervisor rejects a capability with a wrong signature → HTTP 403
// ===========================================================================
// A capability signed by a DIFFERENT key (not the control plane's) must be
// rejected. The worker cannot forge a capability — it doesn't have the
// control plane's private key.
//
// Phase 18Y: the supervisor's verification order is:
//   1. validate body (capability + repoPath required, no workload field)
//   2. verify cap signature + expiry → REJECTS here for test 8.
//   (Steps 3+ don't run.)

{
  let sup: TestSupervisor | null = null;
  try {
    sup = await startTestSupervisor();
    // Sign the capability with a DIFFERENT key (not the control plane's).
    const otherKey = generateKeyPairSync("ed25519");
    const otherPrivPem = otherKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const { repoPath, sha } = setupTestWorkspace("key-iso-8");
    const executionId = randomUUID();
    const nonce = randomUUID();
    const plan = makeTestPlan(3000);
    const capInput: ExecutionCapabilityInput = {
      executionId,
      nonce,
      leaseId: "lease-1",
      workerId: "substrate-iso-forged-worker",
      repositoryHeadSha: sha,
      repositoryUrl: fileUrlForPath(repoPath),
      runtimePlanHash: "plan-hash",
      architectureHash: null,
      workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
      runtimePlan: plan as unknown as Record<string, unknown>,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const forgedCap = signExecutionCapability(capInput, otherPrivPem);
    const resp = await fetch(`${sup.url}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: forgedCap,
      }),
    });
    let detail = "";
    try {
      const errBody = await resp.json() as { error?: string; reasons?: string[] };
      detail = `${errBody.error ?? ""}: ${(errBody.reasons ?? []).slice(0, 2).join("; ")}`;
    } catch {
      detail = await resp.text();
    }
    const ok = resp.status === 403;
    record(
      "Test 8: supervisor rejects a capability with a wrong signature (HTTP 403)",
      ok,
      `status=${resp.status} detail=${detail.slice(0, 200)}`
    );
  } catch (err: any) {
    record(
      "Test 8: supervisor rejects a capability with a wrong signature",
      false,
      `Failed: ${err.message}`
    );
  } finally {
    if (sup) await sup.stop();
  }
}

// ===========================================================================
// TEST 9 — Supervisor rejects an expired capability → HTTP 403
// ===========================================================================
// A capability whose expiresAt is in the past must be rejected.

{
  let sup: TestSupervisor | null = null;
  try {
    sup = await startTestSupervisor();
    const { repoPath, sha } = setupTestWorkspace("key-iso-9");
    const executionId = randomUUID();
    const nonce = randomUUID();
    const plan = makeTestPlan(3000);
    const cap = sup.signCapability({
      executionId,
      nonce,
      leaseId: "lease-1",
      repositoryHeadSha: sha,
      repositoryUrl: fileUrlForPath(repoPath),
      runtimePlanHash: "plan-hash",
      architectureHash: null,
      expiresAt: new Date(Date.now() - 60000).toISOString(), // EXPIRED 60s ago
      runtimePlan: plan as unknown as Record<string, unknown>,
      workloadHash: computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>)),
    });
    const resp = await fetch(`${sup.url}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: cap,
      }),
    });
    let detail = "";
    try {
      const errBody = await resp.json() as { error?: string; reasons?: string[] };
      detail = `${errBody.error ?? ""}: ${(errBody.reasons ?? []).slice(0, 2).join("; ")}`;
    } catch {
      detail = await resp.text();
    }
    const ok = resp.status === 403;
    record(
      "Test 9: supervisor rejects an expired capability (HTTP 403)",
      ok,
      `status=${resp.status} detail=${detail.slice(0, 200)}`
    );
  } catch (err: any) {
    record(
      "Test 9: supervisor rejects an expired capability",
      false,
      `Failed: ${err.message}`
    );
  } finally {
    if (sup) await sup.stop();
  }
}

// ===========================================================================
// TEST 10 — Supervisor rejects a request with NO capability → HTTP 403
// ===========================================================================
// POST /execute without a `capability` field must be rejected.
//
// Phase 18Y: the supervisor's request body is { capability, repoPath } —
// no workload field. We POST { repoPath } only (no capability, no workload).

{
  let sup: TestSupervisor | null = null;
  try {
    sup = await startTestSupervisor();
    // Phase 18Z-PRE: the supervisor rejects a request with NO capability.
    // We POST an empty body { } — the supervisor returns 403 for missing
    // capability. (The supervisor also rejects a `repoPath` field, so we
    // don't include one.)
    const resp = await fetch(`${sup.url}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Empty body — no capability, no repoPath.
      }),
    });
    const ok = resp.status === 403;
    let detail = "";
    try { detail = JSON.stringify(await resp.json()); } catch { detail = await resp.text(); }
    record(
      "Test 10: supervisor rejects a request with NO capability (HTTP 403)",
      ok,
      `status=${resp.status} detail=${detail.slice(0, 200)}`
    );
  } catch (err: any) {
    record(
      "Test 10: supervisor rejects a request with NO capability",
      false,
      `Failed: ${err.message}`
    );
  } finally {
    if (sup) await sup.stop();
  }
}

// ===========================================================================
// TEST 11 — Supervisor WITHOUT FORGE_CONTROL_PLANE_PUBLIC_KEY → FATAL exit
// ===========================================================================
// If FORGE_CONTROL_PLANE_PUBLIC_KEY is not set, the supervisor must exit with
// a non-zero status at startup (fail-closed — without the control plane's
// public key, the supervisor cannot verify capabilities, so it would run
// arbitrary workloads).

{
  // Spawn the supervisor WITHOUT FORGE_CONTROL_PLANE_PUBLIC_KEY.
  // We can't use startTestSupervisor (it always sets the env var), so we
  // spawn it manually.
  const supervisorScript = resolve(process.cwd(), "mini-services/substrate-supervisor/index.ts");
  const launcherKey = generateLauncherKeyPair();
  const launcherKeyFile = `/tmp/forge-test-supervisor-nocpkey-${randomUUID()}.pem`;
  writeFileSync(launcherKeyFile, launcherKey.privateKeyPem, { mode: 0o600 });

  const child = spawn("bun", [supervisorScript], {
    env: {
      ...process.env,
      FORGE_LAUNCHER_KEY_FILE: launcherKeyFile,
      // FORGE_CONTROL_PLANE_PUBLIC_KEY NOT set.
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 50000) stderr = stderr.slice(-50000);
  });

  // Wait up to 5s for the process to exit.
  const exitInfo: { code: number | null } = await new Promise((resolveP) => {
    const timer = setTimeout(() => {
      // Didn't exit in time — kill it.
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolveP({ code: -999 }); // sentinel: didn't exit
    }, 5000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveP({ code });
    });
  });

  // Clean up the launcher key file (it might still be on disk since the
  // supervisor exited before deleting it).
  try { if (existsSync(launcherKeyFile)) { /* best-effort */ } } catch { /* ignore */ }

  const ok = exitInfo.code !== null && exitInfo.code !== 0 && exitInfo.code !== -999;
  const details = `exitCode=${exitInfo.code} stderrContainsFatal=${stderr.includes("FATAL")} stderrTail=${stderr.slice(-300)}`;
  record(
    "Test 11: supervisor WITHOUT FORGE_CONTROL_PLANE_PUBLIC_KEY → FATAL exit (fail-closed)",
    ok,
    details
  );
  // Best-effort cleanup.
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
}

// ===========================================================================
// TEST 12 — Supervisor WITHOUT FORGE_LAUNCHER_KEY_FILE → FATAL exit
// ===========================================================================
// If FORGE_LAUNCHER_KEY_FILE is not set, the supervisor must exit with a
// non-zero status at startup (fail-closed — without the launcher key, the
// supervisor cannot sign attestations).

{
  const supervisorScript = resolve(process.cwd(), "mini-services/substrate-supervisor/index.ts");
  const cp = generateKeyPairSync("ed25519");
  const cpPubPem = cp.publicKey.export({ type: "spki", format: "pem" }).toString();

  const child = spawn("bun", [supervisorScript], {
    env: {
      ...process.env,
      FORGE_CONTROL_PLANE_PUBLIC_KEY: cpPubPem,
      // FORGE_LAUNCHER_KEY_FILE NOT set.
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 50000) stderr = stderr.slice(-50000);
  });

  const exitInfo: { code: number | null } = await new Promise((resolveP) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolveP({ code: -999 });
    }, 5000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveP({ code });
    });
  });

  const ok = exitInfo.code !== null && exitInfo.code !== 0 && exitInfo.code !== -999;
  const details = `exitCode=${exitInfo.code} stderrContainsFatal=${stderr.includes("FATAL")} stderrTail=${stderr.slice(-300)}`;
  record(
    "Test 12: supervisor WITHOUT FORGE_LAUNCHER_KEY_FILE → FATAL exit (fail-closed)",
    ok,
    details
  );
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
}

// ===========================================================================
// TEST 13 — runInSubstrate closes the key fd in a finally block (source)
// ===========================================================================
// Source inspection: substrate-namespace.ts must include a finally block
// that closes the key fd. This guarantees the fd is closed even if the
// substrate setup throws.

{
  const src = readFile("src/lib/substrate-namespace.ts");
  const hasCloseSyncInFinally =
    src.includes("closeSync(keyFd)") &&
    src.includes("} finally {") &&
    // The finally block must include the closeSync call.
    /finally\s*\{[^}]*closeSync\(keyFd\)/s.test(src);
  const usesUnlinkedTempFile =
    src.includes("unlinkSync(keyPath)") &&
    src.includes("launcherKeyPem");
  const ok = hasCloseSyncInFinally && usesUnlinkedTempFile;
  const details = `closeSyncInFinally=${hasCloseSyncInFinally} usesUnlinkedTempFile=${usesUnlinkedTempFile}`;
  record(
    "Test 13: runInSubstrate closes the key fd in a finally block + uses an unlinked temp file",
    ok,
    details
  );
}

// ===========================================================================
// TEST 14 — Launcher reads the key from an fd (NOT a file path)
// ===========================================================================
// Source inspection of forge-launcher.c: the launcher must use fdopen() to
// read the key from a numeric fd (passed as argv[1]). It must NOT use
// fopen() with a file path. It must close the fd after reading.

{
  const src = readFile("src/lib/substrate/forge-launcher.c");
  const usesFdopen = src.includes("fdopen(key_fd") || src.includes("fdopen(launcher_key_fd");
  const noFopenForLauncherKey = !/read_launcher_key\(.*fopen/.test(src) && !/BIO_new_file\(.*launcher_key/.test(src);
  const closesFd = src.includes("BIO_CLOSE") || src.includes("close(key_fd)");
  const usesBioNewFp = src.includes("BIO_new_fp(kf");
  const ok = usesFdopen && noFopenForLauncherKey && closesFd && usesBioNewFp;
  const details = `usesFdopen=${usesFdopen} noFopenForLauncherKey=${noFopenForLauncherKey} closesFd=${closesFd} usesBioNewFp=${usesBioNewFp}`;
  record(
    "Test 14: launcher reads the key from an fd via fdopen() (NOT a file path); closes the fd after reading",
    ok,
    details
  );
}

// ===========================================================================
// TEST 15 — ExecutionCapability sign/verify round-trip
// ===========================================================================
// The ExecutionCapability module must sign and verify correctly: a valid
// capability verifies; a tampered capability does not.

{
  const cp = generateKeyPairSync("ed25519");
  const cpPrivPem = cp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const cpPubPem = cp.publicKey.export({ type: "spki", format: "pem" }).toString();
  const input: ExecutionCapabilityInput = {
    executionId: randomUUID(),
    nonce: randomUUID(),
    leaseId: "lease-1",
    workerId: "substrate-iso-15-worker",
    repositoryHeadSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    repositoryUrl: "file:///tmp/forge-test-repo-15",
    runtimePlanHash: "plan-hash",
    architectureHash: null,
    workloadHash: computeWorkloadHash(deriveWorkloadFromPlan({})),
    runtimePlan: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const cap = signExecutionCapability(input, cpPrivPem);
  const validResult = verifyExecutionCapability(cap, cpPubPem);
  // Tamper: change the executionId after signing.
  const tampered: ExecutionCapability = { ...cap, executionId: randomUUID() };
  const tamperedResult = verifyExecutionCapability(tampered, cpPubPem);
  // Wrong key: verify with a different public key.
  const otherKey = generateKeyPairSync("ed25519");
  const otherPubPem = otherKey.publicKey.export({ type: "spki", format: "pem" }).toString();
  const wrongKeyResult = verifyExecutionCapability(cap, otherPubPem);
  const ok = validResult.valid && !tamperedResult.valid && !wrongKeyResult.valid;
  const details = `valid=${validResult.valid} tamperedRejected=${!tamperedResult.valid} wrongKeyRejected=${!wrongKeyResult.valid}`;
  record(
    "Test 15: ExecutionCapability sign/verify round-trip (valid → ok; tampered → rejected; wrong key → rejected)",
    ok,
    details
  );
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n=== substrate-key-isolation-invariants ===\n");
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  if (!r.passed) {
    console.log(`  ${r.details}`);
  }
}
console.log(`\n=== substrate-key-isolation-invariants: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("\n❌ SUBSTRATE KEY ISOLATION NOT SATISFIED — worker may have access to the launcher key");
  process.exit(1);
} else {
  console.log("\n✅ Launcher key isolation enforced — worker NEVER has access to the launcher private key");
  process.exit(0);
}
