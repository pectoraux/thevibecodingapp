import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";

// POST /api/worker/register
//
// Phase 8: AUTHENTICATED — requires a valid registration token.
// The worker proves it knows FORGE_WORKER_SECRET by sending a signed token.
// The workerId is derived from the token (cryptographic identity), not the body.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req, "REGISTRATION");
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    // The workerId comes from the token, not the body.
    const body = await req.json();
    const workerId = token.workerId;

    if (!body.workerVersion || !body.protocolVersion) {
      return NextResponse.json({ error: "workerVersion, protocolVersion required" }, { status: 400 });
    }

    // Check protocol version compatibility.
    if (body.protocolVersion !== "v1") {
      return NextResponse.json({ error: `Unsupported protocol version: ${body.protocolVersion}` }, { status: 400 });
    }

    const capabilities = body.capabilities || token.capabilities || ["node", "git", "test", "build"];

    // Phase 18G: Worker registers its Ed25519 public key at registration time.
    // This key is used to verify evidence signatures. It is NEVER accepted
    // from the runtime-evidence submission body — only from the DB.
    //
    // Phase 18H: The public key is IMMUTABLE after initial registration.
    // A worker CANNOT overwrite its own key via re-registration. This prevents
    // a compromised worker credential from replacing the trust anchor.
    // Key rotation requires a separate authorized protocol (old key signature
    // or admin authorization) — see /api/worker/rotate-key.
    const publicKeyPem = body.publicKeyPem as string | undefined;

    // Check if worker already exists with a key.
    const existing = await db.workerRegistry.findUnique({
      where: { workerId },
      select: { publicKeyPem: true },
    });

    if (existing && existing.publicKeyPem && publicKeyPem) {
      // Worker exists AND has a key AND is trying to set a new one → REJECT.
      return NextResponse.json({
        error: "REJECTED: Worker already has a registered signing key. Key rotation requires /api/worker/rotate-key with authorization from the current key or an admin.",
      }, { status: 403 });
    }

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
        publicKeyPem: publicKeyPem || null, // Only set on first create.
      },
      update: {
        workerVersion: body.workerVersion,
        protocolVersion: body.protocolVersion,
        capabilities: JSON.stringify(capabilities),
        maxConcurrency: body.maxConcurrency || 1,
        status: "READY",
        lastHeartbeat: new Date(),
        // Phase 18H: publicKeyPem is NEVER updated here. Immutable after create.
      },
    });

    // Issue a session token for subsequent operations.
    const { createWorkerSessionToken } = await import("@/lib/worker-auth");
    const sessionToken = createWorkerSessionToken(workerId, capabilities);

    return NextResponse.json({ ok: true, worker, sessionToken });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
