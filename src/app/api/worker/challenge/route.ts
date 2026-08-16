import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { randomUUID } from "node:crypto";

// POST /api/worker/challenge
//
// Phase 18U: Server-issued, PERSISTED, single-use challenge for re-registration.
//
// Creates a WorkerChallenge record in the database with:
//   - unique nonce
//   - full challenge string
//   - 60-second expiry
//   - status = PENDING
//
// The challenge is consumed atomically by /api/worker/register (PENDING → CONSUMED).
// A challenge can authenticate exactly one re-registration.
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
        error: "REJECTED: Challenge endpoint requires ACTIVE enrollment.",
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

    // Generate server-issued challenge.
    const nonce = randomUUID();
    const expiryMs = Date.now() + 60000; // 60 seconds
    const challengeStr = `FORGE_REREGISTER:${workerId}:${nonce}:${expiryMs}`;
    const expiresAt = new Date(expiryMs);

    // Phase 18U: PERSIST the challenge in the database.
    // The register endpoint will look up this exact record by nonce.
    await db.workerChallenge.create({
      data: {
        workerId,
        nonce,
        challenge: challengeStr,
        expiresAt,
        status: "PENDING",
      },
    });

    return NextResponse.json({
      ok: true,
      challenge: challengeStr,
      nonce,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
