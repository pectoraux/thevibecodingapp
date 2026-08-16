import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { decryptSecretOrNull } from "@/lib/crypto";

// POST /api/worker/resolve-credential
//
// Phase 10: BYOK credential resolution.
// Phase 18K: Lease-fenced + project-scoped.
//
// The worker must be authenticated with a CURRENT execution token (lease not expired).
// The provider must belong to the SAME project as the execution job.
// The credential is NEVER sent to the LLM or browser — only to the authenticated worker.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req, "EXECUTION");
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    if (!token.executionId) {
      return NextResponse.json({ error: "Execution token required" }, { status: 403 });
    }

    // Phase 18K: Lease-fenced — verify the execution job has a current lease.
    if (!token.leaseId) {
      return NextResponse.json({ error: "Lease ID required" }, { status: 403 });
    }

    const job = await db.executionJob.findUnique({
      where: { executionId: token.executionId },
      select: { id: true, workerId: true, leaseId: true, leaseExpiresAt: true, projectId: true },
    });

    if (!job) {
      return NextResponse.json({ error: "Execution job not found" }, { status: 404 });
    }

    if (job.workerId !== token.workerId) {
      return NextResponse.json({ error: "Job not claimed by this worker" }, { status: 403 });
    }

    if (job.leaseId !== token.leaseId) {
      return NextResponse.json({ error: "Lease mismatch — job may have been reclaimed" }, { status: 403 });
    }

    if (job.leaseExpiresAt && job.leaseExpiresAt < new Date()) {
      return NextResponse.json({ error: "Lease expired" }, { status: 403 });
    }

    const { providerId } = await req.json();

    if (!providerId) {
      return NextResponse.json({ error: "providerId required" }, { status: 400 });
    }

    // Look up the provider.
    const provider = await db.llmProvider.findUnique({ where: { id: providerId } });
    if (!provider) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    }

    // Phase 18K: Project-scoped — the provider must belong to the SAME user as the execution project.
    // The provider's userId must match the project's userId.
    const project = await db.project.findUnique({
      where: { id: job.projectId },
      select: { userId: true },
    });

    if (!project || provider.userId !== project.userId) {
      return NextResponse.json({
        error: "REJECTED: Provider does not belong to the execution's project owner. Credential access is scoped to the current execution.",
      }, { status: 403 });
    }

    // Decrypt the API key.
    const apiKey = decryptSecretOrNull(provider.apiKey);
    if (!apiKey) {
      return NextResponse.json({ error: "Credential could not be decrypted" }, { status: 500 });
    }

    // Return the decrypted key to the authenticated worker.
    return NextResponse.json({
      apiKey,
      provider: provider.provider,
      model: provider.model,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
