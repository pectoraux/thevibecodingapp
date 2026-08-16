import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { createHash, verify as cryptoVerify, sign as cryptoSign } from "node:crypto";
import bcrypt from "bcryptjs";

// POST /api/worker/register
//
// Phase 18Q: Trusted Worker Enrollment.
//
// The worker proves possession of its Ed25519 private key by signing
// an enrollment challenge. The control plane verifies:
//   1. A PENDING WorkerEnrollment exists for this workerId.
//   2. The enrollment secret matches (one-time use).
//   3. The provided public key matches the expected fingerprint.
//   4. The Ed25519 signature over the challenge is valid.
//
// Only then is the worker activated in WorkerRegistry.
//
// This removes the ability of anyone with FORGE_WORKER_SECRET to create
// arbitrary workerId → publicKey bindings. The worker identity is
// pre-provisioned by an admin, not self-claimed.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req, "REGISTRATION");
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await req.json();
    const workerId = token.workerId;

    if (!body.workerVersion || !body.protocolVersion) {
      return NextResponse.json({ error: "workerVersion, protocolVersion required" }, { status: 400 });
    }

    if (body.protocolVersion !== "v1") {
      return NextResponse.json({ error: `Unsupported protocol version: ${body.protocolVersion}` }, { status: 400 });
    }

    const capabilities = body.capabilities || token.capabilities || ["node", "git", "test", "build"];
    const publicKeyPem = body.publicKeyPem as string | undefined;
    const enrollmentSecret = body.enrollmentSecret as string | undefined;
    const enrollmentSignature = body.enrollmentSignature as string | undefined;

    // Phase 18Q: Check if worker is already registered with a key.
    const existing = await db.workerRegistry.findUnique({
      where: { workerId },
      select: { publicKeyPem: true },
    });

    // Phase 18L: Allow re-registration with the SAME key (worker restart).
    if (existing && existing.publicKeyPem && publicKeyPem && publicKeyPem !== existing.publicKeyPem) {
      return NextResponse.json({
        error: "REJECTED: Worker already has a registered signing key. Key rotation requires /api/worker/rotate-key.",
      }, { status: 403 });
    }

    // Phase 18Q: If worker already has the SAME key, allow re-registration (restart).
    if (existing && existing.publicKeyPem && publicKeyPem === existing.publicKeyPem) {
      const worker = await db.workerRegistry.update({
        where: { workerId },
        data: {
          workerVersion: body.workerVersion,
          protocolVersion: body.protocolVersion,
          capabilities: JSON.stringify(capabilities),
          maxConcurrency: body.maxConcurrency || 1,
          status: "READY",
          lastHeartbeat: new Date(),
        },
      });
      const { createWorkerSessionToken } = await import("@/lib/worker-auth");
      const sessionToken = createWorkerSessionToken(workerId, capabilities);
      return NextResponse.json({ ok: true, worker, sessionToken });
    }

    // Phase 18Q: NEW registration — require enrollment proof.
    if (!publicKeyPem || !enrollmentSecret || !enrollmentSignature) {
      return NextResponse.json({
        error: "REJECTED: New worker registration requires publicKeyPem, enrollmentSecret, and enrollmentSignature. Obtain an enrollment from an admin via /api/admin/enroll-worker.",
      }, { status: 403 });
    }

    // Look up the pending enrollment.
    const enrollment = await db.workerEnrollment.findUnique({
      where: { workerId },
    });

    if (!enrollment) {
      return NextResponse.json({
        error: "REJECTED: No enrollment found for this workerId. An admin must pre-provision the worker via /api/admin/enroll-worker.",
      }, { status: 403 });
    }

    if (enrollment.status !== "PENDING") {
      return NextResponse.json({
        error: `REJECTED: Enrollment status is ${enrollment.status}, not PENDING. Enrollment is single-use.`,
      }, { status: 403 });
    }

    // Verify the enrollment secret (one-time use).
    const secretValid = bcrypt.compareSync(enrollmentSecret, enrollment.enrollmentSecretHash);
    if (!secretValid) {
      return NextResponse.json({
        error: "REJECTED: Invalid enrollment secret.",
      }, { status: 403 });
    }

    // Verify the public key matches the expected fingerprint.
    const fingerprint = createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 32);
    if (fingerprint !== enrollment.expectedPublicKeyFingerprint) {
      return NextResponse.json({
        error: "REJECTED: Public key fingerprint does not match the expected fingerprint from enrollment.",
      }, { status: 403 });
    }

    // Verify the Ed25519 enrollment signature.
    // The challenge is: "FORGE_ENROLLMENT:{workerId}:{enrollmentSecret}"
    const challenge = `FORGE_ENROLLMENT:${workerId}:${enrollmentSecret}`;
    const challengeData = Buffer.from(challenge, "utf-8");
    const sigBuf = Buffer.from(enrollmentSignature, "hex");

    let sigValid = false;
    try {
      sigValid = cryptoVerify(null, challengeData, publicKeyPem, sigBuf);
    } catch {
      sigValid = false;
    }

    if (!sigValid) {
      return NextResponse.json({
        error: "REJECTED: Enrollment signature verification FAILED. The worker must sign 'FORGE_ENROLLMENT:{workerId}:{enrollmentSecret}' with its Ed25519 private key.",
      }, { status: 403 });
    }

    // All checks passed — activate the worker.
    const worker = await db.workerRegistry.upsert({
      where: { workerId },
      create: {
        workerId,
        workerVersion: body.workerVersion,
        protocolVersion: body.protocolVersion,
        capabilities: JSON.stringify(capabilities),
        maxConcurrency: body.maxConcurrency || 1,
        status: "READY",
        lastHeartbeat: new Date(),
        publicKeyPem,
      },
      update: {
        workerVersion: body.workerVersion,
        protocolVersion: body.protocolVersion,
        capabilities: JSON.stringify(capabilities),
        maxConcurrency: body.maxConcurrency || 1,
        status: "READY",
        lastHeartbeat: new Date(),
        publicKeyPem, // Set the key (this is a new registration from enrollment).
      },
    });

    // Mark enrollment as ACTIVE (single-use).
    await db.workerEnrollment.update({
      where: { workerId },
      data: {
        status: "ACTIVE",
        activatedAt: new Date(),
      },
    });

    // Issue a session token (signed with control-plane Ed25519).
    const { createWorkerSessionToken } = await import("@/lib/worker-auth");
    const sessionToken = createWorkerSessionToken(workerId, capabilities);

    return NextResponse.json({ ok: true, worker, sessionToken });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
