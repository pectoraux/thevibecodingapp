// Forge — Phase 18Z-A: Content-addressed Artifact Store.
//
// The ArtifactStore persists execution artifacts (build logs, runtime stdout,
// health traces, the signed substrate attestation, ...) keyed by their SHA-256
// content hash. The store is a flat sharded directory:
//
//   <storeRoot>/<sha256[:2]>/<sha256[2:]>
//
// e.g. /var/forge-artifacts/ab/cdef1234... (62 chars)
//
// The store ENFORCES content integrity:
//   - store(content, declaredSha256?) hashes the content; if declaredSha256
//     is provided AND doesn't match, it throws (caller lied about the hash).
//   - After writing, it re-reads the file + hashes it; if the post-write hash
//     doesn't match, it throws (storage corruption — fail-closed).
//   - Same content → same path → idempotent (no rewrite if the file exists).
//   - Per-artifact size limit (MAX_ARTIFACT_SIZE_BYTES = 50 MiB).
//
// The store does NOT enforce the manifest signature — that's the verifier's
// job. The store is a dumb content-addressed blob store; the manifest is the
// signed index over the blobs.
//
// Storage layout: the manifest's `storageRef` field is what the launcher
// signed. The launcher writes the LOGICAL path (e.g. "logs/install.log") as
// the storageRef. The supervisor persists the artifact content to the store
// (keyed by sha256), but the manifest's storageRef STAYS as the launcher
// signed it — mutating it would break the signature. Consumers retrieve
// artifacts by sha256 (the content-addressed key), NOT by storageRef.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { MAX_ARTIFACT_SIZE_BYTES } from "@/lib/artifact-manifest";

export interface StoredArtifact {
  /** 64 hex chars — the content-addressed key. */
  sha256: string;
  /** Size in bytes. */
  size: number;
  /** The content-addressed path within the store (opaque to consumers). */
  storageRef: string;
}

export class ArtifactStore {
  constructor(private storeRoot: string) {
    // Create the store root. Sharded subdirs are created on demand.
    mkdirSync(storeRoot, { recursive: true });
  }

  /**
   * Store an artifact. Returns the storageRef (the content-addressed path
   * within the store).
   *
   * If `declaredSha256` is provided and doesn't match the content's actual
   * SHA-256, throws (caller lied about the hash — fail-closed).
   *
   * If the content already exists at the content-addressed path (same sha256),
   * the existing copy is kept (idempotent — no rewrite).
   *
   * After writing (or finding an existing copy), the file is re-read + hashed
   * to verify storage integrity. If the post-write hash doesn't match, throws
   * (storage corruption — fail-closed).
   *
   * Throws if content.length > MAX_ARTIFACT_SIZE_BYTES.
   */
  store(content: Buffer, declaredSha256?: string): StoredArtifact {
    if (!Buffer.isBuffer(content)) {
      throw new Error("ArtifactStore.store: content must be a Buffer");
    }
    if (content.length > MAX_ARTIFACT_SIZE_BYTES) {
      throw new Error(
        `ArtifactStore.store: artifact size ${content.length} exceeds limit ${MAX_ARTIFACT_SIZE_BYTES}`
      );
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (declaredSha256 && declaredSha256 !== sha256) {
      throw new Error(
        `ArtifactStore.store: content hash mismatch — declared=${declaredSha256} actual=${sha256} (caller lied about the hash — fail-closed)`
      );
    }
    const storageRef = this.pathFor(sha256);
    if (!existsSync(storageRef)) {
      // Create the sharded subdirectory (<storeRoot>/<sha256[:2]>/) if it
      // doesn't exist. mkdirSync with recursive:true is a no-op if the dir
      // already exists.
      const shardDir = dirname(storageRef);
      mkdirSync(shardDir, { recursive: true });
      // Write with mode 0600 — owner read/write only. The store contains
      // build logs + runtime output which may leak source structure (but
      // never secrets — the substrate env was sanitized).
      writeFileSync(storageRef, content, { mode: 0o600 });
    }
    // Post-write verification — re-read + hash. Catches disk corruption,
    // concurrent writers, NFS issues, etc.
    const written = readFileSync(storageRef);
    const writtenHash = createHash("sha256").update(written).digest("hex");
    if (writtenHash !== sha256) {
      throw new Error(
        `ArtifactStore.store: post-write hash verification failed — expected=${sha256} actual=${writtenHash} (storage corruption — fail-closed)`
      );
    }
    return { sha256, size: content.length, storageRef };
  }

  /**
   * Retrieve an artifact by its SHA-256 content hash. Returns the raw bytes.
   *
   * Throws if sha256 is not a valid 64-hex string or the artifact doesn't
   * exist in the store.
   */
  retrieve(sha256: string): Buffer {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`ArtifactStore.retrieve: invalid sha256 (expected 64 hex chars): ${sha256}`);
    }
    const storageRef = this.pathFor(sha256);
    if (!existsSync(storageRef)) {
      throw new Error(`ArtifactStore.retrieve: artifact not found: ${sha256}`);
    }
    const content = readFileSync(storageRef);
    // Verify the retrieved content matches the requested hash (defense-in-
    // depth — catches disk corruption that occurred after the initial store()).
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== sha256) {
      throw new Error(
        `ArtifactStore.retrieve: post-read hash verification failed — expected=${sha256} actual=${actualHash} (storage corruption — fail-closed)`
      );
    }
    return content;
  }

  /**
   * Check whether an artifact exists in the store. Returns false for invalid
   * sha256 strings (defense-in-depth — never throws on bad input).
   */
  exists(sha256: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return false;
    return existsSync(this.pathFor(sha256));
  }

  /**
   * The content-addressed path: <storeRoot>/<sha256[:2]>/<sha256[2:]>.
   *
   * Sharding by the first 2 hex chars (256 buckets) keeps any single
   * directory from growing unbounded. The remaining 62 chars are the filename.
   */
  private pathFor(sha256: string): string {
    return join(this.storeRoot, sha256.slice(0, 2), sha256.slice(2));
  }
}
