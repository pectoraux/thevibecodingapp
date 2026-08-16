import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { verify as cryptoVerify } from "node:crypto";

// POST /api/worker/rotate-key
//
// Phase 18H: Authorized key rotation for worker signing keys.
//
// The public key is immutable after initial registration. To rotate:
//   1. The worker must prove possession of the CURRENT private key by
//      signing a rotation challenge.
//   2. The worker provides the new public key.
//   3. The control plane verifies the rotation signature with the current
//      registered public key.
//   4. Only then is the key replaced.
//
// This prevents a compromised worker credential (session token) from
// replacing the trust anchor — the attacker would also need the worker's
// Ed25519 private key, which never leaves the worker.
//
// Alternative: admin authorization (future — via admin API key).
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req);
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const workerId = token.workerId;
    const body = await req.json();
    const { newPublicKeyPem, rotationSignature, rotationChallenge } = body;

    if (!newPublicKeyPem || !rotationSignature || !rotationChallenge) {
      return NextResponse.json({
        error: "Missing required fields: newPublicKeyPem, rotationSignature, rotationChallenge",
      }, { status: 400 });
    }

    // Resolve the current registered public key.
    const worker = await db.workerRegistry.findUnique({
      where: { workerId },
      select: { publicKeyPem: true },
    });

    if (!worker || !worker.publicKeyPem) {
      return NextResponse.json({
        error: "Worker has no registered signing key. Use /api/worker/register to register an initial key.",
      }, { status: 403 });
    }

    // Verify the rotation signature with the CURRENT registered public key.
    // The rotation challenge is: "FORGE_KEY_ROTATION:{workerId}:{newPublicKeyPem}"
    const expectedChallenge = `FORGE_KEY_ROTATION:${workerId}:${newPublicKeyPem}`;
    if (rotationChallenge !== expectedChallenge) {
      return NextResponse.json({
        error: "Invalid rotation challenge. Expected: FORGE_KEY_ROTATION:{workerId}:{newPublicKeyPem}",
      }, { status: 400 });
    }

    const challengeData = Buffer.from(rotationChallenge, "utf-8");
    const sigBuf = Buffer.from(rotationSignature, "hex");

    let signatureValid = false;
    try {
      signatureValid = cryptoVerify(null, challengeData, worker.publicKeyPem, sigBuf);
    } catch {
      signatureValid = false;
    }

    if (!signatureValid) {
      return NextResponse.json({
        error: "REJECTED: Rotation signature verification FAILED. The worker must prove possession of the current private key to rotate.",
      }, { status: 403 });
    }

    // Signature valid — atomically replace the key.
    await db.workerRegistry.update({
      where: { workerId },
      data: { publicKeyPem: newPublicKeyPem },
    });

    return NextResponse.json({
      ok: true,
      message: "Signing key rotated successfully. New key is now active.",
      workerId,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
