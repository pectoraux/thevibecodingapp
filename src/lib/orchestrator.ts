// Forge — orchestration engine.
//
// The autonomous build loop:
//   1. Load frozen architecture
//   2. Load task graph
//   3. Select executable task (deps satisfied, not done)
//   4. Assign appropriate agent/model
//   5. Retrieve minimal required context
//   6. Execute implementation
//   7. Run local tests (record evidence)
//   8. Commit changes to virtual repo
//   9. Run Architecture Guardian
//   10. Run independent code review
//   11. Run integration tests
//   12. Mark task completed OR create repair task
//   13. Recompute task graph
//   14. Continue until PRODUCTION_READY or HUMAN_REVIEW_REQUIRED

import { db } from "@/lib/db";
import { decryptSecretOrNull, shortSha } from "@/lib/crypto";
import { buildAdapter, extractJson, type ChatMessage } from "@/lib/llm";
import { buildPrompt } from "@/lib/prompts";
import { ensureBuildEvent } from "@/lib/events";
// Phase 8: The control plane does NOT import execution modules.
// git-engine, worker, test-runner, execution-client, github — these are
// all used by the WORKER process (mini-services/execution-worker/poller.ts),
// NOT by the control plane. The orchestrator only:
// - generates architecture (LLM call via gateway)
// - freezes architecture
// - enqueues build jobs
// The actual task execution (git, tests, LLM code generation) happens in
// the worker process, which fetches an ExecutionSpec from the control plane
// and executes it in its own sandbox.
import { runReadinessGate, runPreflight } from "@/lib/readiness";
import {
  AgentType,
  BuildEventType,
  ProjectStatus,
  TaskStatus,
  type AgentType as AT,
} from "@/lib/types";
import type { LlmProvider, Task, Architecture } from "@prisma/client";

// ---------------------------------------------------------------------------
// Provider resolution (BYOK → fallback to z-ai sandbox LLM)
// ---------------------------------------------------------------------------

async function resolveAdapterForAgent(
  projectId: string,
  agentType: AT
) {
  const assignment = await db.agentAssignment.findFirst({
    where: { projectId, agentType },
    include: { provider: true },
  });
  if (assignment?.provider) {
    const prov = assignment.provider;
    // Decrypt the stored API key via the real AES-256-GCM secret store. If
    // decryption fails (wrong master key, tampered ciphertext, or legacy
    // XOR-obfuscated value from before the v1 envelope migration), treat the
    // key as missing — the buildAdapter call returns a BLOCKED adapter and
    // the execution is recorded as a failure rather than crashing the
    // orchestrator.
    const apiKey = decryptSecretOrNull(prov.apiKey) ?? undefined;
    return {
      adapter: buildAdapter({
        provider: prov.provider,
        model: prov.model,
        apiKey,
      }),
      provider: prov,
      assignment,
    };
  }
  // Fallback to z-ai sandbox LLM (single-LLM mode).
  return {
    adapter: buildAdapter({ provider: "zai", model: "glm-4.6" }),
    provider: null,
    assignment: null,
  };
}

// ---------------------------------------------------------------------------
// Run a single LLM-driven agent invocation with full evidence recording.
// ---------------------------------------------------------------------------

interface AgentInvocationResult {
  ok: boolean;
  rawOutput: string;
  parsed: any | null;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  durationMs: number;
  model: string;
  error?: string;
}

export async function invokeAgent(opts: {
  projectId: string;
  taskId?: string;
  agentType: AT;
  messages: ChatMessage[];
  architectureVersion?: string;
}): Promise<AgentInvocationResult> {
  const { projectId, taskId, agentType, messages, architectureVersion } = opts;
  const { adapter, provider, assignment } = await resolveAdapterForAgent(projectId, agentType);

  const start = Date.now();
  const result = await adapter.complete(messages);
  const durationMs = Date.now() - start;
  const parsed = extractJson(result.content);
  const costUsd =
    provider && provider.pricingPer1kInput
      ? (result.tokensInput * provider.pricingPer1kInput + result.tokensOutput * provider.pricingPer1kOutput) / 1000
      : 0;

  // Record evidence.
  await db.agentExecution.create({
    data: {
      projectId,
      taskId: taskId ?? null,
      agentType,
      providerId: provider?.id ?? null,
      assignmentId: assignment?.id ?? null,
      model: result.model,
      promptVersion: "forge-v1",
      inputContext: JSON.stringify(messages.map((m) => ({ role: m.role, len: m.content.length }))),
      output: result.content,
      outputJson: parsed ? JSON.stringify(parsed) : null,
      filesChanged: "[]",
      architectureVersion: architectureVersion ?? null,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      costUsd,
      durationMs,
      success: result.success,
      errorMessage: result.error ?? null,
    },
  });

  // Update assignment telemetry.
  if (assignment) {
    await db.agentAssignment.update({
      where: { id: assignment.id },
      data: {
        currentTaskId: taskId ?? null,
        state: result.success ? "IDLE" : "ERROR",
        lastActivity: new Date().toISOString(),
        tokensUsed: { increment: result.tokensInput + result.tokensOutput },
        costUsd: { increment: costUsd },
      },
    });
  }

  return {
    ok: result.success,
    rawOutput: result.content,
    parsed,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    costUsd,
    durationMs,
    model: result.model,
    error: result.error,
  };
}

// ---------------------------------------------------------------------------
// ARCHITECT — generate the full Architecture Contract from product spec.
// ---------------------------------------------------------------------------

export async function runArchitect(projectId: string): Promise<Architecture> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Project not found");

  await db.project.update({
    where: { id: projectId },
    data: { status: ProjectStatus.ARCHITECTING },
  });
  await ensureBuildEvent({
    projectId,
    type: BuildEventType.AGENT_INVOKED,
    level: "info",
    message: "Architect Agent invoked — designing system",
    agentType: AgentType.ARCHITECT,
  });

  const { system, user } = buildPrompt({
    agentType: AgentType.ARCHITECT,
    projectName: project.name,
    productSpec: project.productSpec,
    requirements: project.requirements,
    stack: project.stack,
  });

  const result = await invokeAgent({
    projectId,
    agentType: AgentType.ARCHITECT,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  if (!result.ok || !result.parsed) {
    await db.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.FAILED },
    });
    await ensureBuildEvent({
      projectId,
      type: BuildEventType.BLOCKED,
      level: "error",
      message: `Architect failed: ${result.error ?? "no structured output"}`,
      agentType: AgentType.ARCHITECT,
    });
    throw new Error(`Architect failed: ${result.error ?? "no structured output"}`);
  }

  const c = result.parsed;
  const contractJson = JSON.stringify(c, null, 2);
  const hash = shortSha(contractJson);

  // Build human-readable markdown.
  const md = buildArchitectureMarkdown(c);

  const architecture = await db.architecture.upsert({
    where: { projectId },
    create: {
      projectId,
      version: c.version || "v1.0",
      hash,
      frozen: false,
      contractJson,
      contractMd: md,
      components: JSON.stringify(c.components || []),
      dataModels: JSON.stringify(c.dataModels || []),
      apiContracts: JSON.stringify(c.apiContracts || []),
      integrations: JSON.stringify(c.integrations || []),
      invariants: JSON.stringify(c.invariants || []),
      constraints: JSON.stringify(c.constraints || []),
      testingStrategy: JSON.stringify(c.testingStrategy || {}),
      deploymentModel: JSON.stringify(c.deploymentModel || {}),
    },
    update: {
      version: c.version || "v1.0",
      hash,
      frozen: false,
      contractJson,
      contractMd: md,
      components: JSON.stringify(c.components || []),
      dataModels: JSON.stringify(c.dataModels || []),
      apiContracts: JSON.stringify(c.apiContracts || []),
      integrations: JSON.stringify(c.integrations || []),
      invariants: JSON.stringify(c.invariants || []),
      constraints: JSON.stringify(c.constraints || []),
      testingStrategy: JSON.stringify(c.testingStrategy || {}),
      deploymentModel: JSON.stringify(c.deploymentModel || {}),
    },
  });

  // Seed credential manifest.
  if (Array.isArray(c.requiredCredentials)) {
    await db.credential.deleteMany({ where: { projectId, name: { in: c.requiredCredentials.map((x: any) => x.name) } } });
    for (const cred of c.requiredCredentials) {
      await db.credential.create({
        data: {
          projectId,
          name: cred.name,
          purpose: cred.purpose || "",
          environment: "production",
          provider: cred.provider || null,
          required: cred.required ?? true,
          optional: !(cred.required ?? true),
          validationMethod: cred.validationMethod || null,
          testSandboxSupport: cred.testSandboxSupport ?? false,
          whenRequired: cred.whenRequired || null,
          configured: false,
          validated: false,
        },
      });
    }
  }

  // Seed ADRs.
  if (Array.isArray(c.adrs)) {
    await db.adr.deleteMany({ where: { projectId } });
    for (const adr of c.adrs) {
      await db.adr.create({
        data: {
          projectId,
          number: adr.number,
          title: adr.title,
          decision: adr.decision,
          status: "accepted",
          reason: adr.reason || "",
          alternatives: adr.alternatives || "",
          consequences: adr.consequences || "",
        },
      });
    }
  }

  // Seed task graph.
  if (Array.isArray(c.tasks)) {
    await db.task.deleteMany({ where: { projectId } });
    for (const t of c.tasks) {
      await db.task.create({
        data: {
          projectId,
          code: t.code,
          title: t.title,
          description: t.description,
          component: t.component || "",
          agentType: t.agentType || AgentType.BACKEND,
          dependencies: JSON.stringify(t.dependencies || []),
          inputs: "[]",
          outputs: "[]",
          acceptanceCriteria: JSON.stringify(t.acceptanceCriteria || []),
          requiredTests: JSON.stringify(t.requiredTests || []),
          priority: t.priority ?? 5,
          risk: t.risk || "MEDIUM",
          status: TaskStatus.PLANNED,
        },
      });
    }
  }

  // Ensure agent assignments exist for all roles.
  await ensureAgentAssignments(projectId);

  await db.project.update({
    where: { id: projectId },
    data: { status: ProjectStatus.AWAITING_ARCHITECTURE_APPROVAL },
  });
  await ensureBuildEvent({
    projectId,
    type: BuildEventType.ARCHITECTURE_GENERATED,
    level: "success",
    message: `Architecture ${architecture.version} generated — hash ${architecture.hash.slice(0, 8)}`,
    agentType: AgentType.ARCHITECT,
    payload: JSON.stringify({ version: architecture.version, hash: architecture.hash, taskCount: c.tasks?.length ?? 0 }),
  });

  return architecture;
}

// ---------------------------------------------------------------------------
// Freeze architecture — locks the contract as immutable.
// ---------------------------------------------------------------------------

export async function freezeArchitecture(projectId: string): Promise<Architecture> {
  const architecture = await db.architecture.findUnique({ where: { projectId } });
  if (!architecture) throw new Error("Architecture not generated yet");
  const frozen = await db.architecture.update({
    where: { projectId },
    data: { frozen: true, frozenAt: new Date() },
  });
  await db.project.update({
    where: { id: projectId },
    data: { status: ProjectStatus.ARCHITECTURE_FROZEN },
  });
  await ensureBuildEvent({
    projectId,
    type: BuildEventType.ARCHITECTURE_FROZEN,
    level: "success",
    message: `Architecture ${frozen.version} FROZEN — hash ${frozen.hash.slice(0, 8)}`,
    payload: JSON.stringify({ version: frozen.version, hash: frozen.hash, frozenAt: frozen.frozenAt }),
  });
  return frozen;
}

// ---------------------------------------------------------------------------
// Start Build — runs the autonomous loop until done or blocked.
// ---------------------------------------------------------------------------

export async function startBuild(projectId: string): Promise<void> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Project not found");

  const architecture = await db.architecture.findUnique({ where: { projectId } });
  if (!architecture?.frozen) throw new Error("Architecture must be frozen first");

  // Preflight.
  const preflight = await runPreflight(projectId);
  if (!preflight.passed) {
    await db.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.BLOCKED },
    });
    return;
  }

  // Phase 7: Enqueue the build job and return immediately.
  // The WORKER (separate process) claims and executes tasks.
  // The browser has ZERO influence on execution progress.
  const { enqueueBuild } = await import("@/lib/scheduler");
  await enqueueBuild(projectId);

  await db.project.update({
    where: { id: projectId },
    data: { status: ProjectStatus.BUILDING },
  });
  await ensureBuildEvent({
    projectId,
    type: BuildEventType.BUILD_STARTED,
    level: "success",
    message: "Build queued — worker-driven async execution",
  });
}

// ---------------------------------------------------------------------------
// Phase 8: executeTask() and tickOnce() have been REMOVED.
//
// The control plane NO LONGER executes tasks. The worker process
// (mini-services/execution-worker/poller.ts) claims ExecutionJobs,
// fetches an ExecutionSpec from /api/worker/job-spec, and executes
// the task in its own sandbox (LLM + git + tests + Guardian).
//
// The control plane only:
// - generates architecture (runArchitect)
// - freezes architecture (freezeArchitecture)
// - enqueues build jobs (startBuild → enqueueBuild)
// - stores evidence (submitted by worker via /api/worker/submit-evidence)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureAgentAssignments(projectId: string) {
  const agentTypes: AT[] = [
    AgentType.ARCHITECT,
    AgentType.ARCHITECTURE_GUARDIAN,
    AgentType.CODE_REVIEWER,
    AgentType.FRONTEND,
    AgentType.BACKEND,
    AgentType.DATABASE,
    AgentType.INFRASTRUCTURE,
    AgentType.INTEGRATION,
    AgentType.QA,
  ];
  for (const agentType of agentTypes) {
    const existing = await db.agentAssignment.findFirst({ where: { projectId, agentType } });
    if (!existing) {
      await db.agentAssignment.create({
        data: { projectId, agentType, state: "IDLE" },
      });
    }
  }
}

function buildArchitectureMarkdown(c: any): string {
  const lines: string[] = [];
  lines.push(`# Architecture Contract — ${c.version || "v1.0"}`);
  lines.push("");
  if (c.summary) lines.push(`> ${c.summary}`);
  lines.push("");
  if (Array.isArray(c.components) && c.components.length) {
    lines.push("## Components");
    for (const comp of c.components) {
      lines.push(`### ${comp.name} (${comp.type})`);
      if (comp.description) lines.push(comp.description);
      if (comp.tech?.length) lines.push(`- Tech: ${comp.tech.join(", ")}`);
      if (comp.responsibilities?.length) {
        lines.push("- Responsibilities:");
        comp.responsibilities.forEach((r: string) => lines.push(`  - ${r}`));
      }
      lines.push("");
    }
  }
  if (Array.isArray(c.dataModels) && c.dataModels.length) {
    lines.push("## Data Models");
    for (const m of c.dataModels) {
      lines.push(`### ${m.name}`);
      if (m.description) lines.push(m.description);
      if (m.fields?.length) {
        lines.push("| Field | Type | Required |");
        lines.push("|---|---|---|");
        for (const f of m.fields) {
          lines.push(`| ${f.name} | ${f.type} | ${f.required ? "yes" : "no"} |`);
        }
      }
      lines.push("");
    }
  }
  if (Array.isArray(c.apiContracts) && c.apiContracts.length) {
    lines.push("## API Contracts");
    for (const a of c.apiContracts) {
      lines.push(`### ${a.method} ${a.path}`);
      if (a.description) lines.push(a.description);
      if (a.auth) lines.push(`- Auth: ${a.auth}`);
      lines.push("");
    }
  }
  if (Array.isArray(c.invariants) && c.invariants.length) {
    lines.push("## Invariants (Guardian-enforced)");
    c.invariants.forEach((inv: string) => lines.push(`- ${inv}`));
    lines.push("");
  }
  if (Array.isArray(c.requiredCredentials) && c.requiredCredentials.length) {
    lines.push("## Required Credentials");
    for (const cred of c.requiredCredentials) {
      lines.push(`- **${cred.name}** — ${cred.purpose} (required: ${cred.required ?? true}, sandbox: ${cred.testSandboxSupport ?? false})`);
    }
    lines.push("");
  }
  if (Array.isArray(c.tasks) && c.tasks.length) {
    lines.push("## Task Graph");
    for (const t of c.tasks) {
      lines.push(`- **${t.code}** (${t.agentType}, P${t.priority}) — ${t.title}`);
      if (t.dependencies?.length) lines.push(`  - Depends on: ${t.dependencies.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// Re-exported for API routes.
export { runPreflight, runReadinessGate } from "@/lib/readiness";
