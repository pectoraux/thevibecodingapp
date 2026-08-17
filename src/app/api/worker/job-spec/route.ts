import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { getWorkerToken, getControlPlanePrivateKey } from "@/lib/worker-auth";
import {
  signExecutionCapability,
  deriveWorkloadFromPlan,
  computeWorkloadHash,
  type ExecutionCapability,
} from "@/lib/execution-capability";
import { deriveRuntimeVerificationPlan, hashRuntimePlan } from "@/lib/runtime-verification";

// POST /api/worker/job-spec
//
// Phase 8: AUTHENTICATED — requires a valid execution token.
//
// Returns the ExecutionSpec for a claimed job. The worker uses this to
// execute the task IN THE WORKER PROCESS (not in the control plane).
//
// The control plane provides:
// - task definition (title, description, acceptance criteria)
// - architecture contract (frozen, signed)
// - repository reference
// - model provider references (NOT plaintext secrets)
// - verification plan
//
// The worker uses this spec to:
// - create a sandbox
// - invoke the LLM
// - write code
// - run git
// - run tests
// - run Guardian
// - run reviewer
// - commit
// - return evidence
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req, "EXECUTION");
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    if (!token.executionId) {
      return NextResponse.json({ error: "Execution token required" }, { status: 403 });
    }

    // Get the execution job.
    const job = await db.executionJob.findUnique({
      where: { executionId: token.executionId },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // Verify the job is claimed by this worker.
    if (job.workerId !== token.workerId) {
      return NextResponse.json({ error: "Job not claimed by this worker" }, { status: 403 });
    }

    // Phase 18K: Lease-fenced — verify the lease is current and not expired.
    if (!token.leaseId || job.leaseId !== token.leaseId) {
      return NextResponse.json({ error: "Lease mismatch — job may have been reclaimed" }, { status: 403 });
    }
    if (job.leaseExpiresAt && job.leaseExpiresAt < new Date()) {
      return NextResponse.json({ error: "Lease expired" }, { status: 403 });
    }

    // Phase 18W-B: Issue a substrate nonce for this execution. The worker
    // passes the nonce to the launcher, which binds it into canonicalFactsJson
    // (the JSON the launcher signs with its Ed25519 key). At runtime evidence
    // submission time, the control plane verifies the attestation's nonce
    // matches this stored value (Phase 18W-C) — preventing replay of a
    // launcher-signed attestation from a different execution.
    //
    // The nonce is persisted on the ExecutionJob. If the job already has a
    // nonce (job-spec was called before), reuse it — the nonce is stable for
    // the execution's lifetime. If DB write fails (e.g., DB unavailable in
    // sandbox), generate one anyway and return it in the response — the
    // worker uses it directly. Phase 18W-C verification will fail if the
    // control plane can't track the nonce, but that's a control-plane concern.
    let substrateNonce = (job as any).substrateNonce as string | null | undefined;
    if (!substrateNonce) {
      substrateNonce = randomUUID();
      try {
        await db.executionJob.update({
          where: { executionId: token.executionId },
          data: { substrateNonce } as any,
        });
      } catch (err: any) {
        // DB write failed — log and continue. The nonce is returned in the
        // response so the worker can use it. Phase 18W-C verification will
        // require the control plane to track nonces (e.g., in-memory cache
        // when DB is unavailable).
        console.warn(
          `[job-spec] Failed to persist substrateNonce for ${token.executionId}: ${err.message}. Returning nonce in response only.`
        );
      }
    }

    // Get the task.
    const task = await db.task.findUnique({ where: { id: job.taskId! } });
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // Get the architecture contract.
    const architecture = await db.architecture.findUnique({
      where: { projectId: job.projectId },
    });

    // Get the project.
    const project = await db.project.findUnique({
      where: { id: job.projectId },
    });

    // =========================================================================
    // Phase 18X-B / 18Y: Issue a SIGNED ExecutionCapability.
    // =========================================================================
    //
    // The substrate supervisor (mini-services/substrate-supervisor, port 3004)
    // is a TRUSTED process that holds the launcher private key IN MEMORY (file
    // deleted at startup). It refuses to run a workload unless the worker
    // presents a control-plane-signed ExecutionCapability binding:
    //   - executionId      — the execution row this workload belongs to.
    //   - nonce            — the substrate launcher nonce (anti-replay).
    //   - leaseId          — the lease this execution runs under.
    //   - repositoryHeadSha — the exact git SHA the substrate MUST run.
    //   - runtimePlanHash  — the plan hash the substrate MUST use.
    //   - architectureHash — the architecture hash (may be null).
    //   - workloadHash     — Phase 18Y: SHA-256 of the canonical workload
    //                        recipe the supervisor must execute. The
    //                        supervisor computes this from the derived
    //                        workload and compares.
    //   - runtimePlan      — Phase 18Y: the FULL RuntimeVerificationPlan,
    //                        signed as part of the capability. The
    //                        supervisor DERIVES the workload from this (NOT
    //                        from the worker's request body). The worker
    //                        cannot change the install/build/start commands.
    //   - expiresAt        — ISO timestamp; capability invalid after this.
    //
    // The supervisor verifies the capability signature with
    // FORGE_CONTROL_PLANE_PUBLIC_KEY (Phase 18X-A). A worker cannot forge it
    // (no control-plane private key). A worker cannot override the nonce /
    // executionId / repoSha at the supervisor — those come from the capability.
    //
    // Phase 18Y — EXECUTION CAPABILITY CLOSURE (P0 fix):
    // Before 18Y, the supervisor accepted `workload` from the worker's POST
    // body. A compromised worker with a valid capability could execute
    // arbitrary commands. 18Y closes this: the capability signs the FULL
    // runtimePlan + workloadHash, and the supervisor DERIVES the workload
    // (binary="node", args=["/workspace/orchestrator.js"],
    // cwd="/workspace/repo") from the signed plan. The worker cannot change
    // the install/build/start commands — those come from the plan, which the
    // orchestrator reads from /workspace/plan.json (the supervisor writes it
    // from cap.runtimePlan).
    //
    // 18Y also adds atomic nonce consumption: the supervisor calls
    // /api/supervisor/consume-capability BEFORE running the substrate. The
    // control plane's updateMany with
    //   where: { executionId, substrateNonce: nonce,
    //            substrateNonceConsumed: false, leaseId,
    //            leaseExpiresAt: { gt: now } }
    //   data:  { substrateNonceConsumed: true, substrateNonceConsumedAt: now }
    // is atomic: the first call returns count=1 (consumed), any subsequent
    // call returns count=0 (replay → 403). The lease check is also in the
    // WHERE clause, so a reclaimed or expired lease → 403.
    //
    // The capability expiry is 5 minutes — long enough for the worker to
    // clone the repo and POST to the supervisor, short enough to bound the
    // replay window (the atomic nonce consumption is the primary anti-replay
    // mechanism; the 5-minute expiry is defense-in-depth).
    //
    // FAIL-CLOSED: if the control-plane private key is unavailable (e.g., the
    // process is in verification-only mode), we return a 503 — the worker
    // cannot safely run runtime verification without a valid capability, and
    // the supervisor will reject any unsigned / wrong-signed capability.
    const controlPlanePrivateKey = getControlPlanePrivateKey();
    if (!controlPlanePrivateKey) {
      return NextResponse.json({
        error: "Control-plane private key unavailable — cannot issue ExecutionCapability (FORGE_CONTROL_PLANE_PRIVATE_KEY not set). Runtime verification is blocked (fail-closed).",
      }, { status: 503 });
    }

    // Compute the runtimePlan + runtimePlanHash + workloadHash using the
    // SAME logic as submit-runtime-evidence (Phase 18A). The capability's
    // plan hash MUST match the control plane's authoritative value —
    // otherwise the worker would relay a capability the supervisor accepts
    // but the control plane later rejects (a confusing half-success).
    //
    // Phase 18Y: we ALSO sign the full runtimePlan + workloadHash. The
    // supervisor derives the workload from runtimePlan (NOT from the worker's
    // request body) and verifies workloadHash matches.
    const runtimePlan = (() => {
      if (!project) return null;
      return deriveRuntimeVerificationPlan(
        {
          canonicalHeadSha: project.canonicalHeadSha,
          githubRepo: project.githubRepo,
          githubDefaultBranch: project.githubDefaultBranch,
        },
        architecture
          ? {
              contractJson: architecture.contractJson,
              apiContracts: architecture.apiContracts,
              integrations: architecture.integrations,
              testingStrategy: architecture.testingStrategy,
              deploymentModel: architecture.deploymentModel,
              hash: architecture.hash,
              frozen: architecture.frozen,
            }
          : null
      );
    })();

    const runtimePlanHash = runtimePlan ? hashRuntimePlan(runtimePlan) : "";

    // Phase 18Y: derive the workload from the plan + compute its hash. The
    // supervisor will re-derive and re-compute, then compare to the value
    // signed into the capability. If they don't match → 403.
    //
    // If the plan is null (architecture missing required fields), we use an
    // empty plan object + a sentinel workloadHash. The supervisor will
    // reject it (deriveWorkloadFromPlan + computeWorkloadHash will produce
    // a different hash from the empty object), so a null plan blocks runtime
    // verification at the supervisor (defense-in-depth — the supervisor
    // would still verify the signature, but the workloadHash wouldn't match
    // a real workload).
    const runtimePlanForCapability: Record<string, unknown> = runtimePlan
      ? (runtimePlan as unknown as Record<string, unknown>)
      : {};
    const derivedWorkload = deriveWorkloadFromPlan(runtimePlanForCapability);
    const workloadHash = computeWorkloadHash(derivedWorkload);

    // Phase 18Z-PRE: the capability carries repositoryUrl — the supervisor
    // clones the repo itself (using a control-plane-resolved credential).
    // The worker does NOT supply a repoPath. The repositoryUrl is signed
    // into the capability, so a worker can't tamper with it without breaking
    // the signature.
    const repositoryUrl = project?.githubRepo
      ? `https://github.com/${project.githubRepo}.git`
      : "";

    const capabilityInput = {
      executionId: job.executionId,
      nonce: substrateNonce,
      leaseId: job.leaseId ?? "",
      // Phase 18Z.1: workerId is signed into the capability (NOT read from
      // the supervisor's request body). The supervisor binds this value into
      // the artifact manifest, and the control plane verifies the manifest's
      // workerId === token.workerId at submit-runtime-evidence time.
      workerId: token.workerId,
      repositoryHeadSha: project?.canonicalHeadSha ?? "",
      repositoryUrl, // Phase 18Z-PRE
      runtimePlanHash,
      architectureHash: architecture?.hash ?? null,
      workloadHash,
      runtimePlan: runtimePlanForCapability,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5-minute expiry
    };

    let capability: ExecutionCapability;
    try {
      capability = signExecutionCapability(capabilityInput, controlPlanePrivateKey);
    } catch (err: any) {
      return NextResponse.json({
        error: `Failed to sign ExecutionCapability: ${err?.message ?? String(err)}`,
      }, { status: 500 });
    }

    // Persist the signed capability on the ExecutionJob row so the control
    // plane can audit (at submit-runtime-evidence time) that the capability
    // used for THIS execution matches the one issued at job-spec time. The
    // nonce in the capability MUST match the attestation's nonce — this is
    // the audit-time check (defense-in-depth).
    try {
      await db.executionJob.update({
        where: { executionId: token.executionId },
        data: { substrateCapability: JSON.stringify(capability) } as any,
      });
    } catch (err: any) {
      // DB write failed (e.g., DB unavailable in sandbox). The capability is
      // returned in the response so the worker can use it. Phase 18X-B
      // audit at submit-runtime-evidence will fail if the control plane can't
      // fetch the stored capability — but the supervisor-side check still
      // protects the substrate.
      console.warn(
        `[job-spec] Failed to persist substrateCapability for ${token.executionId}: ${err.message}. Returning capability in response only.`
      );
    }

    // Build the ExecutionSpec — contains everything the worker needs to
    // execute the task, EXCEPT plaintext secrets.
    const spec = {
      executionId: job.executionId,
      projectId: job.projectId,
      taskId: job.taskId,
      attempt: job.attempt,

      // Task definition
      task: {
        code: task.code,
        title: task.title,
        description: task.description,
        agentType: task.agentType,
        acceptanceCriteria: JSON.parse(task.acceptanceCriteria || "[]"),
        requiredTests: JSON.parse(task.requiredTests || "[]"),
        dependencies: JSON.parse(task.dependencies || "[]"),
      },

      // Architecture contract (frozen)
      architecture: architecture ? {
        version: architecture.version,
        hash: architecture.hash,
        contractJson: architecture.contractJson,
        components: JSON.parse(architecture.components || "[]"),
        dataModels: JSON.parse(architecture.dataModels || "[]"),
        apiContracts: JSON.parse(architecture.apiContracts || "[]"),
        invariants: JSON.parse(architecture.invariants || "[]"),
        constraints: JSON.parse(architecture.constraints || "[]"),
      } : null,

      // Repository reference (worker uses scoped credential)
      repository: project?.githubConnected ? {
        githubRepo: project.githubRepo,
      } : null,

      // P10-2: BYOK model provider reference.
      // Resolve the project's configured BYOK provider for this task's agent type.
      // The worker resolves credentials via /api/worker/resolve-credential.
      // The control plane sends only the reference, never the plaintext key.
      modelProviderRef: await (async () => {
        // Look up the agent assignment for this task's agent type.
        const assignment = await db.agentAssignment.findFirst({
          where: { projectId: job.projectId, agentType: task.agentType },
          include: { provider: true },
        });

        if (assignment?.provider) {
          // Use the BYOK provider configured for this agent.
          return {
            provider: assignment.provider.provider,
            providerId: assignment.provider.id,
            model: assignment.provider.model,
          };
        }

        // No BYOK provider configured — use zai (sandbox LLM).
        // The worker will use the z-ai-web-dev-sdk as the default provider.
        return {
          provider: "zai",
          providerId: null,
          model: "glm-4.6",
        };
      })(),

      // P10-5: Architecture-driven VerificationPlan.
      // Extracted from the architecture contract if available.
      verificationPlan: (() => {
        if (architecture) {
          try {
            const contract = JSON.parse(architecture.contractJson || "{}");
            if (contract.verificationPlan) {
              return contract.verificationPlan;
            }
          } catch {}
        }
        // P11B: No default plan — return null. Worker will BLOCK if missing.
        return null;
      })(),

      // P15F: Base commit SHA from the CANONICAL PROJECT HEAD.
      // The canonicalHeadSha represents the integration branch HEAD —
      // it includes ALL merged dependency changes, not just one.
      // It advances only when a PR is merged (not on task completion).
      //
      // For the FIRST task (canonicalHeadSha is null): base = null (fresh repo).
      // For subsequent tasks: base = canonicalHeadSha (the integration HEAD).
      //
      // Dependencies are still checked (all must be COMPLETED), but the
      // BASE is the canonical HEAD, not a single dependency's commit.
      baseCommitSha: await (async () => {
        // P15F: Use canonicalHeadSha as the base.
        if (project?.canonicalHeadSha) {
          return project.canonicalHeadSha;
        }

        // For the first task (no canonical HEAD yet): no base.
        return null;
      })(),

      // Required capabilities
      requiredCapabilities: JSON.parse(job.requiredCapabilities || "[]"),

      // Phase 18W-B: Substrate nonce for launcher-signed attestation. The
      // worker passes this to the launcher; the control plane verifies it
      // matches at runtime evidence submission time (Phase 18W-C).
      substrateNonce,

      // Phase 18X-B: The SIGNED ExecutionCapability that authorizes the
      // substrate supervisor to run this workload. The worker relays this
      // to the supervisor (POST /execute { capability, workload, repoPath }).
      // The supervisor verifies the signature with
      // FORGE_CONTROL_PLANE_PUBLIC_KEY before running the substrate.
      // The worker CANNOT forge this — it doesn't have the control-plane
      // private key.
      capability,
    };

    return NextResponse.json({ spec });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
