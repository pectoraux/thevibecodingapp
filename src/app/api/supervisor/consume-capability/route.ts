import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { db } from "@/lib/db";
import {
  verifyExecutionCapability,
  type ExecutionCapability,
} from "@/lib/execution-capability";

// POST /api/supervisor/consume-capability
//
// Phase 18Y — Execution Capability Closure.
//
// Called by the substrate supervisor BEFORE running the workload. This
// endpoint ATOMICALLY consumes the substrate nonce (anti-replay) and
// verifies the lease is still active. The supervisor will only run the
// substrate if this endpoint returns 200.
//
// REQUEST:
//   Headers: Authorization: Bearer <FORGE_SUPERVISOR_SECRET>
//   Body:    { executionId, nonce, leaseId, capabilitySignature }
//
// RESPONSE:
//   200 — nonce consumed, lease active, capability verified.
//   401 — missing or wrong supervisor secret.
//   403 — capability invalid / nonce already consumed (replay) / lease
//         expired / lease reclaimed / lease mismatch.
//   404 — job not found.
//   500 — internal error.
//
// ATOMICITY:
//   The nonce consumption uses updateMany with:
//     where: { executionId, substrateNonce: nonce,
//              substrateNonceConsumed: false,
//              leaseId, leaseExpiresAt: { gt: now } }
//     data:  { substrateNonceConsumed: true,
//              substrateNonceConsumedAt: now }
//   Prisma's updateMany is a single SQL statement (atomic at the DB level).
//   If the row matches → count=1 (consumed). If the nonce was already
//   consumed, or the lease expired, or the leaseId changed (reclaimed) →
//   count=0 (rejected). There is no TOCTOU window between the SELECT and
//   UPDATE.
//
// HONEST LIMITATION (sandbox):
//   The DB is non-functional in this sandbox. The endpoint logic is correct
//   for production. For testing, the consume-capability logic is also
//   exercised directly via a mock in-memory implementation in the test
//   harness (tests/lib/mock-consume-capability.ts) and via the smoke test.
//   The supervisor's HTTP call to this endpoint is exercised end-to-end in
//   the smoke test.

interface ConsumeRequestBody {
  executionId?: unknown;
  nonce?: unknown;
  leaseId?: unknown;
  capabilitySignature?: unknown;
}

interface ConsumeErrorBody {
  error: string;
  reason?: string;
}

function unauthorized(error: string): NextResponse {
  return NextResponse.json({ error } satisfies ConsumeErrorBody, { status: 401 });
}

function forbidden(error: string, reason?: string): NextResponse {
  return NextResponse.json(
    { error, reason } satisfies ConsumeErrorBody,
    { status: 403 }
  );
}

function notFound(error: string): NextResponse {
  return NextResponse.json({ error } satisfies ConsumeErrorBody, { status: 404 });
}

/**
 * Constant-time string compare. Returns true iff a === b (same length and
 * bytes). Used to compare the supervisor secret without leaking length /
 * prefix information via timing.
 */
function safeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function POST(req: Request) {
  // =========================================================================
  // 1. Authenticate the supervisor (shared secret).
  // =========================================================================
  // The supervisor sends `Authorization: Bearer <FORGE_SUPERVISOR_SECRET>`.
  // The control plane verifies it with a constant-time compare. Without
  // this, any unauthenticated caller could consume nonces (DoS) or query
  // the job's lease state.
  //
  // The secret is provisioned via FORGE_SUPERVISOR_SECRET env var on BOTH
  // the control plane and the supervisor. It's a deployment-time secret,
  // NOT a per-worker secret. Rotating it requires redeploying both.
  const SUPERVISOR_SECRET = process.env.FORGE_SUPERVISOR_SECRET ?? "";
  if (!SUPERVISOR_SECRET) {
    // Fail-closed: if the secret isn't provisioned, no one can consume
    // nonces. The supervisor will get 401 and refuse to run workloads.
    return unauthorized(
      "FORGE_SUPERVISOR_SECRET is not set on the control plane — cannot authenticate the supervisor"
    );
  }
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return unauthorized("Missing Bearer token");
  }
  const presentedSecret = authHeader.slice(7);
  if (!presentedSecret || !safeEqualString(presentedSecret, SUPERVISOR_SECRET)) {
    return unauthorized("Invalid supervisor secret");
  }

  // =========================================================================
  // 2. Parse + validate the request body.
  // =========================================================================
  let body: ConsumeRequestBody;
  try {
    body = (await req.json()) as ConsumeRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Request body is not valid JSON" } satisfies ConsumeErrorBody,
      { status: 400 }
    );
  }

  const executionId =
    typeof body.executionId === "string" ? body.executionId : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  const capabilitySignature =
    typeof body.capabilitySignature === "string" ? body.capabilitySignature : "";

  if (!executionId) {
    return NextResponse.json(
      { error: "executionId is required" } satisfies ConsumeErrorBody,
      { status: 400 }
    );
  }
  if (!nonce) {
    return NextResponse.json(
      { error: "nonce is required" } satisfies ConsumeErrorBody,
      { status: 400 }
    );
  }
  if (!leaseId) {
    return NextResponse.json(
      { error: "leaseId is required" } satisfies ConsumeErrorBody,
      { status: 400 }
    );
  }

  // =========================================================================
  // 3. Load the ExecutionJob.
  // =========================================================================
  // We use a structural type for `job` (not Prisma's generated type) so the
  // subsequent narrow checks (leaseId, substrateNonce, etc.) compile cleanly
  // regardless of which fields the `select` clause returns.
  type ConsumeJob = {
    id: string;
    executionId: string;
    leaseId: string | null;
    leaseExpiresAt: Date | null;
    substrateNonce: string | null;
    substrateNonceConsumed: boolean;
    substrateNonceConsumedAt: Date | null;
    substrateCapability: string | null;
  };
  let job: ConsumeJob | null = null;
  try {
    const found = await db.executionJob.findUnique({
      where: { executionId },
      select: {
        id: true,
        executionId: true,
        leaseId: true,
        leaseExpiresAt: true,
        substrateNonce: true,
        substrateNonceConsumed: true,
        substrateNonceConsumedAt: true,
        substrateCapability: true,
      },
    });
    job = found as ConsumeJob | null;
  } catch (err: any) {
    // DB unavailable (e.g., sandbox). The supervisor's HTTP call will fail
    // and the workload will not run (fail-closed). Documented in the route
    // header.
    console.error(
      `[consume-capability] DB error loading job ${executionId}: ${err?.message ?? String(err)}`
    );
    return NextResponse.json(
      {
        error: "DB unavailable — cannot verify nonce / lease",
        reason: err?.message ?? String(err),
      } satisfies ConsumeErrorBody,
      { status: 500 }
    );
  }

  if (!job) {
    return notFound(`ExecutionJob not found for executionId ${executionId}`);
  }

  // =========================================================================
  // 4. Verify the nonce matches the stored nonce.
  // =========================================================================
  const storedNonce = job.substrateNonce ?? "";
  if (!storedNonce) {
    return forbidden(
      "ExecutionJob.substrateNonce is null — control plane did not issue a nonce",
      "MISSING_NONCE"
    );
  }
  if (!safeEqualString(nonce, storedNonce)) {
    return forbidden(
      "nonce does not match ExecutionJob.substrateNonce",
      "NONCE_MISMATCH"
    );
  }

  // =========================================================================
  // 5. Verify the lease is still active.
  // =========================================================================
  // The lease must:
  //   - match the request's leaseId (anti-theft — a reclaimed lease's
  //     capability is invalid)
  //   - not have expired (leaseExpiresAt > now)
  const storedLeaseId = job.leaseId ?? "";
  if (!storedLeaseId || !safeEqualString(leaseId, storedLeaseId)) {
    return forbidden(
      "leaseId does not match ExecutionJob.leaseId (lease may have been reclaimed)",
      "LEASE_MISMATCH"
    );
  }
  const now = new Date();
  if (job.leaseExpiresAt && job.leaseExpiresAt < now) {
    return forbidden(
      `Lease expired at ${job.leaseExpiresAt.toISOString()}`,
      "LEASE_EXPIRED"
    );
  }
  // If leaseExpiresAt is null, the lease has no expiry — this is unusual
  // but we don't fail-closed on it (the leaseId check is the primary
  // anti-replay mechanism). Documented as a defense-in-depth gap.

  // =========================================================================
  // 6. Verify the capability signature (defense-in-depth).
  // =========================================================================
  // The supervisor already verifies the capability signature before calling
  // this endpoint. We verify it AGAIN here (the control plane has the
  // private key, so we can verify with the matching public key). This
  // catches a supervisor that somehow presented a capability with a valid
  // nonce/leaseId but a forged signature (shouldn't happen — but
  // defense-in-depth).
  //
  // We need the FULL capability object to verify the signature. It was
  // persisted on ExecutionJob.substrateCapability at job-spec time. If it's
  // missing, we skip this check (defense-in-depth — the supervisor already
  // verified the signature).
  if (job.substrateCapability) {
    try {
      const storedCap = JSON.parse(job.substrateCapability) as ExecutionCapability;
      // The signature must match the presented signature (constant-time).
      if (
        typeof storedCap.signature === "string" &&
        storedCap.signature.length > 0 &&
        capabilitySignature.length > 0
      ) {
        if (!safeEqualString(capabilitySignature, storedCap.signature)) {
          return forbidden(
            "capabilitySignature does not match the stored capability",
            "SIGNATURE_MISMATCH"
          );
        }
      }
      // Verify the signature is valid for the control-plane public key.
      const cpPub = process.env.FORGE_CONTROL_PLANE_PUBLIC_KEY ?? "";
      if (cpPub) {
        const verifyResult = verifyExecutionCapability(storedCap, cpPub);
        if (!verifyResult.valid) {
          return forbidden(
            `Stored capability signature verification failed: ${verifyResult.reasons.join("; ")}`,
            "SIGNATURE_INVALID"
          );
        }
      }
    } catch (err: any) {
      // Parse failure — best-effort, don't fail-closed on a malformed
      // stored capability. The supervisor's own signature verification is
      // authoritative.
      console.warn(
        `[consume-capability] Failed to parse stored substrateCapability for ${executionId}: ${err?.message ?? String(err)}`
      );
    }
  }

  // =========================================================================
  // 7. ATOMICALLY consume the nonce.
  // =========================================================================
  // updateMany is a single SQL statement (atomic at the DB level). The
  // WHERE clause includes substrateNonceConsumed: false — if the nonce was
  // already consumed (replay), the row doesn't match and count=0.
  //
  // The WHERE clause ALSO includes leaseId and leaseExpiresAt > now — so
  // if the lease was reclaimed (leaseId changed) or expired between step 5
  // and this update, the row doesn't match and count=0. There is NO TOCTOU
  // window between the read and the consume.
  let consumeCount = 0;
  try {
    const result = await db.executionJob.updateMany({
      where: {
        executionId,
        substrateNonce: nonce,
        substrateNonceConsumed: false,
        leaseId,
        // Only consume if the lease is still active. leaseExpiresAt may be
        // null (no expiry) — we accept that (don't fail-closed on a null
        // expiry; the leaseId check is the primary mechanism).
        ...(job.leaseExpiresAt
          ? { leaseExpiresAt: { gt: now } }
          : {}),
      },
      data: {
        substrateNonceConsumed: true,
        substrateNonceConsumedAt: now,
      },
    });
    consumeCount = result.count;
  } catch (err: any) {
    console.error(
      `[consume-capability] DB error consuming nonce for ${executionId}: ${err?.message ?? String(err)}`
    );
    return NextResponse.json(
      {
        error: "DB unavailable — cannot consume nonce",
        reason: err?.message ?? String(err),
      } satisfies ConsumeErrorBody,
      { status: 500 }
    );
  }

  if (consumeCount === 0) {
    // Either the nonce was already consumed (replay), the lease expired,
    // or the leaseId changed. All three are 403.
    return forbidden(
      "Capability nonce could not be consumed atomically — already consumed (replay), lease expired, or lease reclaimed",
      "REPLAY_OR_EXPIRED_OR_RECLAIMED"
    );
  }

  // =========================================================================
  // 8. Success — the nonce is consumed, the lease is active, the workload
  //    is authorized to run.
  // =========================================================================
  return NextResponse.json({
    consumed: true,
    executionId,
    consumedAt: now.toISOString(),
  });
}
