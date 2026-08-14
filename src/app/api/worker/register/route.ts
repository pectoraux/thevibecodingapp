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
    const token = getWorkerToken(req);
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
      },
      update: {
        workerVersion: body.workerVersion,
        protocolVersion: body.protocolVersion,
        capabilities: JSON.stringify(capabilities),
        maxConcurrency: body.maxConcurrency || 1,
        status: "READY",
        lastHeartbeat: new Date(),
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
