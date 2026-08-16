// Forge — Phase 18Z-A: Artifact & Evidence Integrity.
//
// The execution authority chain (18Y + 18Z-PRE) signs the workload + repo +
// substrate facts. But the EVIDENCE model still lacked a durable,
// content-addressed artifact layer. The envelope carried truncated logs
// (`logs: string`) but no cryptographic binding to build logs, test results,
// crash output, etc.
//
// Phase 18Z-A closes this gap. The ArtifactManifest is a canonical, immutable,
// launcher-signed manifest that binds EVERY execution artifact (install.log,
// build.log, runtime-stdout, runtime-stderr, health-traces, the substrate
// attestation itself, ...) via SHA-256 content hashes.
//
// TRUST MODEL:
//   Control Plane capability → exact workload + repo (signed)
//       ↓
//   Supervisor → clones, derives workload, runs substrate
//       ↓
//   Launcher → observes substrate facts, signs attestation (existing)
//             → ALSO captures artifacts, builds manifest, signs manifestHash
//       ↓
//   Worker → receives attestation + manifest, includes BOTH in envelope,
//            signs envelope
//       ↓
//   Control Plane → verifies worker signature (envelope)
//                  + launcher signature (attestation)
//                  + launcher signature (manifest)
//
// The manifest is CANONICAL and IMMUTABLE. Downstream verification never
// reconstructs artifact identity from ad-hoc DB fields — it reads the signed
// manifest. Forge never trusts "build.log exists" — it trusts
// `sha256(build.log) === <signed manifest hash>`.
//
// The manifest hash covers: executionId, repositorySha, workerId,
// substrateInstanceId, and the full entries array (each entry's artifactId,
// type, path, mediaType, size, sha256, storageRef). It EXCLUDES the manifest
// hash itself + the launcher signature fields (those are derived FROM the
// hash, so including them would be circular).

import { createHash } from "node:crypto";
import { sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The required artifact classes. A manifest is INCOMPLETE (and verification
 * fails) without at least these types present:
 *   - source-materialization: proves the repo was actually cloned (git ls-tree)
 *   - install-log: dependency install output
 *   - build-log: build output
 *   - startup-log: app startup output
 *   - runtime-stdout: the app's full stdout (captured by orchestrator)
 *   - runtime-stderr: the app's full stderr
 *   - substrate-attestation: the signed SandboxAttestation itself (as JSON)
 */
export type ArtifactType =
  | "source-materialization"
  | "dependency-lockfile"
  | "install-log"
  | "build-log"
  | "startup-log"
  | "health-trace"
  | "api-journey-trace"
  | "runtime-stdout"
  | "runtime-stderr"
  | "crash-output"
  | "substrate-attestation"
  | "test-results"
  | "manifest-output";

export interface ArtifactEntry {
  /** Unique within the manifest. e.g. "install-log", "build-log", "health-trace-0". */
  artifactId: string;
  /** The artifact class — drives downstream verification requirements. */
  type: ArtifactType;
  /**
   * LOGICAL path within the workspace (e.g. "logs/install.log",
   * "attestation.json"). NEVER a host path. NEVER starts with "/".
   * NEVER contains ".." (path traversal is rejected by verifyArtifactManifest).
   */
  path: string;
  /** "text/plain", "application/json", "application/octet-stream". */
  mediaType: string;
  /** Size in bytes. */
  size: number;
  /** 64 hex chars — the content-addressed key. */
  sha256: string;
  /**
   * Opaque reference to where the artifact is persisted. The launcher sets
   * this to the logical path; the supervisor may persist the artifact to a
   * content-addressed store (keyed by sha256) but the manifest's storageRef
   * stays as the launcher signed it (mutating it would break the signature).
   * Consumers retrieve artifacts by sha256, NOT by storageRef.
   */
  storageRef: string;
}

/**
 * The manifest is a CANONICAL, IMMUTABLE, LAUNCHER-SIGNED record of every
 * artifact produced by an execution. The manifestHash covers all entries +
 * metadata; the launcherSignature is Ed25519 over manifestHash.
 */
export interface ArtifactManifest {
  executionId: string;
  repositorySha: string;
  workerId: string;
  substrateInstanceId: string;
  entries: ArtifactEntry[];
  /** SHA-256 of the canonical manifest (excludes this hash + signature fields). */
  manifestHash: string;
  /** ISO timestamp the manifest was built. */
  createdAt: string;
  /** Ed25519 signature over manifestHash UTF-8 bytes (hex). */
  launcherSignature: string;
  /** Always "ed25519". */
  launcherAlgorithm: "ed25519";
  /** Always "forge-launcher-v2" (identifies the launcher signing key). */
  launcherKeyId: string;
  /** ISO-UTC timestamp the launcher signed the manifest. */
  launcherSignedAt: string;
}

// ---------------------------------------------------------------------------
// Required artifact types + size limits
// ---------------------------------------------------------------------------

export const REQUIRED_ARTIFACT_TYPES: ArtifactType[] = [
  "source-materialization",
  "install-log",
  "build-log",
  "startup-log",
  "runtime-stdout",
  "runtime-stderr",
  "substrate-attestation",
];

/** Max size of a single artifact (50 MiB). */
export const MAX_ARTIFACT_SIZE_BYTES = 50 * 1024 * 1024;
/** Max number of entries in a manifest. */
export const MAX_MANIFEST_ENTRIES = 200;
/** Max total size of all artifacts (500 MiB). */
export const MAX_MANIFEST_TOTAL_SIZE_BYTES = 500 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Canonical serialization (recursive sorted keys — same pattern as
// execution-capability.ts / substrate-attestation.ts)
// ---------------------------------------------------------------------------

/**
 * Recursive canonical serialization for stable hashing/signing.
 * Object keys sorted recursively; arrays preserve order. No whitespace.
 *
 * This MUST match the C launcher's canonical JSON builder EXACTLY — the
 * manifest hash is computed on both sides and must agree.
 */
export function canonicalSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value.toString();
  if (typeof value === "number") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalSerialize).join(",") + "]";
  }
  if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalSerialize(v[k])).join(",") + "}";
  }
  return "null";
}

/**
 * Build the canonical JSON for the manifest (for hashing/signing).
 *
 * The canonical form covers: entries (array of entry objects), executionId,
 * repositorySha, substrateInstanceId, workerId. Keys sorted at every level.
 * EXCLUDES manifestHash + signature fields (those are derived FROM the hash).
 *
 * The entries array preserves order (the launcher writes entries in a stable
 * order: sorted by artifactId). Each entry is serialized with all its fields
 * (artifactId, mediaType, path, sha256, size, storageRef, type) in sorted
 * key order.
 */
export function canonicalManifestJson(
  manifest: Omit<ArtifactManifest, "manifestHash" | "launcherSignature" | "launcherAlgorithm" | "launcherKeyId" | "launcherSignedAt">
): string {
  return canonicalSerialize({
    entries: manifest.entries,
    executionId: manifest.executionId,
    repositorySha: manifest.repositorySha,
    substrateInstanceId: manifest.substrateInstanceId,
    workerId: manifest.workerId,
  });
}

// ---------------------------------------------------------------------------
// Manifest hash + signing
// ---------------------------------------------------------------------------

/**
 * Compute the manifest hash — SHA-256 of the canonical manifest JSON.
 *
 * The hash covers: entries (each entry's full canonical form), executionId,
 * repositorySha, substrateInstanceId, workerId. It EXCLUDES the manifest hash
 * itself + the launcher signature fields (those are derived FROM the hash, so
 * including them would be circular).
 */
export function computeManifestHash(
  manifest: Omit<ArtifactManifest, "manifestHash" | "launcherSignature" | "launcherAlgorithm" | "launcherKeyId" | "launcherSignedAt">
): string {
  const canonical = canonicalManifestJson(manifest);
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/**
 * Sign the manifest with the launcher's Ed25519 private key.
 *
 * The signature is over manifestHash UTF-8 bytes (the same scheme used by the
 * attestation signature). The launcherKeyId is "forge-launcher-v2" (matches
 * the attestation).
 *
 * The manifest must already have manifestHash computed (callers should call
 * computeManifestHash first, then this).
 */
export function signArtifactManifest(
  manifest: Omit<ArtifactManifest, "launcherSignature" | "launcherAlgorithm" | "launcherKeyId" | "launcherSignedAt"> & { manifestHash: string },
  launcherPrivateKeyPem: string,
  launcherKeyId: string = "forge-launcher-v2"
): ArtifactManifest {
  if (!manifest.manifestHash) {
    throw new Error("signArtifactManifest: manifest.manifestHash is empty — call computeManifestHash first");
  }
  const signature = cryptoSign(null, Buffer.from(manifest.manifestHash, "utf-8"), launcherPrivateKeyPem).toString("hex");
  return {
    ...manifest,
    launcherSignature: signature,
    launcherAlgorithm: "ed25519",
    launcherKeyId,
    launcherSignedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Manifest verification
// ---------------------------------------------------------------------------

export interface ManifestVerificationResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Verify the artifact manifest.
 *
 * Checks (ALL must pass for `valid: true`):
 *   1. manifestHash matches the canonical manifest content (tamper detection).
 *   2. launcherSignature is a valid Ed25519 signature over manifestHash
 *      using the pinned launcher public key (proves the launcher produced it).
 *   3. executionId matches the expected executionId (binding).
 *   4. All REQUIRED_ARTIFACT_TYPES are present in the entries.
 *   5. No duplicate artifactId.
 *   6. Each entry's sha256 is a valid 64-hex string.
 *   7. Each entry's size <= MAX_ARTIFACT_SIZE_BYTES.
 *   8. Each entry's path has no traversal (".." or leading "/").
 *   9. Total entries <= MAX_MANIFEST_ENTRIES.
 *  10. Total size <= MAX_MANIFEST_TOTAL_SIZE_BYTES.
 *
 * Fail-closed: null/undefined manifest → valid: false.
 */
export function verifyArtifactManifest(
  manifest: ArtifactManifest | null | undefined,
  launcherPublicKeyPem: string,
  expectedExecutionId: string
): ManifestVerificationResult {
  const reasons: string[] = [];
  if (!manifest) {
    return { valid: false, reasons: ["No artifact manifest provided"] };
  }

  // 1. Verify manifestHash matches the content.
  const {
    manifestHash: _manifestHash,
    launcherSignature: _launcherSignature,
    launcherAlgorithm: _launcherAlgorithm,
    launcherKeyId: _launcherKeyId,
    launcherSignedAt: _launcherSignedAt,
    ...rest
  } = manifest;
  const computedHash = computeManifestHash(rest);
  if (computedHash !== manifest.manifestHash) {
    reasons.push("manifestHash does not match manifest content — manifest tampered");
  }

  // 2. Verify launcher signature.
  if (manifest.launcherAlgorithm !== "ed25519") {
    reasons.push(`Wrong launcher algorithm: ${manifest.launcherAlgorithm} (expected ed25519)`);
  }
  if (!manifest.launcherSignature) {
    reasons.push("No launcher signature on manifest");
  }
  if (!manifest.manifestHash) {
    reasons.push("manifestHash is empty");
  } else {
    try {
      const sigBuf = Buffer.from(manifest.launcherSignature, "hex");
      if (sigBuf.length !== 64) {
        reasons.push(`Invalid signature length: ${sigBuf.length} bytes (expected 64 for Ed25519)`);
      } else {
        let sigValid = false;
        try {
          sigValid = cryptoVerify(
            null,
            Buffer.from(manifest.manifestHash, "utf-8"),
            launcherPublicKeyPem,
            sigBuf
          );
        } catch (err) {
          reasons.push(
            `Manifest signature verification threw: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        if (!sigValid) {
          reasons.push(
            "Launcher manifest signature is INVALID for the pinned public key (manifest may be fabricated)"
          );
        }
      }
    } catch (err) {
      reasons.push(
        `Signature verification error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 3. Verify executionId binding.
  if (manifest.executionId !== expectedExecutionId) {
    reasons.push(
      `executionId mismatch: manifest=${manifest.executionId} expected=${expectedExecutionId}`
    );
  }

  // 4. Verify required artifact types present.
  const presentTypes = new Set(manifest.entries.map((e) => e.type));
  const missing = REQUIRED_ARTIFACT_TYPES.filter((t) => !presentTypes.has(t));
  if (missing.length > 0) {
    reasons.push(`Missing required artifact types: ${missing.join(", ")}`);
  }

  // 5 + 6 + 7 + 8. Entry integrity.
  const seenIds = new Set<string>();
  for (const entry of manifest.entries) {
    if (seenIds.has(entry.artifactId)) {
      reasons.push(`Duplicate artifactId: ${entry.artifactId}`);
    }
    seenIds.add(entry.artifactId);

    if (!entry.artifactId) {
      reasons.push("Entry with empty artifactId");
    }
    if (!entry.type) {
      reasons.push(`Entry ${entry.artifactId}: missing type`);
    }
    if (!entry.path) {
      reasons.push(`Entry ${entry.artifactId}: missing path`);
    }
    if (entry.sha256.length !== 64 || !/^[0-9a-f]+$/.test(entry.sha256)) {
      reasons.push(`Entry ${entry.artifactId}: invalid sha256 (expected 64 hex chars)`);
    }
    if (!Number.isFinite(entry.size) || entry.size < 0) {
      reasons.push(`Entry ${entry.artifactId}: invalid size ${entry.size}`);
    }
    if (entry.size > MAX_ARTIFACT_SIZE_BYTES) {
      reasons.push(
        `Entry ${entry.artifactId}: size ${entry.size} exceeds limit ${MAX_ARTIFACT_SIZE_BYTES}`
      );
    }
    // Path traversal rejection — the path is a LOGICAL path within the
    // workspace. It must not start with "/" (absolute) or contain ".."
    // (traversal). Backslash is also rejected (defense-in-depth on Windows-
    // style paths).
    if (entry.path.startsWith("/") || entry.path.includes("..") || entry.path.includes("\\")) {
      reasons.push(`Entry ${entry.artifactId}: path traversal rejected: ${entry.path}`);
    }
  }

  // 9. Total entry count.
  if (manifest.entries.length > MAX_MANIFEST_ENTRIES) {
    reasons.push(
      `Too many entries: ${manifest.entries.length} > ${MAX_MANIFEST_ENTRIES}`
    );
  }

  // 10. Total size.
  const totalSize = manifest.entries.reduce((s, e) => s + e.size, 0);
  if (totalSize > MAX_MANIFEST_TOTAL_SIZE_BYTES) {
    reasons.push(
      `Total size ${totalSize} exceeds limit ${MAX_MANIFEST_TOTAL_SIZE_BYTES}`
    );
  }

  return { valid: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a valid signed manifest for tests. The entries cover all required
 * types. The manifest is signed with the provided launcher private key.
 */
export function makeTestManifest(opts: {
  executionId?: string;
  repositorySha?: string;
  workerId?: string;
  substrateInstanceId?: string;
  launcherPrivateKeyPem: string;
  entries?: ArtifactEntry[];
}): ArtifactManifest {
  const executionId = opts.executionId ?? "test-exec-1";
  const repositorySha = opts.repositorySha ?? "0123456789abcdef0123456789abcdef01234567";
  const workerId = opts.workerId ?? "test-worker-1";
  const substrateInstanceId = opts.substrateInstanceId ?? "00000000-0000-0000-0000-000000000001";

  const defaultEntries: ArtifactEntry[] = opts.entries ?? [
    {
      artifactId: "source-materialization",
      type: "source-materialization",
      path: "logs/source-materialization.txt",
      mediaType: "text/plain",
      size: 64,
      sha256: createHash("sha256").update("source-materialization-content").digest("hex"),
      storageRef: "logs/source-materialization.txt",
    },
    {
      artifactId: "install-log",
      type: "install-log",
      path: "logs/install.log",
      mediaType: "text/plain",
      size: 32,
      sha256: createHash("sha256").update("install-log-content").digest("hex"),
      storageRef: "logs/install.log",
    },
    {
      artifactId: "build-log",
      type: "build-log",
      path: "logs/build.log",
      mediaType: "text/plain",
      size: 32,
      sha256: createHash("sha256").update("build-log-content").digest("hex"),
      storageRef: "logs/build.log",
    },
    {
      artifactId: "startup-log",
      type: "startup-log",
      path: "logs/startup.log",
      mediaType: "text/plain",
      size: 32,
      sha256: createHash("sha256").update("startup-log-content").digest("hex"),
      storageRef: "logs/startup.log",
    },
    {
      artifactId: "runtime-stdout",
      type: "runtime-stdout",
      path: "logs/runtime-stdout.log",
      mediaType: "text/plain",
      size: 32,
      sha256: createHash("sha256").update("runtime-stdout-content").digest("hex"),
      storageRef: "logs/runtime-stdout.log",
    },
    {
      artifactId: "runtime-stderr",
      type: "runtime-stderr",
      path: "logs/runtime-stderr.log",
      mediaType: "text/plain",
      size: 32,
      sha256: createHash("sha256").update("runtime-stderr-content").digest("hex"),
      storageRef: "logs/runtime-stderr.log",
    },
    {
      artifactId: "substrate-attestation",
      type: "substrate-attestation",
      path: "attestation.json",
      mediaType: "application/json",
      size: 32,
      sha256: createHash("sha256").update("attestation-content").digest("hex"),
      storageRef: "attestation.json",
    },
  ];

  const manifestWithoutHash = {
    executionId,
    repositorySha,
    workerId,
    substrateInstanceId,
    entries: defaultEntries,
    createdAt: new Date().toISOString(),
  };
  const manifestHash = computeManifestHash(manifestWithoutHash);
  return signArtifactManifest(
    { ...manifestWithoutHash, manifestHash },
    opts.launcherPrivateKeyPem
  );
}
