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
import {
  verifySubstrateAttestation,
  isSubstrateVerified,
  verifyLauncherAttestation,
  isSubstrateTrusted,
  type SubstrateVerificationResult,
} from "@/lib/substrate-attestation";
import {
  verifyArtifactManifest,
  type ManifestVerificationResult,
} from "@/lib/artifact-manifest";

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
      select: { id: true, projectId: true, workerId: true, leaseId: true, leaseExpiresAt: true, substrateNonce: true, substrateCapability: true },
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

    // Phase 18V: Verify the substrate attestation FACTS. This replaces the
    // Phase 18F placeholder (hardcoded `executionEnvironmentSandboxed: false`).
    // The attestation is OBSERVED substrate facts (kernel namespace inodes,
    // seccomp BPF mode, rlimits, cap-drop), bound into the signed envelope
    // (Phase 18V-A added `substrateAttestation` to the envelope hash, which
    // is what Ed25519 signs). No attestation => fail-closed.
    //
    // The evidence is ACCEPTED even when the attestation is null/invalid —
    // the worker still produced RUNTIME_VERIFIED evidence. But PRODUCTION_READY
    // is BLOCKED (fail-closed) when the attestation is missing or invalid.
    //
    // Phase 18W: This block now produces TWO verdicts:
    //   - substrateFactsVerified  (Phase 18V: facts-only, diagnostic)
    //   - substrateTrusted         (Phase 18W: facts AND launcher signature,
    //                                the production gate)
    // The launcher signature is verified BELOW, AFTER the envelope identity
    // check (we need token.executionId to bind against the attestation).
    const substrateVerification = verifySubstrateAttestation(
      envelope.substrateAttestation ?? null
    );
    // Sanity check: the detailed verifier and the boolean shortcut must agree.
    // (Defense-in-depth: catches a future refactor that breaks one but not
    // the other. The two functions share the same underlying logic, so they
    // must return the same verdict.)
    const substrateVerifiedShortcut = isSubstrateVerified(
      envelope.substrateAttestation ?? null
    );
    if (substrateVerification.valid !== substrateVerifiedShortcut) {
      // Should never happen — but if it does, fail-closed (treat as unverified).
      await ensureBuildEvent({
        projectId,
        type: BuildEventType.HUMAN_REVIEW_REQUIRED,
        level: "error",
        message: `Substrate verifier disagreement — verifySubstrateAttestation.valid=${substrateVerification.valid} vs isSubstrateVerified=${substrateVerifiedShortcut}. FAIL-CLOSED: treating as unverified.`,
        payload: JSON.stringify({
          eventType: "SUBSTRATE_VERIFIER_DISAGREEMENT",
          detailed: substrateVerification,
          shortcut: substrateVerifiedShortcut,
        }),
      });
    }
    // Canonical verdict: fail-closed when the two verifiers disagree OR when
    // the detailed verifier reports invalid. We use a separate const so the
    // rest of the route can rely on a single source of truth.
    const substrateFactsVerified =
      substrateVerification.valid &&
      substrateVerifiedShortcut &&
      substrateVerification.valid === substrateVerifiedShortcut;

    // Phase 18G: Verify envelope identity matches the token identity.
    if (envelope.executionId !== token.executionId || envelope.workerId !== token.workerId) {
      return NextResponse.json({
        error: "REJECTED: Envelope identity mismatch. envelope.executionId/workerId must match the authenticated token.",
      }, { status: 403 });
    }

    // =========================================================================
    // Phase 18W: TWO-SIGNATURE TRUST MODEL — LAUNCHER ATTESTATION VERIFICATION.
    // =========================================================================
    // The worker signs the envelope (verified above with the server-resolved
    // worker key). The LAUNCHER signs the substrate attestation (observed
    // facts + nonce + executionId + workload results) with its OWN Ed25519
    // private key — separate from the worker key, provisioned by admin.
    //
    // This is the trust separation: a compromised worker key cannot forge the
    // launcher signature, so it cannot manufacture a valid substrate claim
    // without actually running the real launcher inside the real substrate.
    //
    // The control plane uses its OWN pinned launcher public key. It NEVER
    // trusts a launcher key from the request body (the worker could send any
    // key in the body — that would defeat the model).
    //
    // PINNED KEY SOURCES (in order of preference):
    //   1. FORGE_LAUNCHER_PUBLIC_KEY env var (PEM string). Primary.
    //   2. LauncherRegistry DB table (admin-enrolled, like WorkerRegistry).
    //      NOT yet implemented; tracked as a follow-up. When present, it will
    //      be the authoritative source (so admin can rotate keys without a
    //      redeploy).
    // If NEITHER source yields a key, ALL attestations are UNTRUSTED → ALL
    // production is blocked. This is the correct fail-closed behavior.
    //
    // The expectedNonce comes from the ExecutionJob.substrateNonce column
    // (issued by the control plane at job-spec time, persisted, returned to
    // the worker). If the job has no nonce, we cannot verify anti-replay →
    // fail-closed: accept the evidence (RUNTIME_VERIFIED) but block production.
    //
    // The expectedExecutionId comes from the AUTHENTICATED token (NOT from
    // the envelope body — envelope identity was already checked above, so
    // token.executionId === envelope.executionId by this point, but we use
    // the token as the authoritative source).

    const launcherPublicKeyPem = process.env.FORGE_LAUNCHER_PUBLIC_KEY ?? "";
    const expectedNonce = executionJob.substrateNonce ?? "";
    const expectedExecutionId = token.executionId;

    // Defensive: 18W-B guarantees the envelope always carries a non-null
    // attestation. If it's null here, the worker is buggy or malicious — log
    // NO_SUBSTRATE_ATTESTATION and fail-closed on production.
    if (!envelope.substrateAttestation) {
      await ensureBuildEvent({
        projectId,
        type: BuildEventType.TASK_FAILED,
        level: "error",
        message: `NO_SUBSTRATE_ATTESTATION — envelope.substrateAttestation is null after Phase 18W-B. PRODUCTION_READY blocked (fail-closed). Worker may be running an outdated runtime or attempting to bypass the substrate.`,
        payload: JSON.stringify({
          executionId: token.executionId,
          workerId: token.workerId,
          eventType: "NO_SUBSTRATE_ATTESTATION",
        }),
      });
    }

    // 1. Compute the launcher verification result (signature + nonce + execId
    //    binding). If the pinned key or expected nonce is missing, we cannot
    //    verify — fail-closed with a clear reason.
    let launcherVerification: SubstrateVerificationResult;
    if (!launcherPublicKeyPem || !expectedNonce) {
      launcherVerification = {
        valid: false,
        reasons: [
          `Launcher attestation UNVERIFIABLE — ${
            !launcherPublicKeyPem ? "FORGE_LAUNCHER_PUBLIC_KEY env var not set" : ""
          }${!launcherPublicKeyPem && !expectedNonce ? "; " : ""}${
            !expectedNonce ? "ExecutionJob.substrateNonce missing (control plane did not issue a nonce)" : ""
          }. PRODUCTION_READY blocked (fail-closed).`,
        ],
      };
    } else {
      launcherVerification = verifyLauncherAttestation(
        envelope.substrateAttestation ?? null,
        launcherPublicKeyPem,
        expectedNonce,
        expectedExecutionId
      );
    }

    // 2. The production predicate requires isSubstrateTrusted: facts valid
    //    AND launcher signature valid AND nonce/executionId bound. A null
    //    attestation is untrusted by definition.
    const substrateTrusted =
      !!envelope.substrateAttestation &&
      substrateFactsVerified &&
      launcherVerification.valid &&
      // Defense-in-depth: re-run the combined check so a future refactor
      // that breaks one of the two verifiers but not the other cannot
      // silently grant trust.
      (launcherPublicKeyPem && expectedNonce
        ? isSubstrateTrusted(
            envelope.substrateAttestation,
            launcherPublicKeyPem,
            expectedNonce,
            expectedExecutionId
          )
        : false);

    // =========================================================================
    // Phase 18X-B: Audit the stored ExecutionCapability (defense-in-depth).
    // =========================================================================
    //
    // The substrate supervisor verified the capability's signature BEFORE
    // running the substrate (Phase 18X-A). At submission time, the control
    // plane additionally audits that the capability the supervisor accepted
    // matches the values the control plane attests to NOW:
    //   - capability.executionId === token.executionId
    //   - capability.nonce === expectedNonce (=== ExecutionJob.substrateNonce)
    //   - capability.repositoryHeadSha === expectedSha (=== project.canonicalHeadSha)
    //
    // These are ALREADY verified independently above (envelope.executionId
    // check, expectedNonce derivation, result.repositoryHeadSha !== expectedSha
    // rejection). This audit is defense-in-depth — it catches a worker that
    // somehow presented a different capability to the supervisor than the one
    // the control plane issued for this execution. If the audit fails, we
    // emit a CAPABILITY_AUDIT_FAILED event and block PRODUCTION_READY (but
    // still accept the evidence as RUNTIME_VERIFIED — the supervisor's own
    // signature check already passed; this audit is about control-plane
    // bookkeeping, not substrate security).
    //
    // If the stored capability is missing (e.g., job-spec couldn't persist it
    // because the DB was unavailable — the sandbox path), we emit a warning
    // and continue. The supervisor-side check is the authoritative one.
    let capabilityAuditOk = true;
    const capabilityAuditReasons: string[] = [];
    let storedCapability: any = null;
    if (executionJob.substrateCapability) {
      try {
        storedCapability = JSON.parse(executionJob.substrateCapability);
        if (storedCapability.executionId !== token.executionId) {
          capabilityAuditOk = false;
          capabilityAuditReasons.push(
            `capability.executionId (${storedCapability.executionId}) !== token.executionId (${token.executionId})`
          );
        }
        if (storedCapability.nonce && expectedNonce && storedCapability.nonce !== expectedNonce) {
          capabilityAuditOk = false;
          capabilityAuditReasons.push(
            `capability.nonce (${storedCapability.nonce.slice(0, 8)}...) !== expectedNonce (${expectedNonce.slice(0, 8)}...)`
          );
        }
        if (
          storedCapability.repositoryHeadSha &&
          result.repositoryHeadSha &&
          storedCapability.repositoryHeadSha !== result.repositoryHeadSha
        ) {
          capabilityAuditOk = false;
          capabilityAuditReasons.push(
            `capability.repositoryHeadSha (${storedCapability.repositoryHeadSha.slice(0, 7)}) !== envelope.repositoryHeadSha (${result.repositoryHeadSha.slice(0, 7)})`
          );
        }
      } catch (err: any) {
        capabilityAuditOk = false;
        capabilityAuditReasons.push(
          `Failed to parse stored substrateCapability JSON: ${err?.message ?? String(err)}`
        );
      }
    } else {
      // No stored capability — emit a diagnostic event (non-blocking). The
      // supervisor-side check is authoritative; this just means the control
      // plane can't audit the binding after the fact.
      await ensureBuildEvent({
        projectId,
        type: BuildEventType.TASK_FAILED,
        level: "warning",
        message: `SUBSTRATE_CAPABILITY_NOT_STORED — ExecutionJob.substrateCapability is null for ${token.executionId}. The supervisor verified the capability at runtime, but the control plane cannot audit the binding (defense-in-depth gap). PRODUCTION_READY is NOT blocked by this alone.`,
        payload: JSON.stringify({
          executionId: token.executionId,
          workerId: token.workerId,
          eventType: "SUBSTRATE_CAPABILITY_NOT_STORED",
        }),
      });
    }
    if (!capabilityAuditOk) {
      await ensureBuildEvent({
        projectId,
        type: BuildEventType.TASK_FAILED,
        level: "error",
        message: `CAPABILITY_AUDIT_FAILED — the stored ExecutionCapability does not match the submission. Reasons: ${capabilityAuditReasons.join("; ")}. PRODUCTION_READY blocked (fail-closed).`,
        payload: JSON.stringify({
          executionId: token.executionId,
          workerId: token.workerId,
          eventType: "CAPABILITY_AUDIT_FAILED",
          reasons: capabilityAuditReasons,
        }),
      });
    }
    const capabilityAuditPassed = capabilityAuditOk;

    // 3. If the launcher verification failed (and the attestation was
    //    present), log the specific failure reasons. The evidence is still
    //    ACCEPTED as RUNTIME_VERIFIED — but PRODUCTION_READY is blocked.
    if (envelope.substrateAttestation && !launcherVerification.valid) {
      await ensureBuildEvent({
        projectId,
        type: BuildEventType.TASK_FAILED,
        level: "error",
        message: `SUBSTRATE_ATTESTATION_REJECTED — launcher verification failed: ${launcherVerification.reasons.join("; ")}`,
        payload: JSON.stringify({
          executionId: token.executionId,
          workerId: token.workerId,
          eventType: "SUBSTRATE_ATTESTATION_REJECTED",
          reasons: launcherVerification.reasons,
        }),
      });
    }

    // =========================================================================
    // Phase 18Z-A: ARTIFACT MANIFEST VERIFICATION.
    // =========================================================================
    //
    // The launcher (inside the substrate, with the SAME Ed25519 key that
    // signs the attestation) builds + signs the ArtifactManifest. The
    // manifest binds ALL execution artifacts (install.log, build.log,
    // runtime-stdout, runtime-stderr, health traces, the substrate
    // attestation itself, ...) via SHA-256 content hashes.
    //
    // The control plane verifies the manifest signature with the SAME pinned
    // launcher public key used for the attestation. A compromised worker
    // cannot forge the manifest signature (it doesn't have the launcher key).
    //
    // The manifest is ALSO bound into the envelope hash (Phase 18Z-A added
    // `artifactManifest` to computeResultHash + computeEnvelopeHash), so the
    // worker's Ed25519 signature covers it. The control plane verifies BOTH:
    //   - worker signature on the envelope (which covers the manifest)
    //   - launcher signature on the manifest hash
    //
    // Fail-closed: null/missing manifest → artifactManifestVerified = false
    // → PRODUCTION_READY blocked. Forge never trusts "build.log exists" — it
    // trusts `sha256(build.log) === <signed manifest hash>`.
    let manifestVerification: ManifestVerificationResult;
    if (!launcherPublicKeyPem) {
      // No pinned launcher key → can't verify the manifest. Fail-closed.
      manifestVerification = {
        valid: false,
        reasons: [
          "Artifact manifest UNVERIFIABLE — FORGE_LAUNCHER_PUBLIC_KEY env var not set. PRODUCTION_READY blocked (fail-closed).",
        ],
      };
    } else {
      manifestVerification = verifyArtifactManifest(
        envelope.artifactManifest ?? null,
        launcherPublicKeyPem,
        token.executionId
      );
    }
    const artifactManifestVerified = manifestVerification.valid;

    // If the manifest verification failed, emit a build event with the
    // specific failure reasons. The evidence is still ACCEPTED as
    // RUNTIME_VERIFIED — but PRODUCTION_READY is blocked.
    if (!artifactManifestVerified) {
      await ensureBuildEvent({
        projectId,
        type: BuildEventType.TASK_FAILED,
        level: "error",
        message: `ARTIFACT_MANIFEST_REJECTED — launcher manifest verification failed: ${manifestVerification.reasons.join("; ")}`,
        payload: JSON.stringify({
          executionId: token.executionId,
          workerId: token.workerId,
          eventType: "ARTIFACT_MANIFEST_REJECTED",
          reasons: manifestVerification.reasons,
          manifestPresent: envelope.artifactManifest !== null,
          manifestEntries: envelope.artifactManifest?.entries?.length ?? 0,
        }),
      });
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
        // Phase 18V/18W: Substrate attestation — observed isolation facts
        // bound into the signed envelope. Persisted as JSON so reviewers can
        // inspect the exact namespace inodes, seccomp profile hash, rlimits,
        // cap-drop, AND the launcher signature over canonicalFactsJson.
        //
        // `substrateVerified` records whether the attestation is FULLY TRUSTED
        // at submission time: facts valid (verifySubstrateAttestation) AND
        // launcher signature valid (verifyLauncherAttestation) AND nonce /
        // executionId bound to the authenticated token. Phase 18W changed the
        // semantic from facts-only (18V) to fully-trusted (18W) — this is the
        // production gate, and a trusted attestation requires BOTH the facts
        // AND the launcher signature.
        substrateAttestation: envelope.substrateAttestation
          ? JSON.stringify(envelope.substrateAttestation)
          : null,
        substrateVerified: substrateTrusted,
        // Phase 18W-B: Persist the substrate nonce the control plane issued
        // for this execution. The attestation's canonicalFactsJson includes
        // this nonce (signed by the launcher), so persisting it here lets a
        // reviewer / auditor verify the binding without re-reading the
        // ExecutionJob row (which may have been GC'd or mutated).
        substrateNonce: expectedNonce || null,
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
        // Phase 18V/18W: Substrate attestation status in the event payload.
        // `substrateFactsVerified` is the facts-only verdict (Phase 18V);
        // `substrateTrusted` is the production-gate verdict (Phase 18W: facts
        // AND launcher signature AND binding). `launcherVerification` exposes
        // the detailed launcher signature / nonce / executionId check.
        substrateFactsVerified,
        substrateTrusted,
        launcherVerified: launcherVerification.valid,
        substrateAttestationPresent: envelope.substrateAttestation !== null,
        substrateVerificationReasons: substrateVerification.reasons,
        launcherVerificationReasons: launcherVerification.reasons,
      }),
    });

    // Phase 18V/18W: If the runtime passed but the substrate attestation is
    // NOT TRUSTED (either facts invalid OR launcher signature invalid OR not
    // bound to this execution), emit a build event warning that
    // PRODUCTION_READY is blocked (fail-closed). The evidence is still
    // accepted as RUNTIME_VERIFIED — but production deployment requires a
    // TRUSTED isolation boundary (Phase 18W: facts + launcher signature).
    if (runtimeEventPassed && !substrateTrusted) {
      const factsReasons = substrateVerification.reasons.join("; ");
      const launcherReasons = launcherVerification.reasons.join("; ");
      await ensureBuildEvent({
        projectId,
        type: BuildEventType.HUMAN_REVIEW_REQUIRED,
        level: "warn",
        message: `RUNTIME_VERIFIED but NO TRUSTED substrate attestation — PRODUCTION_READY blocked (fail-closed). Facts: ${factsReasons}. Launcher: ${launcherReasons}`,
        payload: JSON.stringify({
          runtimeEvidenceId: evidence.id,
          repositoryHeadSha: result.repositoryHeadSha,
          eventType: "RUNTIME_VERIFIED_NO_TRUSTED_SUBSTRATE",
          substrateFactsVerified,
          substrateTrusted: false,
          launcherVerified: launcherVerification.valid,
          substrateAttestationPresent: envelope.substrateAttestation !== null,
          substrateVerificationReasons: substrateVerification.reasons,
          launcherVerificationReasons: launcherVerification.reasons,
          productionReadyEligible: false,
        }),
      });
    }

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
        // Phase 18W: executionEnvironmentSandboxed now requires isSubstrateTrusted
        // — facts verified (verifySubstrateAttestation) AND launcher signature
        // verified (verifyLauncherAttestation) AND nonce/executionId bound to
        // the authenticated token. This replaces the 18V facts-only check (which
        // a compromised worker could satisfy by constructing a structurally
        // valid SandboxAttestation without actually running the launcher).
        //
        // A compromised worker key alone cannot forge the launcher signature
        // (the launcher key is provisioned by admin and never shipped to the
        // worker as a public-key target the worker can substitute). Production
        // is blocked unless the attestation is FULLY trusted.
        executionEnvironmentSandboxed: substrateTrusted,
        substrateAttestationVerified: substrateTrusted,
        // Phase 18Z-A: the artifact manifest must be verified (launcher
        // signature valid + manifestHash matches content + required artifact
        // types present + executionId bound). Fail-closed: null/missing
        // manifest → false → PRODUCTION_READY blocked.
        artifactManifestVerified,
        repositoryHeadVerified: headVerified,
      };

      productionReady = canReachProductionReadyWithRuntime(prodEvidence);

      // Phase 18X-B: The capability audit is defense-in-depth. If it failed,
      // block PRODUCTION_READY even if the rest of the predicate passes.
      // The supervisor-side capability check is authoritative for substrate
      // security; this audit is control-plane bookkeeping — but a mismatch
      // means something is wrong (worker presented a different capability
      // than the one issued for this execution), so we fail-closed.
      if (productionReady && !capabilityAuditPassed) {
        productionReady = false;
        await ensureBuildEvent({
          projectId,
          type: BuildEventType.HUMAN_REVIEW_REQUIRED,
          level: "warn",
          message: `RUNTIME_VERIFIED but NOT PRODUCTION_READY — capability audit failed: ${capabilityAuditReasons.join("; ")}`,
          payload: JSON.stringify({
            repositoryHeadSha: result.repositoryHeadSha,
            eventType: "RUNTIME_VERIFIED_NOT_PRODUCTION_READY",
            productionReadyEligible: false,
            failureReason: `capability audit failed: ${capabilityAuditReasons.join("; ")}`,
            evidence: prodEvidence,
          }),
        });
      }

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
      // Phase 18V/18W: Surface BOTH verdicts so the worker (and reviewers)
      // can see exactly why PRODUCTION_READY was blocked when it is.
      //   - substrateFactsVerified: Phase 18V facts-only verdict (diagnostic).
      //   - substrateTrusted: Phase 18W production-gate verdict (facts +
      //     launcher signature + nonce/execId binding).
      //   - launcherVerified: whether the launcher Ed25519 signature over
      //     canonicalFactsJson verified against the pinned launcher public key.
      // The reasons arrays let reviewers see the exact field-level failure
      // (which inode was a host sentinel, which nonce mismatched, etc.).
      substrateFactsVerified,
      substrateTrusted,
      launcherVerified: launcherVerification.valid,
      substrateAttestationPresent: envelope.substrateAttestation !== null,
      substrateVerificationReasons: substrateVerification.reasons,
      launcherVerificationReasons: launcherVerification.reasons,
      // Phase 18X-B: capability audit (defense-in-depth — see comment above).
      capabilityAuditPassed,
      capabilityAuditReasons,
      // Phase 18Z-A: artifact manifest verification. The manifest binds all
      // execution artifacts via SHA-256 + launcher signature. Fail-closed:
      // null/missing manifest → artifactManifestVerified = false →
      // PRODUCTION_READY blocked.
      artifactManifestVerified,
      artifactManifestPresent: envelope.artifactManifest !== null,
      artifactManifestEntries: envelope.artifactManifest?.entries?.length ?? 0,
      artifactManifestReasons: manifestVerification.reasons,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to submit runtime evidence" }, { status: 500 });
  }
}
