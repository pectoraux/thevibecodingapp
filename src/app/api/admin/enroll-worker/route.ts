import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { requireUserId } from "@/lib/auth";

// POST /api/admin/enroll-worker
//
// Phase 18Q: Pre-provision a trusted worker identity.
//
// An admin creates a WorkerEnrollment BEFORE the worker starts.
// The enrollment binds:
//   - workerId (chosen by admin, not by the worker)
//   - expectedPublicKeyFingerprint (SHA-256 of the worker's Ed25519 public key PEM)
//   - enrollmentSecret (one-time, bcrypt-hashed)
//
// The worker later proves possession of its Ed25519 private key by signing
// a challenge. The control plane verifies the signature against the expected
// fingerprint. Only then is the worker activated.
//
// This removes the ability of anyone with FORGE_WORKER_SECRET to create
// arbitrary workerId → publicKey bindings.
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { workerId, publicKeyPem } = body;

    if (!workerId || !publicKeyPem) {
      return NextResponse.json({ error: "Missing required fields: workerId, publicKeyPem" }, { status: 400 });
    }

    // Compute the fingerprint of the provided public key.
    const fingerprint = createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 32);

    // Generate a one-time enrollment secret.
    const enrollmentSecret = randomUUID();
    const enrollmentSecretHash = bcrypt.hashSync(enrollmentSecret, 10);

    // Check if worker is already enrolled.
    const existing = await db.workerEnrollment.findUnique({
      where: { workerId },
    });

    if (existing) {
      if (existing.status === "ACTIVE") {
        return NextResponse.json({
          error: "Worker is already enrolled and active. Use /api/worker/rotate-key for key rotation.",
        }, { status: 409 });
      }
      if (existing.status === "PENDING") {
        // Update the pending enrollment with the new key fingerprint.
        await db.workerEnrollment.update({
          where: { workerId },
          data: {
            expectedPublicKeyFingerprint: fingerprint,
            enrollmentSecretHash,
            createdBy: userId,
          },
        });
        return NextResponse.json({
          ok: true,
          workerId,
          enrollmentSecret,
          message: "Pending enrollment updated. Worker can now activate by proving key possession.",
        });
      }
    }

    // Create new enrollment.
    await db.workerEnrollment.create({
      data: {
        workerId,
        expectedPublicKeyFingerprint: fingerprint,
        enrollmentSecretHash,
        status: "PENDING",
        createdBy: userId,
      },
    });

    return NextResponse.json({
      ok: true,
      workerId,
      enrollmentSecret,
      publicKeyFingerprint: fingerprint,
      message: "Worker enrollment created. The worker must prove possession of its Ed25519 private key to activate. Provide the enrollmentSecret to the worker via a secure out-of-band channel.",
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
