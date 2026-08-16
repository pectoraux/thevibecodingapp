import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType } from "@/lib/types";
import {
  evaluateRuntimeVerificationResult,
  hashRuntimePlan,
  deriveRuntimeVerificationPlan,
  canReachProductionReadyWithRuntime,
  getProductionReadinessFailureReason,
  type RuntimeVerificationResult,
  type ProductionReadinessEvidence,
} from "@/lib/runtime-verification";
import {
  verifyEvidenceEnvelope,
  type ExecutionEvidenceEnvelope,
} from "@/lib/runtime-execution-contract";

// POST /api/worker/submit-runtime-evidence
//
// Phase 18A: Hardened runtime evidence submission.
//
// SECURITY MODEL (Phase 18A):
//   1. SERVER-AUTHORITATIVE SHA — the control plane derives expectedSha from
//      project.canonicalHeadSha and independently verifies it against GitHub.
//      The worker may NOT choose the revision being certified.
//      result.repositoryHeadSha MUST match project.canonicalHeadSha.
//   2. NO PRODUCTION_READY FROM RUNTIME ALONE — runtime verification produces
//      RUNTIME_VERIFIED only. PRODUCTION_READY is emitted ONLY by the complete
//      canonical predicate (static + runtime + environment).
//   3. PLAN-AWARE EVALUATION — the evaluator receives the plan, not just the
//      result. Required vs optional checks are enforced.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req, "EXECUTION");
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

    // Phase 18A: SERVER-AUTHORITATIVE SHA.
    // Load the project to get canonicalHeadSha — the expected SHA.
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        canonicalHeadSha: true,
        githubRepo: true,
        githubConnected: true,
        githubDefaultBranch: true,
      },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await req.json();

    // Phase 18G: The SIGNED ENVELOPE is the ONLY evidence object.
    // No unsigned body.result. No body.workerPublicKey.
    // The envelope is signed, verified, evaluated, and persisted — ONE object.
    const envelope = body.envelope as ExecutionEvidenceEnvelope | undefined;

    if (!envelope || !envelope.signature) {
      return NextResponse.json({
        error: "REJECTED: Missing signed evidence envelope. Phase 18G requires Ed25519-signed ExecutionEvidenceEnvelope as the sole evidence object.",
      }, { status: 403 });
    }

    // Phase 18G: Resolve the worker's public key from the WorkerRegistry.
    // NEVER from the request body. The body.workerPublicKey is IGNORED.
    const workerReg = await db.workerRegistry.findUnique({
      where: { workerId: token.workerId },
      select: { publicKeyPem: true },
    });

    if (!workerReg || !workerReg.publicKeyPem) {
      return NextResponse.json({
        error: `REJECTED: Worker ${token.workerId} has no registered Ed25519 public key. The worker must register its public key at /api/worker/register before submitting runtime evidence.`,
      }, { status: 403 });
    }

    // Phase 18G: Verify the envelope signature with the SERVER-RESOLVED key.
    const signatureValid = verifyEvidenceEnvelope(envelope, workerReg.publicKeyPem);
    if (!signatureValid) {
      return NextResponse.json({
        error: "REJECTED: Evidence envelope signature verification FAILED against the worker's registered public key.",
      }, { status: 403 });
    }

    // Phase 18G: Verify envelope identity matches the token identity.
    if (envelope.executionId !== token.executionId || envelope.workerId !== token.workerId) {
      return NextResponse.json({
        error: "REJECTED: Envelope identity mismatch. envelope.executionId/workerId must match the authenticated token.",
      }, { status: 403 });
    }

    // Phase 18G: DERIVE the RuntimeVerificationResult from the signed envelope.
    // There is no separate unsigned result. The envelope IS the evidence.
    const result: RuntimeVerificationResult = {
      repositoryHeadSha: envelope.repositoryHeadSha,
      headVerified: true, // Verified independently below.
      environmentFingerprint: envelope.environmentFingerprint as any,
      dependencyInstallResult: envelope.dependencyInstallResult as any,
      buildResult: envelope.buildResult as any,
      startupResult: envelope.startupResult as any,
      healthChecks: envelope.healthChecks as any,
      apiJourneys: envelope.apiJourneys as any,
      integrationChecks: envelope.integrationChecks as any,
      backgroundJobChecks: envelope.backgroundJobChecks as any,
      browserJourneys: envelope.browserJourneys as any,
      teardownResult: envelope.teardownResult as any,
      passed: envelope.passed,
      failureReason: envelope.failureReason,
      startedAt: envelope.startedAt,
      completedAt: envelope.completedAt,
      logs: envelope.logs || "", // Phase 18G: logs come from the signed envelope.
    };

    // Phase 18A: Verify the worker's SHA matches the server's expected SHA.
    const expectedSha = project.canonicalHeadSha;
    if (!expectedSha) {
      return NextResponse.json({
        error: "REJECTED: project has no canonicalHeadSha — cannot accept runtime evidence for an unverified revision",
      }, { status: 403 });
    }

    if (result.repositoryHeadSha !== expectedSha) {
      return NextResponse.json({
        error: `REJECTED: SHA mismatch. Worker reported ${result.repositoryHeadSha.slice(0, 7)}, but project canonicalHeadSha is ${expectedSha.slice(0, 7)}. The control plane is authoritative for repository identity.`,
      }, { status: 403 });
    }

    // Phase 18A: Independently verify GitHub freshness (headVerified must be true
    // AND the control plane confirms the SHA is the current branch HEAD).
    let headVerified = false;
    let integrationBranch = project.githubDefaultBranch || "main";

    if (project.githubConnected && project.githubRepo) {
      const githubPat = process.env.GITHUB_PAT;
      if (githubPat) {
        const [owner, repo] = project.githubRepo.split("/");
        try {
          const branchRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(integrationBranch)}`,
            {
              headers: {
                Authorization: `token ${githubPat}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "Forge-Control-Plane",
              },
              signal: AbortSignal.timeout(10000),
            }
          );
          if (branchRes.ok) {
            const branchData = await branchRes.json();
            const actualHead = branchData.commit?.sha;
            headVerified = actualHead === expectedSha;
          }
        } catch {
          headVerified = false;
        }
      }
    }

    if (!headVerified) {
      return NextResponse.json({
        error: `REJECTED: Canonical HEAD not verified. expectedSha ${expectedSha.slice(0, 7)} is not the current GitHub branch HEAD for ${integrationBranch}. The control plane must independently confirm repository identity.`,
      }, { status: 403 });
    }

    // Phase 18A: Derive the runtime plan from the architecture (NO DEFAULTS).
    const architecture = await db.architecture.findUnique({
      where: { projectId },
      select: {
        contractJson: true,
        apiContracts: true,
        integrations: true,
        testingStrategy: true,
        deploymentModel: true,
        hash: true,
        frozen: true,
      },
    });

    const plan = deriveRuntimeVerificationPlan(
      {
        canonicalHeadSha: project.canonicalHeadSha,
        githubRepo: project.githubRepo,
        githubDefaultBranch: project.githubDefaultBranch,
      },
      architecture
    );

    if (!plan) {
      return NextResponse.json({
        error: "REJECTED: No valid runtime verification plan. The architecture contract must declare deployment + runtime verification details. No defaults are used.",
      }, { status: 403 });
    }

    // Phase 18A: Plan-aware evaluation (required vs optional enforced).
    const evaluation = evaluateRuntimeVerificationResult(result, plan);

    const runtimePlanHash = hashRuntimePlan(plan);

    // Phase 18B: Idempotency — check if evidence already exists for this attempt.
    // projectId + executionId + attempt uniquely identifies a runtime verification submission.
    const attempt = body.attempt ?? 0;
    const idempotencyKey = `${projectId}+${token.executionId}+${attempt}`;
    const existingEvidence = await db.runtimeEvidence.findUnique({
      where: { idempotencyKey },
    });
    if (existingEvidence) {
      // Idempotent response — return the existing evidence.
      return NextResponse.json({
        ok: true,
        runtimeEvidenceId: existingEvidence.id,
        passed: existingEvidence.passed,
        failureReason: existingEvidence.failureReason,
        idempotent: true,
        message: "Runtime evidence already submitted for this attempt",
      });
    }

    // Persist a NEW RuntimeEvidence record (append-only — never UPDATE).
    const evidence = await db.runtimeEvidence.create({
      data: {
        projectId,
        repositoryHeadSha: result.repositoryHeadSha,
        headVerified,
        // Phase 18A: Server-authoritative SHA binding.
        expectedRepositoryHeadSha: expectedSha,
        executedRepositoryHeadSha: result.repositoryHeadSha,
        integrationBranch,
        runtimePlanHash,
        architectureHash: architecture?.hash ?? null,
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
        // Phase 18B: Idempotency fields.
        attempt,
        idempotencyKey,
        startedAt: new Date(result.startedAt),
        completedAt: new Date(result.completedAt),
      },
    });

    // Phase 18B: Emit RUNTIME_VERIFIED or RUNTIME_VERIFICATION_FAILED.
    // NEVER emit PRODUCTION_READY here — that comes ONLY from the canonical predicate below.
    const runtimeEventPassed = evaluation.passed;
    await ensureBuildEvent({
      projectId,
      type: runtimeEventPassed ? BuildEventType.TASK_COMPLETED : BuildEventType.TASK_FAILED,
      level: runtimeEventPassed ? "success" : "error",
      message: runtimeEventPassed
        ? `RUNTIME_VERIFIED at SHA ${result.repositoryHeadSha.slice(0, 7)} — evidence ${evidence.id}`
        : `RUNTIME_VERIFICATION_FAILED at SHA ${result.repositoryHeadSha.slice(0, 7)} — ${evaluation.failureReason}`,
      payload: JSON.stringify({
        runtimeEvidenceId: evidence.id,
        repositoryHeadSha: result.repositoryHeadSha,
        expectedSha,
        headVerified,
        runtimePlanHash,
        architectureHash: architecture?.hash ?? null,
        passed: evaluation.passed,
        failureReason: evaluation.failureReason,
        breakdown: evaluation.breakdown,
        // Phase 18B: Explicit event type — RUNTIME_VERIFIED, NOT PRODUCTION_READY.
        eventType: runtimeEventPassed ? "RUNTIME_VERIFIED" : "RUNTIME_VERIFICATION_FAILED",
        productionReadyEligible: false,
      }),
    });

    // Phase 18A: Evaluate the COMPLETE canonical production predicate.
    // Only if ALL conditions pass do we emit PRODUCTION_READY.
    let productionReady = false;
    if (evaluation.passed) {
      // Gather all the evidence for the complete predicate.
      const [tasks, readinessChecks, architectureFrozen] = await Promise.all([
        db.task.findMany({ where: { projectId }, select: { status: true, integrationState: true } }),
        db.readinessCheck.findMany({ where: { projectId }, select: { status: true, required: true } }),
        architecture?.frozen ?? false,
      ]);

      const allTasksCompleted = tasks.length > 0 && tasks.every((t) => t.status === "COMPLETED");
      const allTasksIntegrated = tasks.every((t) => t.integrationState === "INTEGRATED");
      const staticReadinessPassed = readinessChecks.length > 0 && readinessChecks.every((r) => !r.required || r.status === "PASSED");

      const prodEvidence: ProductionReadinessEvidence = {
        architectureFrozen,
        allTasksCompleted,
        allTasksIntegrated,
        staticReadinessPassed,
        runtimeVerificationPassed: evaluation.passed,
        runtimeEvidencePersisted: true, // just persisted
        // Phase 18F: Do NOT trust FORGE_EXECUTION_MODE config label.
        // The production predicate requires a VERIFIED execution substrate,
        // not a configuration string. In filesystem-only mode, this is false.
        // Container mode would provide substrate attestation (future phase).
        // Config says "sandbox" ≠ system is sandboxed.
        executionEnvironmentSandboxed: false, // FAIL-CLOSED: no verified substrate attestation exists yet.
        repositoryHeadVerified: headVerified,
      };

      productionReady = canReachProductionReadyWithRuntime(prodEvidence);

      if (productionReady) {
        // Phase 18A: ONLY emit PRODUCTION_READY when the complete predicate passes.
        await db.project.update({
          where: { id: projectId },
          data: { status: "PRODUCTION_READY" },
        });
        await ensureBuildEvent({
          projectId,
          type: BuildEventType.PRODUCTION_READY,
          level: "success",
          message: `PRODUCTION_READY — complete canonical predicate passed (static + runtime + environment) at SHA ${result.repositoryHeadSha.slice(0, 7)}`,
          payload: JSON.stringify({
            repositoryHeadSha: result.repositoryHeadSha,
            eventType: "PRODUCTION_READY",
            productionReadyEligible: true,
            evidence: prodEvidence,
          }),
        });
      } else {
        const failureReason = getProductionReadinessFailureReason(prodEvidence);
        await ensureBuildEvent({
          projectId,
          type: BuildEventType.HUMAN_REVIEW_REQUIRED,
          level: "warn",
          message: `RUNTIME_VERIFIED but NOT PRODUCTION_READY — ${failureReason}`,
          payload: JSON.stringify({
            repositoryHeadSha: result.repositoryHeadSha,
            eventType: "RUNTIME_VERIFIED_NOT_PRODUCTION_READY",
            productionReadyEligible: false,
            failureReason,
            evidence: prodEvidence,
          }),
        });
      }
    }

    return NextResponse.json({
      ok: true,
      runtimeEvidenceId: evidence.id,
      passed: evaluation.passed,
      failureReason: evaluation.failureReason,
      breakdown: evaluation.breakdown,
      runtimePlanHash,
      // Phase 18A: Explicitly report whether PRODUCTION_READY was achieved.
      productionReady,
      headVerified,
      expectedSha,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to submit runtime evidence" }, { status: 500 });
  }
}
