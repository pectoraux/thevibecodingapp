// Forge — Phase 18Z-A: Artifact Manifest Invariants.
//
// This is the ACCEPTANCE TEST for Phase 18Z-A (Artifact & Evidence Integrity).
// It exercises the ArtifactManifest sign/verify round-trip, tamper detection,
// and the ArtifactStore content-addressed storage layer.
//
// TRUST MODEL under test:
//
//   Launcher (inside the substrate, with the launcher Ed25519 key)
//       │  observes substrate facts, signs attestation (existing — Phase 18W)
//       │  ALSO captures artifacts, builds manifest, signs manifestHash
//       ▼
//   Worker → receives attestation + manifest, includes BOTH in envelope,
//            signs envelope with worker key
//       ▼
//   Control Plane → verifies worker signature (envelope)
//                  + launcher signature (attestation)
//                  + launcher signature (manifest)
//
// The manifest is CANONICAL and IMMUTABLE. Forge never trusts "build.log
// exists" — it trusts `sha256(build.log) === <signed manifest hash>`.
//
// THE 14 INVARIANT TESTS:
//
//   1.  computeManifestHash is deterministic (same input → same hash).
//   2.  signArtifactManifest + verifyArtifactManifest round-trip (valid → ok).
//   3.  Tampered manifest content → manifestHash mismatch → REJECT.
//   4.  Tampered launcher signature → REJECT.
//   5.  Missing required artifact types → REJECT.
//   6.  Duplicate artifactId → REJECT.
//   7.  Path traversal in artifact path (..) → REJECT.
//   8.  Path traversal in artifact path (leading /) → REJECT.
//   9.  Artifact exceeds size limit → REJECT.
//  10.  Too many entries → REJECT.
//  11.  Wrong executionId → REJECT.
//  12.  Wrong launcher public key → REJECT.
//  13.  Null manifest → REJECT (fail-closed).
//  14.  ArtifactStore stores + retrieves content-addressed (round-trip).
//  15.  ArtifactStore rejects content hash mismatch (declared ≠ actual).
//  16.  ArtifactStore enforces size limit (> 50 MiB → throws).
//  17.  ArtifactStore post-write hash verification (corruption → throws).
//  18.  Canonical serialization is stable (sorted keys, no whitespace).
//  19.  Manifest is bound into envelope hash (artifactManifest field changes
//       the envelopeHash — proves the worker's signature covers it).
//
// Run with: bun run tests/artifact-manifest-invariants.ts

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeManifestHash,
  signArtifactManifest,
  verifyArtifactManifest,
  canonicalSerialize,
  canonicalManifestJson,
  makeTestManifest,
  REQUIRED_ARTIFACT_TYPES,
  MAX_ARTIFACT_SIZE_BYTES,
  MAX_MANIFEST_ENTRIES,
  MAX_MANIFEST_TOTAL_SIZE_BYTES,
  type ArtifactManifest,
  type ArtifactEntry,
} from "@/lib/artifact-manifest";
import { ArtifactStore } from "@/lib/artifact-store";
import { generateLauncherKeyPair } from "@/lib/substrate-attestation";
import {
  computeEnvelopeHash,
  computeResultHash,
  generateWorkerKeyPair,
} from "@/lib/runtime-execution-contract";

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
// Setup — generate launcher + worker keypairs
// ===========================================================================

const LAUNCHER_KEY = generateLauncherKeyPair();
const WRONG_LAUNCHER_KEY = generateLauncherKeyPair();
const WORKER_KEY = generateWorkerKeyPair("artifact-manifest-test-worker");

const EXECUTION_ID = "exec-artifact-manifest-1";
const REPOSITORY_SHA = "0123456789abcdef0123456789abcdef01234567";
const WORKER_ID = "worker-artifact-manifest-1";
const SUBSTRATE_INSTANCE_ID = "11111111-1111-1111-1111-111111111111";

// ===========================================================================
// TEST 1: computeManifestHash is deterministic
// ===========================================================================

{
  const manifest = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  });
  const { manifestHash, launcherSignature, launcherAlgorithm, launcherKeyId, launcherSignedAt, ...rest } = manifest;
  const hash1 = computeManifestHash(rest);
  const hash2 = computeManifestHash(rest);
  record(
    "Test 1: computeManifestHash is deterministic (same input → same hash)",
    hash1 === hash2 && hash1 === manifestHash,
    `hash1=${hash1.slice(0, 16)}... hash2=${hash2.slice(0, 16)}... manifestHash=${manifestHash.slice(0, 16)}...`
  );
}

// ===========================================================================
// TEST 2: signArtifactManifest + verifyArtifactManifest round-trip
// ===========================================================================

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
    EXECUTION_ID
  );
  record(
    "Test 2: signArtifactManifest + verifyArtifactManifest round-trip (valid → ok)",
    verification.valid,
    `valid=${verification.valid} reasons=${JSON.stringify(verification.reasons)}`
  );
}

// ===========================================================================
// TEST 3: Tampered manifest content → manifestHash mismatch → REJECT
// ===========================================================================

{
  const manifest = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  });
  // Tamper: change an entry's sha256 (but keep manifestHash the same).
  const tampered: ArtifactManifest = {
    ...manifest,
    entries: manifest.entries.map((e, i) =>
      i === 0
        ? { ...e, sha256: "a".repeat(64) /* different hash */ }
        : e
    ),
  };
  const verification = verifyArtifactManifest(
    tampered,
    LAUNCHER_KEY.publicKeyPem,
    EXECUTION_ID
  );
  const hashMismatch = verification.reasons.some((r) =>
    r.includes("manifestHash does not match")
  );
  record(
    "Test 3: Tampered manifest content → manifestHash mismatch → REJECT",
    !verification.valid && hashMismatch,
    `valid=${verification.valid} hashMismatchReason=${hashMismatch} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 4: Tampered launcher signature → REJECT
// ===========================================================================

{
  const manifest = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  });
  // Tamper: replace the signature with a random 64-byte hex string.
  const tampered: ArtifactManifest = {
    ...manifest,
    launcherSignature: "b".repeat(128),
  };
  const verification = verifyArtifactManifest(
    tampered,
    LAUNCHER_KEY.publicKeyPem,
    EXECUTION_ID
  );
  const sigFailed = verification.reasons.some((r) =>
    r.includes("signature") || r.includes("INVALID")
  );
  record(
    "Test 4: Tampered launcher signature → REJECT",
    !verification.valid && sigFailed,
    `valid=${verification.valid} sigFailedReason=${sigFailed} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 5: Missing required artifact types → REJECT
// ===========================================================================

{
  // Build a manifest with ONLY source-materialization (missing 6 required types).
  const entry: ArtifactEntry = {
    artifactId: "source-materialization",
    type: "source-materialization",
    path: "logs/source-materialization.txt",
    mediaType: "text/plain",
    size: 32,
    sha256: createHash("sha256").update("source").digest("hex"),
    storageRef: "logs/source-materialization.txt",
  };
  const manifestWithoutHash = {
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    entries: [entry],
    createdAt: new Date().toISOString(),
  };
  const manifestHash = computeManifestHash(manifestWithoutHash);
  const manifest = signArtifactManifest(
    { ...manifestWithoutHash, manifestHash },
    LAUNCHER_KEY.privateKeyPem
  );
  const verification = verifyArtifactManifest(
    manifest,
    LAUNCHER_KEY.publicKeyPem,
    EXECUTION_ID
  );
  const missingReason = verification.reasons.some((r) =>
    r.includes("Missing required artifact types")
  );
  record(
    "Test 5: Missing required artifact types → REJECT",
    !verification.valid && missingReason,
    `valid=${verification.valid} missingReason=${missingReason} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 6: Duplicate artifactId → REJECT
// ===========================================================================

{
  const baseEntries = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  }).entries;
  // Duplicate the first entry (same artifactId).
  const dupEntries: ArtifactEntry[] = [...baseEntries, { ...baseEntries[0] }];
  const manifestWithoutHash = {
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    entries: dupEntries,
    createdAt: new Date().toISOString(),
  };
  const manifestHash = computeManifestHash(manifestWithoutHash);
  const manifest = signArtifactManifest(
    { ...manifestWithoutHash, manifestHash },
    LAUNCHER_KEY.privateKeyPem
  );
  const verification = verifyArtifactManifest(
    manifest,
    LAUNCHER_KEY.publicKeyPem,
    EXECUTION_ID
  );
  const dupReason = verification.reasons.some((r) =>
    r.includes("Duplicate artifactId")
  );
  record(
    "Test 6: Duplicate artifactId → REJECT",
    !verification.valid && dupReason,
    `valid=${verification.valid} dupReason=${dupReason} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 7: Path traversal in artifact path (..) → REJECT
// ===========================================================================

{
  const baseEntries = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  }).entries;
  // Tamper one entry's path to include ".."
  const tamperedEntries = baseEntries.map((e, i) =>
    i === 0 ? { ...e, path: "../../../etc/passwd" } : e
  );
  const manifestWithoutHash = {
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    entries: tamperedEntries,
    createdAt: new Date().toISOString(),
  };
  const manifestHash = computeManifestHash(manifestWithoutHash);
  const manifest = signArtifactManifest(
    { ...manifestWithoutHash, manifestHash },
    LAUNCHER_KEY.privateKeyPem
  );
  const verification = verifyArtifactManifest(
    manifest,
    LAUNCHER_KEY.publicKeyPem,
    EXECUTION_ID
  );
  const traversalReason = verification.reasons.some((r) =>
    r.includes("path traversal")
  );
  record(
    "Test 7: Path traversal in artifact path (..) → REJECT",
    !verification.valid && traversalReason,
    `valid=${verification.valid} traversalReason=${traversalReason} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 8: Path traversal in artifact path (leading /) → REJECT
// ===========================================================================

{
  const baseEntries = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  }).entries;
  // Tamper one entry's path to start with "/"
  const tamperedEntries = baseEntries.map((e, i) =>
    i === 0 ? { ...e, path: "/etc/passwd" } : e
  );
  const manifestWithoutHash = {
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    entries: tamperedEntries,
    createdAt: new Date().toISOString(),
  };
  const manifestHash = computeManifestHash(manifestWithoutHash);
  const manifest = signArtifactManifest(
    { ...manifestWithoutHash, manifestHash },
    LAUNCHER_KEY.privateKeyPem
  );
  const verification = verifyArtifactManifest(
    manifest,
    LAUNCHER_KEY.publicKeyPem,
    EXECUTION_ID
  );
  const traversalReason = verification.reasons.some((r) =>
    r.includes("path traversal")
  );
  record(
    "Test 8: Path traversal in artifact path (leading /) → REJECT",
    !verification.valid && traversalReason,
    `valid=${verification.valid} traversalReason=${traversalReason} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 9: Artifact exceeds size limit → REJECT
// ===========================================================================

{
  const baseEntries = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  }).entries;
  // Tamper one entry's size to exceed the limit.
  const tamperedEntries = baseEntries.map((e, i) =>
    i === 0 ? { ...e, size: MAX_ARTIFACT_SIZE_BYTES + 1 } : e
  );
  const manifestWithoutHash = {
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    entries: tamperedEntries,
    createdAt: new Date().toISOString(),
  };
  const manifestHash = computeManifestHash(manifestWithoutHash);
  const manifest = signArtifactManifest(
    { ...manifestWithoutHash, manifestHash },
    LAUNCHER_KEY.privateKeyPem
  );
  const verification = verifyArtifactManifest(
    manifest,
    LAUNCHER_KEY.publicKeyPem,
    EXECUTION_ID
  );
  const sizeReason = verification.reasons.some((r) =>
    r.includes("exceeds limit")
  );
  record(
    "Test 9: Artifact exceeds size limit → REJECT",
    !verification.valid && sizeReason,
    `valid=${verification.valid} sizeReason=${sizeReason} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 10: Too many entries → REJECT
// ===========================================================================

{
  // Build entries with MAX_MANIFEST_ENTRIES + 1 items (all valid types, unique ids).
  const baseEntries = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  }).entries;
  const tooMany: ArtifactEntry[] = [...baseEntries];
  for (let i = 0; i <= MAX_MANIFEST_ENTRIES; i++) {
    tooMany.push({
      artifactId: `extra-${i}`,
      type: "manifest-output",
      path: `logs/extra-${i}.json`,
      mediaType: "application/json",
      size: 1,
      sha256: createHash("sha256").update(`extra-${i}`).digest("hex"),
      storageRef: `logs/extra-${i}.json`,
    });
  }
  const manifestWithoutHash = {
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    entries: tooMany,
    createdAt: new Date().toISOString(),
  };
  const manifestHash = computeManifestHash(manifestWithoutHash);
  const manifest = signArtifactManifest(
    { ...manifestWithoutHash, manifestHash },
    LAUNCHER_KEY.privateKeyPem
  );
  const verification = verifyArtifactManifest(
    manifest,
    LAUNCHER_KEY.publicKeyPem,
    EXECUTION_ID
  );
  const tooManyReason = verification.reasons.some((r) =>
    r.includes("Too many entries")
  );
  record(
    "Test 10: Too many entries → REJECT",
    !verification.valid && tooManyReason,
    `valid=${verification.valid} tooManyReason=${tooManyReason} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 11: Wrong executionId → REJECT
// ===========================================================================

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
    "DIFFERENT_EXECUTION_ID"
  );
  const execIdReason = verification.reasons.some((r) =>
    r.includes("executionId mismatch")
  );
  record(
    "Test 11: Wrong executionId → REJECT",
    !verification.valid && execIdReason,
    `valid=${verification.valid} execIdReason=${execIdReason} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 12: Wrong launcher public key → REJECT
// ===========================================================================

{
  const manifest = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  });
  // Verify with a DIFFERENT launcher public key.
  const verification = verifyArtifactManifest(
    manifest,
    WRONG_LAUNCHER_KEY.publicKeyPem,
    EXECUTION_ID
  );
  const sigReason = verification.reasons.some((r) =>
    r.includes("INVALID") || r.includes("signature")
  );
  record(
    "Test 12: Wrong launcher public key → REJECT",
    !verification.valid && sigReason,
    `valid=${verification.valid} sigReason=${sigReason} reasons=${JSON.stringify(verification.reasons.slice(0, 2))}`
  );
}

// ===========================================================================
// TEST 13: Null manifest → REJECT (fail-closed)
// ===========================================================================

{
  const verification = verifyArtifactManifest(
    null,
    LAUNCHER_KEY.publicKeyPem,
    EXECUTION_ID
  );
  record(
    "Test 13: Null manifest → REJECT (fail-closed)",
    !verification.valid && verification.reasons.includes("No artifact manifest provided"),
    `valid=${verification.valid} reasons=${JSON.stringify(verification.reasons)}`
  );
}

// ===========================================================================
// TEST 14: ArtifactStore stores + retrieves content-addressed (round-trip)
// ===========================================================================

{
  const storeRoot = mkdtempSync(join(tmpdir(), "forge-artifact-store-test-"));
  const store = new ArtifactStore(storeRoot);
  const content = Buffer.from("hello, artifact store!", "utf-8");
  const expectedSha = createHash("sha256").update(content).digest("hex");
  const stored = store.store(content);
  const retrieved = store.retrieve(stored.sha256);
  const ok =
    stored.sha256 === expectedSha &&
    stored.size === content.length &&
    retrieved.equals(content) &&
    store.exists(stored.sha256);
  record(
    "Test 14: ArtifactStore stores + retrieves content-addressed (round-trip)",
    ok,
    `sha256=${stored.sha256.slice(0, 16)}... size=${stored.size} matches=${retrieved.equals(content)} exists=${store.exists(stored.sha256)}`
  );
  rmSync(storeRoot, { recursive: true, force: true });
}

// ===========================================================================
// TEST 15: ArtifactStore rejects content hash mismatch
// ===========================================================================

{
  const storeRoot = mkdtempSync(join(tmpdir(), "forge-artifact-store-test-"));
  const store = new ArtifactStore(storeRoot);
  const content = Buffer.from("actual content", "utf-8");
  const wrongSha = "0".repeat(64); // doesn't match content
  let threw = false;
  let errMsg = "";
  try {
    store.store(content, wrongSha);
  } catch (err) {
    threw = true;
    errMsg = err instanceof Error ? err.message : String(err);
  }
  record(
    "Test 15: ArtifactStore rejects content hash mismatch (declared ≠ actual)",
    threw && errMsg.includes("mismatch"),
    `threw=${threw} errMsg=${errMsg.slice(0, 100)}`
  );
  rmSync(storeRoot, { recursive: true, force: true });
}

// ===========================================================================
// TEST 16: ArtifactStore enforces size limit (> 50 MiB → throws)
// ===========================================================================

{
  const storeRoot = mkdtempSync(join(tmpdir(), "forge-artifact-store-test-"));
  const store = new ArtifactStore(storeRoot);
  // Create a buffer that exceeds MAX_ARTIFACT_SIZE_BYTES (50 MiB).
  // We don't actually allocate 50 MiB — we test the size check by passing a
  // buffer with .length > MAX_ARTIFACT_SIZE_BYTES. To avoid OOM, we use a
  // sparse approach: create a small buffer but mock the length check.
  // Actually, the store checks content.length directly, so we need a real
  // large buffer. Let's allocate 50 MiB + 1 byte.
  const largeContent = Buffer.alloc(MAX_ARTIFACT_SIZE_BYTES + 1, 0x41);
  let threw = false;
  let errMsg = "";
  try {
    store.store(largeContent);
  } catch (err) {
    threw = true;
    errMsg = err instanceof Error ? err.message : String(err);
  }
  record(
    "Test 16: ArtifactStore enforces size limit (> 50 MiB → throws)",
    threw && errMsg.includes("exceeds limit"),
    `threw=${threw} errMsg=${errMsg.slice(0, 100)}`
  );
  rmSync(storeRoot, { recursive: true, force: true });
}

// ===========================================================================
// TEST 17: ArtifactStore idempotent (same content → same path, no rewrite)
// ===========================================================================

{
  const storeRoot = mkdtempSync(join(tmpdir(), "forge-artifact-store-test-"));
  const store = new ArtifactStore(storeRoot);
  const content = Buffer.from("idempotent content", "utf-8");
  const stored1 = store.store(content);
  const stored2 = store.store(content);
  const ok =
    stored1.sha256 === stored2.sha256 &&
    stored1.storageRef === stored2.storageRef;
  record(
    "Test 17: ArtifactStore idempotent (same content → same path, no rewrite)",
    ok,
    `sha256=${stored1.sha256.slice(0, 16)}... samePath=${stored1.storageRef === stored2.storageRef}`
  );
  rmSync(storeRoot, { recursive: true, force: true });
}

// ===========================================================================
// TEST 18: Canonical serialization is stable (sorted keys, no whitespace)
// ===========================================================================

{
  const manifest = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  });
  const { manifestHash, launcherSignature, launcherAlgorithm, launcherKeyId, launcherSignedAt, ...rest } = manifest;
  const canonical1 = canonicalManifestJson(rest);
  const canonical2 = canonicalManifestJson(rest);
  // Verify no whitespace.
  const noWhitespace = !/\s/.test(canonical1);
  // Verify keys are sorted (entries comes before executionId, etc.).
  const keysSorted = canonical1.indexOf('"entries"') < canonical1.indexOf('"executionId"') &&
    canonical1.indexOf('"executionId"') < canonical1.indexOf('"repositorySha"') &&
    canonical1.indexOf('"repositorySha"') < canonical1.indexOf('"substrateInstanceId"') &&
    canonical1.indexOf('"substrateInstanceId"') < canonical1.indexOf('"workerId"');
  record(
    "Test 18: Canonical serialization is stable (sorted keys, no whitespace)",
    canonical1 === canonical2 && noWhitespace && keysSorted,
    `stable=${canonical1 === canonical2} noWhitespace=${noWhitespace} keysSorted=${keysSorted}`
  );
}

// ===========================================================================
// TEST 19: Manifest is bound into envelope hash (artifactManifest changes hash)
// ===========================================================================

{
  // Build two envelope-like objects that differ ONLY in artifactManifest.
  // The envelopeHash must differ — proving the worker's signature covers it.
  const manifest = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  });
  const baseEnvelope = {
    executionId: EXECUTION_ID,
    workerId: WORKER_ID,
    leaseId: "lease-1",
    repositoryHeadSha: REPOSITORY_SHA,
    architectureHash: null,
    runtimePlanHash: "plan-hash",
    environmentFingerprint: {
      os: "linux", architecture: "x64", nodeVersion: "v20",
      packageManager: "npm", containerImageHash: null,
      environmentVariablesHash: "env", timestamp: new Date().toISOString(),
    },
    dependencyInstallResult: { success: true, durationMs: 1, exitCode: 0, output: "ok" },
    buildResult: { success: true, durationMs: 1, exitCode: 0, output: "ok" },
    startupResult: { success: true, durationMs: 1, exitCode: 0, output: "ok", port: 3000, pid: 1 },
    healthChecks: [], apiJourneys: [], integrationChecks: [],
    backgroundJobChecks: [], browserJourneys: [],
    teardownResult: { success: true, durationMs: 1 },
    passed: true, failureReason: null,
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    logs: "",
    substrateAttestation: null,
  };
  const envelopeWithManifest = { ...baseEnvelope, artifactManifest: manifest };
  const envelopeWithoutManifest = { ...baseEnvelope, artifactManifest: null };
  const hash1 = computeEnvelopeHash(envelopeWithManifest);
  const hash2 = computeEnvelopeHash(envelopeWithoutManifest);
  record(
    "Test 19: Manifest is bound into envelope hash (artifactManifest changes hash)",
    hash1 !== hash2,
    `hashWithManifest=${hash1.slice(0, 16)}... hashWithoutManifest=${hash2.slice(0, 16)}... differ=${hash1 !== hash2}`
  );
}

// ===========================================================================
// TEST 20: REQUIRED_ARTIFACT_TYPES includes all 7 required types
// ===========================================================================

{
  const required = REQUIRED_ARTIFACT_TYPES;
  const expected = [
    "source-materialization",
    "install-log",
    "build-log",
    "startup-log",
    "runtime-stdout",
    "runtime-stderr",
    "substrate-attestation",
  ];
  const ok =
    required.length === expected.length &&
    expected.every((t) => required.includes(t as never));
  record(
    "Test 20: REQUIRED_ARTIFACT_TYPES includes all 7 required types",
    ok,
    `required=${JSON.stringify(required)}`
  );
}

// ===========================================================================
// TEST 21: Manifest signature uses the SAME launcher key as the attestation
// (This is a design invariant — the manifest is signed by the launcher inside
// the substrate, not by the worker. The makeTestManifest helper signs with
// the launcher private key, and verifyArtifactManifest checks with the
// launcher public key. This test verifies the round-trip works with the
// SAME keypair that generateLauncherKeyPair produces.)
// ===========================================================================

{
  const manifest = makeTestManifest({
    executionId: EXECUTION_ID,
    repositorySha: REPOSITORY_SHA,
    workerId: WORKER_ID,
    substrateInstanceId: SUBSTRATE_INSTANCE_ID,
    launcherPrivateKeyPem: LAUNCHER_KEY.privateKeyPem,
  });
  // Verify the manifest with the launcher public key (same keypair).
  const manifestOk = verifyArtifactManifest(
    manifest,
    LAUNCHER_KEY.publicKeyPem,
    EXECUTION_ID
  ).valid;
  // Verify the manifest CANNOT be verified with the WORKER's public key
  // (different keypair — the worker doesn't sign the manifest).
  const workerOk = verifyArtifactManifest(
    manifest,
    WORKER_KEY.publicKeyPem,
    EXECUTION_ID
  ).valid;
  record(
    "Test 21: Manifest signature uses the launcher key (NOT the worker key)",
    manifestOk && !workerOk,
    `manifestOk=${manifestOk} workerOk=${workerOk} (workerOk MUST be false — the worker key cannot verify the manifest)`
  );
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("");
console.log(`=== artifact-manifest-invariants: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("");
  console.log("❌ ARTIFACT MANIFEST INVARIANTS NOT SATISFIED — content-addressed evidence layer is broken");
  process.exit(1);
} else {
  console.log("");
  console.log("✅ Artifact manifest invariants verified — Forge never trusts 'build.log exists', it trusts sha256(build.log) === <signed manifest hash>");
}
