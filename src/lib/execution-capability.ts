// Forge — Phase 18X / 18Y: Execution Capability.
//
// A control-plane-signed capability that AUTHORIZES a worker (via the
// substrate supervisor) to run a SPECIFIC workload inside the substrate.
//
// ARCHITECTURE (Phase 18Y — Execution Capability Closure):
//
//   Control Plane (holds FORGE_CONTROL_PLANE_PRIVATE_KEY)
//       │  signs ExecutionCapability {
//       │            executionId, nonce, leaseId,
//       │            repositoryHeadSha, runtimePlanHash, architectureHash,
//       │            workloadHash, runtimePlan (FULL plan — signed),
//       │            expiresAt }
//       ▼
//   Worker (UNTRUSTED — has ONLY its worker key, NEVER the launcher key,
//           NEVER any execution recipe)
//       │  POSTs { capability, repoPath } to the supervisor
//       │  (NO workload field — the supervisor derives the workload)
//       ▼
//   Substrate Supervisor (TRUSTED — holds launcher key IN MEMORY, file deleted)
//       │  1. verifyExecutionCapability(cap, FORGE_CONTROL_PLANE_PUBLIC_KEY)
//       │  2. POST /api/supervisor/consume-capability { executionId, nonce,
//       │     leaseId, capabilitySignature } — control plane atomically
//       │     consumes the nonce (anti-replay) + verifies the lease is still
//       │     active. Returns 200 only on success; 403 on replay / expired /
//       │     reclaimed lease.
//       │  3. deriveWorkloadFromPlan(cap.runtimePlan) → { binary, args, cwd,
//       │     envKeys, timeoutMs, includeProc }
//       │  4. computeWorkloadHash(derived) — MUST equal cap.workloadHash.
//       │  5. Verify repo: git -C repoPath rev-parse HEAD === cap.repositoryHeadSha
//       │     AND git -C repoPath status --porcelain is empty (clean tree).
//       │  6. Write plan.json (from cap.runtimePlan) + copy orchestrator.js
//       │     into a workspace dir.
//       │  7. runInSubstrate({ ..., nonce: cap.nonce,
//       │                     executionId: cap.executionId,
//       │                     launcherKeyPem, cwd: repoPath })
//       │  8. returns { attestation, result, results } — NEVER the launcher key
//       ▼
//   Worker receives the signed attestation, builds the envelope, signs with
//   its worker key, submits to the control plane.
//
// WHY THE WORKLOAD IS DERIVED, NOT SUPPLIED (Phase 18Y — P0 closure):
// Before 18Y, the supervisor accepted `workload` from the worker's POST body.
// A compromised worker with a valid capability could execute arbitrary
// commands. Phase 18Y closes this: the control plane signs the full
// RuntimeVerificationPlan into the capability, and the supervisor DERIVES
// the workload (binary="node", args=["/workspace/orchestrator.js"],
// cwd="/workspace/repo") from the signed plan. The worker cannot change
// the install/build/start commands — those come from the signed plan, which
// the orchestrator reads from /workspace/plan.json.
//
// WHY THE NONCE IS CONSUMED (Phase 18Y — P0 closure):
// Before 18Y, the capability was valid for 5 minutes with no nonce
// consumption, allowing multiple replays. Phase 18Y adds an atomic
// consume-capability endpoint that the supervisor calls before running the
// substrate. The control plane's updateMany with
//   where: { id, substrateNonce: nonce, substrateNonceConsumed: false }
//   data:  { substrateNonceConsumed: true, substrateNonceConsumedAt: now }
// is atomic: the first call returns count=1 (consumed), any subsequent call
// returns count=0 (replay → 403).
//
// WHY THE LEASE IS CHECKED (Phase 18Y — P0 closure):
// Before 18Y, the supervisor didn't verify the lease was still active. A
// reclaimed lease's capability still worked for 5 minutes. The
// consume-capability endpoint checks the lease hasn't expired (and matches
// the job's leaseId), preventing use of a capability whose lease was
// reclaimed.
//
// FIELDS:
//   executionId      — binds to a specific execution row in the DB.
//   nonce            — the substrate launcher nonce (must match the
//                      attestation's nonce — anti-replay). Also used as the
//                      atomic-consumption key in the consume-capability
//                      endpoint (substrateNonceConsumed).
//   leaseId          — the lease this execution runs under (anti-theft).
//                      The consume-capability endpoint verifies this still
//                      matches the job's current leaseId AND the lease
//                      hasn't expired.
//   repositoryHeadSha — the exact git SHA the substrate MUST run. The
//                      supervisor verifies git -C repoPath rev-parse HEAD
//                      === this value AND the working tree is clean.
//   runtimePlanHash  — hash of the runtime plan (informational — the full
//                      plan is also signed, see runtimePlan).
//   architectureHash — the architecture hash (may be null).
//   workloadHash     — SHA-256 of the canonical workload recipe the
//                      supervisor must execute. The supervisor computes
//                      this from the derived workload and compares. If
//                      mismatch → 403 (the capability doesn't authorize
//                      this workload — shouldn't happen if the control
//                      plane signed correctly, but defense-in-depth).
//   runtimePlan      — the FULL RuntimeVerificationPlan, signed as part of
//                      the capability. The supervisor derives the workload
//                      from this (binary="node",
//                      args=["/workspace/orchestrator.js"], cwd="/workspace/repo",
//                      timeoutMs=plan.totalTimeoutMs ?? 300000) and writes
//                      it to /workspace/plan.json for the orchestrator.
//                      The worker does NOT supply the plan.
//   expiresAt        — ISO timestamp; capability is invalid after this.
//   signature        — Ed25519 signature over canonicalCapabilityJson.
//   algorithm        — always "ed25519".
//   signedAt         — ISO timestamp the control plane signed.
//
// CANONICAL JSON: sorted keys, no whitespace. The same canonicalization is
// used for signing (control plane) and verification (supervisor). Any field
// drift between sign and verify breaks the signature.

import { sign as cryptoSign, verify as cryptoVerify, createHash } from "node:crypto";
import type { RuntimeVerificationPlan } from "@/lib/runtime-verification";

export interface ExecutionCapability {
  executionId: string;
  nonce: string;
  leaseId: string;
  repositoryHeadSha: string;
  /** Phase 18Z-PRE: The repository URL the supervisor must clone. The supervisor
   *  derives this from the signed capability — the worker does NOT supply a
   *  repoPath. The supervisor calls /api/supervisor/resolve-repo-credential to
   *  get the authenticated cloneUrl (the worker never sees the credential). */
  repositoryUrl: string;
  runtimePlanHash: string;
  architectureHash: string | null;
  /** Phase 18Y: SHA-256 of the canonical workload recipe the supervisor must execute. */
  workloadHash: string;
  /** Phase 18Y: The full RuntimeVerificationPlan, signed as part of the capability. */
  runtimePlan: Record<string, unknown>;
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
  /** Phase 18Z-PRE: The repository URL the supervisor must clone. */
  repositoryUrl: string;
  runtimePlanHash: string;
  architectureHash: string | null;
  /** Phase 18Y: SHA-256 of the canonical workload recipe the supervisor must execute. */
  workloadHash: string;
  /** Phase 18Y: The full RuntimeVerificationPlan, signed as part of the capability. */
  runtimePlan: Record<string, unknown>;
  expiresAt: string; // ISO timestamp
}

export interface ExecutionCapabilityVerificationResult {
  valid: boolean;
  reasons: string[];
}

/**
 * The workload recipe the supervisor derives from the signed runtime plan.
 *
 * The supervisor always uses:
 *   - binary: "node"
 *   - args:   ["/workspace/orchestrator.js"]
 *   - cwd:    "/workspace/repo" (fixed path INSIDE the substrate — the
 *             host-side repoPath is bind-mounted there)
 *   - envKeys: the KEY NAMES the supervisor allows (sorted; values are NOT
 *             part of the hash — they may contain secrets)
 *   - timeoutMs: plan.totalTimeoutMs ?? 300000 (5 min default)
 *   - includeProc: false (hermetic — no /proc)
 */
export interface DerivedWorkload {
  binary: string;
  args: string[];
  /** cwd POLICY — the fixed path INSIDE the substrate, NOT the host path. */
  cwd: string;
  /** Env KEY NAMES only (sorted) — values are NOT part of the hash. */
  envKeys: string[];
  timeoutMs: number;
  includeProc: boolean;
}

/**
 * Phase 18Y: Derive the workload recipe from a signed RuntimeVerificationPlan.
 *
 * The workload is ALWAYS `node /workspace/orchestrator.js` with the plan
 * written to /workspace/plan.json. The actual commands (install, build,
 * start) come from the plan, which is signed. The worker cannot change
 * them.
 *
 * The cwd is the fixed POLICY path "/workspace/repo" INSIDE the substrate
 * (the supervisor bind-mounts the host-side repoPath there). The host-side
 * repoPath is NOT part of the workload hash — it's just where the worker
 * cloned the repo on the host.
 *
 * totalTimeoutMs comes from the plan (default 5 min if absent). The plan
 * type from deriveRuntimeVerificationPlan does not declare totalTimeoutMs,
 * but the job-spec route may augment the plan object with it; we read it
 * defensively.
 */
export function deriveWorkloadFromPlan(
  plan: RuntimeVerificationPlan | Record<string, unknown>
): DerivedWorkload {
  const p = plan as Record<string, unknown>;
  const totalTimeoutMs =
    typeof p.totalTimeoutMs === "number" && p.totalTimeoutMs > 0
      ? p.totalTimeoutMs
      : 300000; // 5 min default
  return {
    binary: "node",
    args: ["/workspace/orchestrator.js"],
    cwd: "/workspace/repo", // fixed path inside the substrate
    envKeys: ["PATH", "HOME", "LANG", "NODE_ENV"], // allowed env keys
    timeoutMs: totalTimeoutMs,
    includeProc: false, // hermetic — no /proc
  };
}

/**
 * Phase 18Y: Compute the SHA-256 hash of a workload recipe.
 *
 * The canonical form is JSON with alphabetically sorted keys:
 *   { args, binary, cwd, envKeys (sorted), includeProc, timeoutMs }
 *
 * NOTE: cwd is the POLICY path (e.g., "/workspace/repo"), NOT the
 * worker-supplied host path. envKeys contains ONLY the key NAMES (sorted),
 * never the values (values may contain secrets).
 */
export function computeWorkloadHash(workload: {
  binary: string;
  args: string[];
  cwd: string;
  envKeys: string[];
  timeoutMs: number;
  includeProc: boolean;
}): string {
  const canonical = JSON.stringify({
    args: workload.args,
    binary: workload.binary,
    cwd: workload.cwd,
    envKeys: [...workload.envKeys].sort(),
    includeProc: workload.includeProc,
    timeoutMs: workload.timeoutMs,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Sign an ExecutionCapability with the control plane's Ed25519 private key.
 *
 * The signature is over canonicalCapabilityJson(input) — sorted keys, no
 * whitespace. The signed fields are: architectureHash, executionId, expiresAt,
 * leaseId, nonce, repositoryHeadSha, runtimePlan (canonical, recursive),
 * runtimePlanHash, workloadHash. (The signature, algorithm, and signedAt
 * fields are NOT included in the canonical form — they're added after
 * signing.)
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
    repositoryUrl: cap.repositoryUrl,
    runtimePlanHash: cap.runtimePlanHash,
    architectureHash: cap.architectureHash,
    workloadHash: cap.workloadHash,
    runtimePlan: cap.runtimePlan,
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
 * Recursive canonical serializer — object keys sorted at every nesting level,
 * arrays preserve order. Used for the runtimePlan field so the signature is
 * deterministic regardless of object insertion order.
 */
function canonicalSerializeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value.toString();
  if (typeof value === "number") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalSerializeValue).join(",") + "]";
  }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalSerializeValue(v[k]));
    return "{" + pairs.join(",") + "}";
  }
  return "null";
}

/**
 * Build the canonical JSON form of the capability input.
 *
 * Sorted keys, no whitespace. Same canonicalization at sign and verify time.
 * The signed fields are EXACTLY: architectureHash, executionId, expiresAt,
 * leaseId, nonce, repositoryHeadSha, runtimePlan (recursively canonical),
 * runtimePlanHash, workloadHash. (No signature, no algorithm, no signedAt —
 * those are added by signExecutionCapability AFTER the canonical form is
 * signed.)
 *
 * architectureHash is OMITTED from the canonical form when null (so a null
 * architectureHash produces the same canonical form as an omitted field —
 * important for forward/backward compatibility).
 *
 * runtimePlan is ALWAYS included (it's the full plan object). It's
 * recursively canonicalized so semantically identical plans with different
 * object insertion order hash identically.
 */
function canonicalCapabilityJson(input: ExecutionCapabilityInput | ExecutionCapability): string {
  const fields: Record<string, string | null> = {
    architectureHash: input.architectureHash,
    executionId: input.executionId,
    expiresAt: input.expiresAt,
    leaseId: input.leaseId,
    nonce: input.nonce,
    repositoryHeadSha: input.repositoryHeadSha,
    repositoryUrl: input.repositoryUrl,
    runtimePlan: canonicalSerializeValue(input.runtimePlan),
    runtimePlanHash: input.runtimePlanHash,
    workloadHash: input.workloadHash,
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
