import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// POST /api/worker/register
//
// Phase 7: Worker registers with the control plane on startup.
// The worker provides its capabilities and version info.
// The control plane stores this in WorkerRegistry for scheduling.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { workerId, workerVersion, protocolVersion, capabilities, maxConcurrency } = body;

    if (!workerId || !workerVersion || !protocolVersion) {
      return NextResponse.json({ error: "workerId, workerVersion, protocolVersion required" }, { status: 400 });
    }

    // Check protocol version compatibility.
    if (protocolVersion !== "v1") {
      return NextResponse.json({ error: `Unsupported protocol version: ${protocolVersion}` }, { status: 400 });
    }

    const worker = await db.workerRegistry.upsert({
      where: { workerId },
      create: {
        workerId,
        workerVersion,
        protocolVersion,
        capabilities: JSON.stringify(capabilities || ["node", "git", "test", "build"]),
        maxConcurrency: maxConcurrency || 1,
        status: "READY",
        lastHeartbeat: new Date(),
      },
      update: {
        workerVersion,
        protocolVersion,
        capabilities: JSON.stringify(capabilities || ["node", "git", "test", "build"]),
        maxConcurrency: maxConcurrency || 1,
        status: "READY",
        lastHeartbeat: new Date(),
      },
    });

    return NextResponse.json({ ok: true, worker });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
