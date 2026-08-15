import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType } from "@/lib/types";
import {
  evaluateRuntimeVerificationResult,
  type RuntimeVerificationResult,
} from "@/lib/runtime-verification";

// POST /api/worker/submit-runtime-evidence
//
// Phase 18: Authenticated endpoint for the worker to submit immutable runtime
// verification evidence. The control plane derives ALL identity from the
// execution token (like submit-evidence).
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req);
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    if (!token.executionId) {
      return NextResponse.json({ error: "Execution token required" }, { status: 403 });
    }

    const executionJob = await db.executionJob.findUnique({
      where: { executionId: token.executionId },
      select: { id: true, projectId: true, workerId: true, leaseId: true, leaseExpiresAt: true },
    });

    if (!executionJob) {
      return NextResponse.json({ error: "Execution job not found for token" }, { status: 403 });
    }

    if (executionJob.workerId !== token.workerId) {
      return NextResponse.json({ error: "Worker does not own this execution" }, { status: 403 });
    }

    if (executionJob.leaseId !== token.leaseId) {
      return NextResponse.json({ error: "Lease mismatch" }, { status: 403 });
    }

    if (executionJob.leaseExpiresAt && executionJob.leaseExpiresAt < new Date()) {
      return NextResponse.json({ error: "Lease expired" }, { status: 403 });
    }

    const projectId = executionJob.projectId;

    const body = await req.json();
    const result = body.result as RuntimeVerificationResult;

    if (!result || !result.repositoryHeadSha) {
      return NextResponse.json({ error: "Missing runtime verification result" }, { status: 400 });
    }

    // Evaluate the result (fail-closed — don't trust the worker's self-assessment).
    const evaluation = evaluateRuntimeVerificationResult(result);

    // Persist a NEW RuntimeEvidence record (append-only — never UPDATE).
    const evidence = await db.runtimeEvidence.create({
      data: {
        projectId,
        repositoryHeadSha: result.repositoryHeadSha,
        headVerified: result.headVerified,
        environmentFingerprint: JSON.stringify(result.environmentFingerprint),
        dependencyInstallResult: JSON.stringify(result.dependencyInstallResult),
        buildResult: JSON.stringify(result.buildResult),
        startupResult: JSON.stringify(result.startupResult),
        healthChecks: JSON.stringify(result.healthChecks),
        apiJourneys: JSON.stringify(result.apiJourneys),
        integrationChecks: JSON.stringify(result.integrationChecks),
        backgroundJobChecks: JSON.stringify(result.backgroundJobChecks),
        browserJourneys: JSON.stringify(result.browserJourneys),
        teardownResult: JSON.stringify(result.teardownResult),
        passed: evaluation.passed,
        failureReason: evaluation.failureReason,
        logs: result.logs?.slice(0, 50000) ?? null,
        executionId: token.executionId,
        workerId: token.workerId,
        startedAt: new Date(result.startedAt),
        completedAt: new Date(result.completedAt),
      },
    });

    await ensureBuildEvent({
      projectId,
      type: evaluation.passed ? BuildEventType.PRODUCTION_READY : BuildEventType.HUMAN_REVIEW_REQUIRED,
      level: evaluation.passed ? "success" : "error",
      message: evaluation.passed
        ? `Runtime verification PASSED at SHA ${result.repositoryHeadSha.slice(0, 7)} — evidence ${evidence.id}`
        : `Runtime verification FAILED at SHA ${result.repositoryHeadSha.slice(0, 7)} — ${evaluation.failureReason}`,
      payload: JSON.stringify({
        runtimeEvidenceId: evidence.id,
        repositoryHeadSha: result.repositoryHeadSha,
        passed: evaluation.passed,
        failureReason: evaluation.failureReason,
      }),
    });

    return NextResponse.json({
      ok: true,
      runtimeEvidenceId: evidence.id,
      passed: evaluation.passed,
      failureReason: evaluation.failureReason,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to submit runtime evidence" }, { status: 500 });
  }
}
