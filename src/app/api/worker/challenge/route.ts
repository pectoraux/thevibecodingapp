import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { randomUUID } from "node:crypto";

// POST /api/worker/challenge
//
// Phase 18T: Server-issued one-time challenge for re-registration.
//
// An ACTIVE worker that needs to re-register (after restart) must:
//   1. Call this endpoint to get a server-issued challenge.
//   2. Sign the challenge with its Ed25519 private key.
//   3. Submit the signed challenge to /api/worker/register.
//
// The challenge includes a nonce and expiry, preventing replay.
// The challenge is valid for 60 seconds.
//
// This endpoint accepts a REGISTRATION token (HMAC bootstrap) since the
// worker doesn't have a session/execution token during re-registration.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req, "REGISTRATION");
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const workerId = token.workerId;

    // Verify the worker has an ACTIVE enrollment and registered key.
    const enrollment = await db.workerEnrollment.findUnique({
      where: { workerId },
      select: { status: true },
    });

    if (!enrollment || enrollment.status !== "ACTIVE") {
      return NextResponse.json({
        error: "REJECTED: Challenge endpoint requires ACTIVE enrollment. Use /api/worker/register for first registration.",
      }, { status: 403 });
    }

    const existingWorker = await db.workerRegistry.findUnique({
      where: { workerId },
      select: { publicKeyPem: true },
    });

    if (!existingWorker || !existingWorker.publicKeyPem) {
      return NextResponse.json({
        error: "REJECTED: No registered public key found.",
      }, { status: 403 });
    }

    // Generate server-issued challenge: FORGE_REREGISTER:{workerId}:{nonce}:{expiry}
    const nonce = randomUUID();
    const expiryMs = Date.now() + 60000; // 60 seconds
    const challenge = `FORGE_REREGISTER:${workerId}:${nonce}:${expiryMs}`;

    return NextResponse.json({
      ok: true,
      challenge,
      nonce,
      expiresAt: new Date(expiryMs).toISOString(),
      message: "Sign this challenge with your Ed25519 private key and submit it to /api/worker/register as enrollmentSignature. Include reregisterChallenge and reregisterNonce in the body.",
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
