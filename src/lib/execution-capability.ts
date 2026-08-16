// Forge — Phase 18X: Execution Capability.
//
// A control-plane-signed capability that AUTHORIZES a worker (via the
// substrate supervisor) to run a specific workload inside the substrate.
//
// ARCHITECTURE (Phase 18X — Launcher Key Isolation):
//
//   Control Plane (holds FORGE_CONTROL_PLANE_PRIVATE_KEY)
//       │  signs ExecutionCapability { executionId, nonce, leaseId,
//       │                            repoSha, planHash, archHash, expiresAt }
//       ▼
//   Worker (UNTRUSTED — has ONLY its worker key, NEVER the launcher key)
//       │  POSTs { capability, workload, repoPath } to the supervisor
//       ▼
//   Substrate Supervisor (TRUSTED — holds launcher key IN MEMORY, file deleted)
//       │  1. verifyExecutionCapability(cap, FORGE_CONTROL_PLANE_PUBLIC_KEY)
//       │  2. runInSubstrate({ ..., nonce: cap.nonce,
//       │                     executionId: cap.executionId,
//       │                     launcherKeyPem })  // from memory
//       │  3. returns { attestation, result } — NEVER the launcher key
//       ▼
//   Worker receives the signed attestation, builds the envelope, signs with
//   its worker key, submits to the control plane.
//
// Why this exists: the worker cannot be trusted to hold the launcher private
// key (it could forge attestations). The supervisor holds the launcher key,
// but it will not run a substrate for an arbitrary request — it requires a
// valid ExecutionCapability signed by the control plane. This binds the
// substrate execution to a specific executionId + nonce + leaseId + repoSha +
// planHash + archHash, all of which the control plane attests to.
//
// FIELDS:
//   executionId      — binds to a specific execution row in the DB.
//   nonce            — the substrate launcher nonce (must match the
//                      attestation's nonce — anti-replay).
//   leaseId          — the lease this execution runs under (anti-theft).
//   repositoryHeadSha — the exact git SHA the substrate MUST run.
//   runtimePlanHash  — the plan hash the substrate MUST use.
//   architectureHash — the architecture hash (may be null).
//   expiresAt        — ISO timestamp; capability is invalid after this.
//   signature        — Ed25519 signature over canonicalCapabilityJson.
//   algorithm        — always "ed25519".
//   signedAt         — ISO timestamp the control plane signed.
//
// CANONICAL JSON: sorted keys, no whitespace. The same canonicalization is
// used for signing (control plane) and verification (supervisor). Any field
// drift between sign and verify breaks the signature.

import { sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

export interface ExecutionCapability {
  executionId: string;
  nonce: string;
  leaseId: string;
  repositoryHeadSha: string;
  runtimePlanHash: string;
  architectureHash: string | null;
  expiresAt: string; // ISO timestamp
  // Control-plane signature fields (added by signExecutionCapability).
  signature: string;
  algorithm: "ed25519";
  signedAt: string; // ISO timestamp
}

export interface ExecutionCapabilityInput {
  executionId: string;
  nonce: string;
  leaseId: string;
  repositoryHeadSha: string;
  runtimePlanHash: string;
  architectureHash: string | null;
  expiresAt: string; // ISO timestamp
}

export interface ExecutionCapabilityVerificationResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Sign an ExecutionCapability with the control plane's Ed25519 private key.
 *
 * The signature is over canonicalCapabilityJson(input) — sorted keys, no
 * whitespace. The signed fields are: architectureHash, executionId, expiresAt,
 * leaseId, nonce, repositoryHeadSha, runtimePlanHash. (The signature,
 * algorithm, and signedAt fields are NOT included in the canonical form —
 * they're added after signing.)
 */
export function signExecutionCapability(
  input: ExecutionCapabilityInput,
  controlPlanePrivateKeyPem: string
): ExecutionCapability {
  if (!controlPlanePrivateKeyPem) {
    throw new Error(
      "signExecutionCapability: controlPlanePrivateKeyPem is required (control plane must provision FORGE_CONTROL_PLANE_PRIVATE_KEY)"
    );
  }
  const canonical = canonicalCapabilityJson(input);
  const signature = cryptoSign(
    null,
    Buffer.from(canonical, "utf-8"),
    controlPlanePrivateKeyPem
  ).toString("hex");
  return {
    ...input,
    signature,
    algorithm: "ed25519",
    signedAt: new Date().toISOString(),
  };
}

/**
 * Verify an ExecutionCapability against the control plane's pinned public key.
 *
 * Checks:
 *   1. Capability is non-null and has a signature.
 *   2. Algorithm is "ed25519".
 *   3. expiresAt is in the future.
 *   4. Ed25519 signature over canonicalCapabilityJson is valid for the pinned
 *      public key.
 *
 * Returns { valid, reasons }. An empty reasons array means valid.
 */
export function verifyExecutionCapability(
  cap: ExecutionCapability | null | undefined,
  controlPlanePublicKeyPem: string
): ExecutionCapabilityVerificationResult {
  const reasons: string[] = [];
  if (!cap) {
    return { valid: false, reasons: ["No execution capability provided"] };
  }
  if (!cap.signature) {
    reasons.push("ExecutionCapability.signature is missing");
  }
  if (cap.algorithm !== "ed25519") {
    reasons.push(`ExecutionCapability.algorithm is ${cap.algorithm} (expected ed25519)`);
  }
  if (!cap.expiresAt) {
    reasons.push("ExecutionCapability.expiresAt is missing");
  } else {
    const expiry = new Date(cap.expiresAt);
    if (isNaN(expiry.getTime())) {
      reasons.push(`ExecutionCapability.expiresAt is not a valid ISO timestamp: ${cap.expiresAt}`);
    } else if (expiry.getTime() < Date.now()) {
      reasons.push(`ExecutionCapability expired at ${cap.expiresAt}`);
    }
  }
  if (!controlPlanePublicKeyPem) {
    reasons.push("controlPlanePublicKeyPem is empty (FORGE_CONTROL_PLANE_PUBLIC_KEY not provisioned)");
  }

  // Signature verification — skip if any required field is missing.
  if (!cap.signature || cap.algorithm !== "ed25519" || !controlPlanePublicKeyPem) {
    return { valid: false, reasons };
  }

  // Reconstruct the canonical input from the capability (strip signature fields).
  const input: ExecutionCapabilityInput = {
    executionId: cap.executionId,
    nonce: cap.nonce,
    leaseId: cap.leaseId,
    repositoryHeadSha: cap.repositoryHeadSha,
    runtimePlanHash: cap.runtimePlanHash,
    architectureHash: cap.architectureHash,
    expiresAt: cap.expiresAt,
  };
  const canonical = canonicalCapabilityJson(input);
  const sigBuf = Buffer.from(cap.signature, "hex");
  try {
    const valid = cryptoVerify(
      null,
      Buffer.from(canonical, "utf-8"),
      controlPlanePublicKeyPem,
      sigBuf
    );
    if (!valid) {
      reasons.push("ExecutionCapability signature is INVALID for the pinned control-plane public key");
    }
  } catch (err) {
    reasons.push(
      `ExecutionCapability signature verification threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Build the canonical JSON form of the capability input.
 *
 * Sorted keys, no whitespace. Same canonicalization at sign and verify time.
 * The signed fields are EXACTLY: architectureHash, executionId, expiresAt,
 * leaseId, nonce, repositoryHeadSha, runtimePlanHash. (No signature, no
 * algorithm, no signedAt — those are added by signExecutionCapability AFTER
 * the canonical form is signed.)
 *
 * architectureHash is OMITTED from the canonical form when null (so a null
 * architectureHash produces the same canonical form as an omitted field —
 * important for forward/backward compatibility).
 */
function canonicalCapabilityJson(input: ExecutionCapabilityInput | ExecutionCapability): string {
  const fields: Record<string, string | null> = {
    architectureHash: input.architectureHash,
    executionId: input.executionId,
    expiresAt: input.expiresAt,
    leaseId: input.leaseId,
    nonce: input.nonce,
    repositoryHeadSha: input.repositoryHeadSha,
    runtimePlanHash: input.runtimePlanHash,
  };
  const keys = Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== null)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + JSON.stringify(fields[k])).join(",") +
    "}"
  );
}

/**
 * Convenience: build the canonical form for inspection/testing.
 */
export function canonicalExecutionCapabilityJson(
  input: ExecutionCapabilityInput | ExecutionCapability
): string {
  return canonicalCapabilityJson(input);
}
