import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { requireUserId, isAdmin } from "@/lib/auth";

// POST /api/admin/enroll-worker
//
// Phase 18Q/18R: Pre-provision a trusted worker identity.
// Phase 18R fixes:
//   - ADMIN-ONLY (not any authenticated user)
//   - Full SHA-256 fingerprint (not truncated to 128 bits)
//   - Enrollment expiration (expiresAt)
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Phase 18R P0 #1: ADMIN-ONLY authorization.
    const admin = await isAdmin();
    if (!admin) {
      return NextResponse.json({ error: "Forbidden: admin role required to enroll workers" }, { status: 403 });
    }

    const body = await req.json();
    const { workerId, publicKeyPem } = body;

    if (!workerId || !publicKeyPem) {
      return NextResponse.json({ error: "Missing required fields: workerId, publicKeyPem" }, { status: 400 });
    }

    // Phase 18R P0 #3: Full SHA-256 fingerprint (64 hex chars = 256 bits, not truncated).
    const fingerprint = createHash("sha256").update(publicKeyPem).digest("hex");

    // Generate a one-time enrollment secret.
    const enrollmentSecret = randomUUID();
    const enrollmentSecretHash = bcrypt.hashSync(enrollmentSecret, 10);

    // Phase 18R: Enrollment expires in 24 hours.
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

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
        // Update the pending enrollment with the new key fingerprint + new expiration.
        await db.workerEnrollment.update({
          where: { workerId },
          data: {
            expectedPublicKeyFingerprint: fingerprint,
            enrollmentSecretHash,
            expiresAt,
            createdBy: userId,
          },
        });
        return NextResponse.json({
          ok: true,
          workerId,
          enrollmentSecret,
          expiresAt: expiresAt.toISOString(),
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
        expiresAt,
        createdBy: userId,
      },
    });

    return NextResponse.json({
      ok: true,
      workerId,
      enrollmentSecret,
      publicKeyFingerprint: fingerprint,
      expiresAt: expiresAt.toISOString(),
      message: "Worker enrollment created. The worker must prove possession of its Ed25519 private key to activate. Provide the enrollmentSecret to the worker via a secure out-of-band channel.",
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
