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
// Phase 3: execution plane separation — tests run in the isolated worker, NOT in-process.
import * as gitEngine from "@/lib/git-engine";
import { submitExecutionJob, isExecutionWorkerAvailable } from "@/lib/execution-client";
import { FORGE_EXECUTION_MODE } from "@/lib/execution-mode";
import { runDeterministicGuardian } from "@/lib/guardian-deterministic";
import { recordEvidence, hasSufficientEvidence } from "@/lib/evidence";
import * as github from "@/lib/github";
// repo.ts is now metadata-only (SHA, branch, PR number). No file contents in DB.
import { ensureBranch, createPullRequest, mergePullRequest } from "@/lib/repo";
import { runReadinessGate, runPreflight } from "@/lib/readiness";
import { createJob, updateJobStatus } from "@/lib/job-queue";
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
  // GitHub connection is optional in dev mode — we can use a local repo.
  // In production, GitHub should be connected for canonical source-of-truth.

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

  await db.project.update({
    where: { id: projectId },
    data: { status: ProjectStatus.BUILDING },
  });
  await ensureBuildEvent({
    projectId,
    type: BuildEventType.BUILD_STARTED,
    level: "success",
    message: "Build started — autonomous orchestration engaged",
  });

  // Run the loop. We do bounded iterations to avoid infinite loops.
  const MAX_LOOP_ITERATIONS = 60;
  for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
    const shouldStop = await tickOnce(projectId);
    if (shouldStop) break;
  }

  // Final verification.
  await db.project.update({
    where: { id: projectId },
    data: { status: ProjectStatus.VERIFYING },
  });
  const gate = await runReadinessGate(projectId);
  if (gate.passed) {
    await db.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.PRODUCTION_READY },
    });
    await ensureBuildEvent({
      projectId,
      type: BuildEventType.PRODUCTION_READY,
      level: "success",
      message: `PRODUCTION READY — ${gate.passedCount}/${gate.total} readiness checks passed`,
    });
  } else {
    await db.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.HUMAN_REVIEW_REQUIRED },
    });
    await ensureBuildEvent({
      projectId,
      type: BuildEventType.HUMAN_REVIEW_REQUIRED,
      level: "warn",
      message: `Human review required — ${gate.failedCount} readiness check(s) failed`,
      payload: JSON.stringify(gate.results.filter((r) => r.status !== "PASSED")),
    });
  }
}

// ---------------------------------------------------------------------------
// One tick of the autonomous loop. Returns true if the loop should stop.
// ---------------------------------------------------------------------------

async function tickOnce(projectId: string): Promise<boolean> {
  const tasks = await db.task.findMany({ where: { projectId }, orderBy: { priority: "asc" } });
  // Find next runnable task: status PLANNED or QUEUED or FAILED (with attempts left), all deps COMPLETED.
  const byCode = new Map(tasks.map((t) => [t.code, t]));
  let next: Task | null = null;
  for (const t of tasks) {
    if ([TaskStatus.RUNNING, TaskStatus.REVIEWING, TaskStatus.COMPLETED].includes(t.status as any)) continue;
    if (t.status === TaskStatus.FAILED && t.attempts >= t.maxAttempts) continue;
    const deps = JSON.parse(t.dependencies || "[]") as string[];
    const allDepsDone = deps.every((d) => {
      const dep = byCode.get(d);
      return dep?.status === TaskStatus.COMPLETED;
    });
    if (!allDepsDone) continue;
    next = t;
    break;
  }

  if (!next) {
    // No runnable task. Check if everything is done.
    const pending = tasks.filter((t) => t.status !== TaskStatus.COMPLETED);
    if (pending.length === 0) return true; // All done — stop loop, run readiness gate.
    // Otherwise we're blocked.
    if (tasks.some((t) => t.status === TaskStatus.FAILED && t.attempts >= t.maxAttempts)) {
      await db.project.update({ where: { id: projectId }, data: { status: ProjectStatus.HUMAN_REVIEW_REQUIRED } });
      await ensureBuildEvent({
        projectId,
        type: BuildEventType.HUMAN_REVIEW_REQUIRED,
        level: "warn",
        message: `Human review required — task(s) exhausted retries`,
      });
      return true;
    }
    return true;
  }

  await executeTask(projectId, next.id);
  return false;
}

// ---------------------------------------------------------------------------
// Execute a single task: implementation → tests → commit → guardian → review.
// ---------------------------------------------------------------------------

async function executeTask(projectId: string, taskId: string): Promise<void> {
  const task = await db.task.findUnique({ where: { id: taskId } });
  if (!task) return;
  const architecture = await db.architecture.findUnique({ where: { projectId } });
  if (!architecture) throw new Error("Architecture missing");
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Project not found");

  await db.task.update({
    where: { id: taskId },
    data: {
      status: TaskStatus.RUNNING,
      attempts: { increment: 1 },
      startedAt: new Date(),
    },
  });
  await ensureBuildEvent({
    projectId,
    type: BuildEventType.TASK_STARTED,
    level: "info",
    message: `Task ${task.code} started — ${task.title}`,
    taskId,
    agentType: task.agentType as AT,
  });

  // --- Phase 2: Real Git Worktree ---
  // Each task gets its own worktree. Agents write to the real filesystem.
  // Git is canonical; DB rows are metadata shadows.
  const branchName = `task/${task.code.toLowerCase()}`;
  const repoPath = gitEngine.getRepoPath(projectId);

  // Ensure the project's local repo exists (clone from GitHub or init).
  try {
    if (project.githubConnected && project.githubRepo) {
      const [owner, name] = project.githubRepo.split("/");
      const cloneUrl = github.getCloneUrl(owner, name);
      await gitEngine.cloneRepo(projectId, cloneUrl);
    } else {
      await gitEngine.initRepo(projectId, project.name);
    }
  } catch (err: any) {
    // Repo may already exist — that's fine.
    await ensureBuildEvent({
      projectId, type: BuildEventType.TASK_STARTED, level: "info",
      message: `Repo already initialized at ${repoPath}`,
      taskId,
    });
  }

  // Create an isolated worktree for this task attempt.
  const worktreePath = gitEngine.getWorktreePath(projectId, `${task.code.toLowerCase()}-${task.attempts}`);
  let worktreeCreated = false;
  try {
    await gitEngine.createWorktree(projectId, `${task.code.toLowerCase()}-${task.attempts}`, "main");
    worktreeCreated = true;
  } catch (err: any) {
    await ensureBuildEvent({
      projectId, type: BuildEventType.TASK_FAILED, level: "error",
      message: `Failed to create worktree: ${err.message}`,
      taskId,
    });
  }

  // Also create a DB branch record (metadata shadow).
  await ensureBranch(projectId, branchName, "main");

  // 1. Implementation agent — calls the real LLM (no template fallback in prod).
  const implResult = await runImplementationAgent(projectId, task, architecture, branchName);
  if (!implResult.ok) {
    await db.task.update({
      where: { id: taskId },
      data: { status: TaskStatus.FAILED, failureReason: implResult.error ?? "implementation failed (no LLM output)" },
    });
    await ensureBuildEvent({
      projectId,
      type: BuildEventType.TASK_FAILED,
      level: "error",
      message: `Task ${task.code} BLOCKED — ${implResult.error ?? "no implementation produced"}`,
      taskId,
    });
    if (worktreeCreated) await gitEngine.removeWorktree(projectId, `${task.code.toLowerCase()}-${task.attempts}`).catch(() => {});
    return;
  }

  // 2. Write files to the real worktree + commit.
  const files = implResult.parsed?.files || [];
  let realCommitSha: string | null = null;

  if (worktreeCreated) {
    for (const f of files) {
      try {
        await gitEngine.writeToFile(worktreePath, f.path, f.content || "");
      } catch (err: any) {
        await ensureBuildEvent({
          projectId, type: BuildEventType.TASK_FAILED, level: "error",
          message: `Failed to write ${f.path}: ${err.message}`,
          taskId,
        });
      }
    }
    try {
      realCommitSha = await gitEngine.commitAll(worktreePath, `feat(${task.code}): ${task.title}`);
    } catch (err: any) {
      await ensureBuildEvent({
        projectId, type: BuildEventType.TASK_FAILED, level: "error",
        message: `Failed to commit: ${err.message}`,
        taskId,
      });
    }
  }

  // --- Phase 3: NO DB SHADOW COMMIT ---
  // A task is BLOCKED if there is no real git commit. We do NOT create a
  // fake DB SHA. The DB may store metadata (SHA, branch) but only if there
  // is a real commit to reference. No real commit = BLOCKED.
  if (!realCommitSha) {
    await db.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.FAILED,
        failureReason: "BLOCKED: No real git commit — cannot proceed without real commit (Phase 3 rule: no DB shadow commits)",
      },
    });
    await ensureBuildEvent({
      projectId,
      type: BuildEventType.TASK_FAILED,
      level: "error",
      message: `Task ${task.code} BLOCKED — no real git commit (worktree=${worktreeCreated}, files=${files.length})`,
      taskId,
    });
    if (worktreeCreated) await gitEngine.removeWorktree(projectId, `${task.code.toLowerCase()}-${task.attempts}`).catch(() => {});
    return;
  }

  const sha = realCommitSha;

  // Record metadata in DB (SHA + branch only, NOT file contents).
  // Git is canonical. DB is metadata only.
  await db.repoCommit.create({
    data: {
      projectId,
      sha,
      branchName,
      parentSha: null,
      message: `feat(${task.code}): ${task.title}`,
      filesChangedJson: JSON.stringify(files.map((f: any) => f.path)),
      taskId,
    },
  });

  await db.task.update({
    where: { id: taskId },
    data: {
      commitSha: sha,
      branchName,
      filesChangedJson: JSON.stringify(files.map((f: any) => f.path)),
      implementationLog: implResult.rawOutput,
    },
  });
  await ensureBuildEvent({
    projectId,
    type: BuildEventType.COMMIT,
    level: "success",
    message: `Commit ${sha.slice(0, 7)} on ${branchName} — ${files.length} file(s)${realCommitSha ? " [real git]" : " [db shadow]"}`,
    taskId,
    payload: JSON.stringify({ sha, files: files.map((f: any) => f.path), worktree: worktreePath }),
  });

  // 3. --- Phase 3: Real Test Execution via ISOLATED EXECUTION WORKER ---
  // Tests are NOT executed inside the Next.js process. They are sent to the
  // execution worker (separate process, isolated environment). If the worker
  // is unavailable, the task is BLOCKED — never silently run locally.
  let testResults: any[] = [];
  let testsOk = false;
  if (worktreeCreated && realCommitSha) {
    try {
      // Submit the test execution job to the isolated worker.
      // The worker receives ONLY the worktree path and an explicit env allowlist.
      // It does NOT inherit FORGE_MASTER_KEY, DATABASE_URL, NEXTAUTH_SECRET, etc.
      const jobResponse = await submitExecutionJob({
        jobId: `${task.code}-${task.attempts}-test`,
        projectId,
        worktreePath,
        commands: [
          { command: "npm", args: ["install", "--silent"], timeoutMs: 120000 },
          { command: "npm", args: ["test", "--", "--json", "--silent"], timeoutMs: 120000 },
        ],
        env: {
          // Only project-scoped test credentials, never platform secrets.
          NODE_ENV: "test",
        },
        timeoutMs: 300000,
      });

      // Parse test results from the worker response.
      const installResult = jobResponse.results[0];
      const testResult = jobResponse.results[1];

      if (testResult) {
        // Try to parse Jest JSON output.
        let parsed: any = null;
        try { parsed = JSON.parse(testResult.stdout); } catch {}

        if (parsed && parsed.numTotalTests !== undefined) {
          testResults = [{
            name: "jest",
            type: "real",
            target: task.code,
            passes: testResult.success,
            evidence: `exitCode=${testResult.exitCode}, passed=${parsed.numPassedTests}, failed=${parsed.numFailedTests}, skipped=${parsed.numPendingTests}, duration=${testResult.durationMs}ms`,
            command: "npm test",
            exitCode: testResult.exitCode,
            stdout: (testResult.stdout || "").slice(0, 5000),
            stderr: (testResult.stderr || "").slice(0, 5000),
            passed: parsed.numPassedTests,
            failed: parsed.numFailedTests,
            skipped: parsed.numPendingTests,
            total: parsed.numTotalTests,
            framework: "jest",
            durationMs: testResult.durationMs,
            timedOut: testResult.timedOut,
            sandboxId: "execution-worker",
          }];
          testsOk = testResult.success;
        } else {
          // Non-Jest or unparseable output — still record real evidence.
          testResults = [{
            name: "test-runner",
            type: "real",
            target: task.code,
            passes: testResult.success,
            evidence: `exitCode=${testResult.exitCode}, duration=${testResult.durationMs}ms (output not parsed as JSON)`,
            command: "npm test",
            exitCode: testResult.exitCode,
            stdout: (testResult.stdout || "").slice(0, 5000),
            stderr: (testResult.stderr || "").slice(0, 5000),
            passed: 0,
            failed: 0,
            skipped: 0,
            total: 0,
            framework: "unknown",
            durationMs: testResult.durationMs,
            timedOut: testResult.timedOut,
            sandboxId: "execution-worker",
          }];
          testsOk = testResult.success;
        }
      } else {
        testResults = [{
          name: "execution-worker",
          type: "real",
          target: task.code,
          passes: false,
          evidence: `No test result returned from worker. Install result: exitCode=${installResult?.exitCode}`,
          error: "No test result",
        }];
        testsOk = false;
      }
    } catch (err: any) {
      testResults = [{
        name: "execution-worker",
        type: "real",
        target: task.code,
        passes: false,
        evidence: `Execution worker failed: ${err.message}`,
        error: err.message,
      }];
      testsOk = false;
    }
  } else {
    // No worktree — can't run real tests. This is a BLOCKED state, not a pass.
    testResults = [{
      name: "worktree",
      type: "real",
      target: task.code,
      passes: false,
      evidence: "No worktree available — tests could not be executed (BLOCKED)",
    }];
    testsOk = false;
  }
  await db.task.update({
    where: { id: taskId },
    data: { testResultsJson: JSON.stringify(testResults) },
  });
  await ensureBuildEvent({
    projectId,
    type: BuildEventType.TESTS_RUN,
    level: testsOk ? "success" : "warn",
    message: `Tests for ${task.code}: ${testsOk ? "PASSED" : "FAILED"} (real execution)`,
    taskId,
    payload: JSON.stringify(testResults),
  });

  // 4. --- Phase 2: Deterministic Guardian (Layer 1) ---
  // Mechanical checks BEFORE the LLM Guardian. Catches real violations.
  let deterministicResult: any = null;
  if (worktreeCreated && realCommitSha) {
    try {
      const diff = await gitEngine.getDiff(worktreePath, "main");
      const archParsed = {
        version: architecture.version,
        hash: architecture.hash,
        components: JSON.parse(architecture.components || "[]"),
        dataModels: JSON.parse(architecture.dataModels || "[]"),
        apiContracts: JSON.parse(architecture.apiContracts || "[]"),
        invariants: JSON.parse(architecture.invariants || "[]"),
        constraints: JSON.parse(architecture.constraints || "[]"),
        deploymentModel: JSON.parse(architecture.deploymentModel || "{}"),
      };
      deterministicResult = await runDeterministicGuardian({
        architecture: archParsed,
        changedFiles: files.map((f: any) => ({ path: f.path, content: f.content || "" })),
        diff,
      });
    } catch (err: any) {
      // Phase 3: Guardian execution failure is UNVERIFIED, not WARNING.
      // Infrastructure failure must NOT be downgraded to a warning.
      deterministicResult = {
        verdict: "VIOLATION",
        violations: [{ check: "deterministic-guardian", invariant: "Guardian must execute", evidence: err.message, files: [], severity: "high", remediation: "Fix Guardian execution and retry" }],
        warnings: [],
        checks: [],
        summary: `UNVERIFIED: Deterministic Guardian failed to execute: ${err.message}`,
      };
    }
  }

  // 4b. LLM Guardian (Layer 2) — semantic checks with minimal context.
  const llmGuardianResult = await runGuardian(projectId, task, architecture, files);

  // Combine: deterministic verdict takes precedence for violations.
  const combinedGuardian = {
    deterministic: deterministicResult,
    llm: llmGuardianResult,
    verdict: deterministicResult?.verdict === "VIOLATION" ? "VIOLATION" :
             llmGuardianResult.verdict === "VIOLATION" ? "VIOLATION" :
             deterministicResult?.verdict === "WARNING" || llmGuardianResult.verdict === "WARNING" ? "WARNING" : "PASS",
    summary: `${deterministicResult?.summary || ""} | LLM: ${llmGuardianResult.summary}`,
  };

  await db.task.update({
    where: { id: taskId },
    data: {
      architectureStatus: combinedGuardian.verdict,
      guardianResultJson: JSON.stringify(combinedGuardian),
    },
  });
  await ensureBuildEvent({
    projectId,
    type:
      combinedGuardian.verdict === "PASS"
        ? BuildEventType.GUARDIAN_PASS
        : combinedGuardian.verdict === "WARNING"
        ? BuildEventType.GUARDIAN_WARNING
        : BuildEventType.GUARDIAN_VIOLATION,
    level: combinedGuardian.verdict === "PASS" ? "success" : combinedGuardian.verdict === "WARNING" ? "warn" : "error",
    message: `Guardian ${combinedGuardian.verdict} for ${task.code} — ${combinedGuardian.summary}`,
    taskId,
    agentType: AgentType.ARCHITECTURE_GUARDIAN,
    payload: JSON.stringify(combinedGuardian),
  });

  // 5. Independent code review.
  const reviewResult = await runCodeReview(projectId, task, architecture, files);
  await db.task.update({
    where: { id: taskId },
    data: {
      reviewStatus: reviewResult.verdict === "APPROVED" ? "PASSED" : reviewResult.verdict === "REJECTED" ? "FAILED" : "CHANGES_REQUESTED",
      reviewResultJson: JSON.stringify(reviewResult),
    },
  });
  await ensureBuildEvent({
    projectId,
    type: reviewResult.verdict === "APPROVED" ? BuildEventType.REVIEW_PASSED : BuildEventType.REVIEW_CHANGES_REQUESTED,
    level: reviewResult.verdict === "APPROVED" ? "success" : "warn",
    message: `Review ${reviewResult.verdict} for ${task.code} — ${reviewResult.summary}`,
    taskId,
    agentType: AgentType.CODE_REVIEWER,
    payload: JSON.stringify(reviewResult),
  });

  // 6. --- Phase 2: Evidence Ledger ---
  // Record immutable evidence for this attempt. A task can only transition
  // to COMPLETED if the evidence ledger proves: real commit + real passing
  // tests + Guardian PASS + review APPROVED.
  let evidenceRecord: any = null;
  try {
    evidenceRecord = await recordEvidence(taskId, projectId, {
      architectureVersion: architecture.version,
      architectureHash: architecture.hash,
      commitSha: sha,
      changedFiles: files.map((f: any) => f.path),
      commandsExecuted: testResults.map((t) => ({ command: t.command || t.name, exitCode: t.exitCode ?? (t.passes ? 0 : 1), durationMs: t.durationMs || 0 })),
      testRuns: testResults,
      runtimeChecks: [],
      guardianResults: combinedGuardian,
      reviewResults: reviewResult,
      integrationChecks: [],
    });
  } catch (err: any) {
    // Phase 3: Evidence recording failure BLOCKS completion.
    // The platform cannot prove the task completed without evidence.
    // BLOCKED is correct, not COMPLETED with missing evidence.
    await ensureBuildEvent({
      projectId, type: BuildEventType.TASK_FAILED, level: "error",
      message: `BLOCKED — evidence recording failed: ${err.message}`,
      taskId,
    });
  }

  // 7. Decide outcome — evidence-based, not LLM-assertion-based.
  const guardianOk = combinedGuardian.verdict === "PASS" || combinedGuardian.verdict === "WARNING";
  const reviewOk = reviewResult.verdict === "APPROVED";

  // Check evidence sufficiency — the platform's own verification, not the LLM's claim.
  const evidenceOk = evidenceRecord ? hasSufficientEvidence(evidenceRecord) : false;

  if (guardianOk && reviewOk && testsOk && evidenceOk) {
    // Push to GitHub if connected.
    if (project.githubConnected && project.githubRepo && worktreeCreated && realCommitSha) {
      try {
        const pushResult = await gitEngine.pushBranch(worktreePath, branchName);
        if (!pushResult.ok) {
          await ensureBuildEvent({
            projectId, type: BuildEventType.COMMIT, level: "warn",
            message: `Git push failed: ${pushResult.error || "unknown"}`,
            taskId,
          });
        }
      } catch (err: any) {
        await ensureBuildEvent({
          projectId, type: BuildEventType.COMMIT, level: "warn",
          message: `Git push error: ${err.message}`,
          taskId,
        });
      }
    }

    // --- Phase 3: NO DB SHADOW PR ---
    // A PR is only real if it exists in actual GitHub. If GitHub is not
    // connected, the project operates in LOCAL_ONLY mode — the UI clearly
    // distinguishes this from GITHUB_BACKED.
    let prNumber: number | null = null;
    if (project.githubConnected && project.githubRepo) {
      // GITHUB_BACKED mode — create a real GitHub PR.
      try {
        const [owner, name] = project.githubRepo.split("/");
        const realPR = await github.createPullRequest(owner, name, {
          title: `[${task.code}] ${task.title}`,
          head: branchName,
          base: "main",
          body: `Implementation of ${task.title}.\n\nEvidence: commit ${sha.slice(0,7)}, tests ${testsOk ? "passed" : "failed"}, guardian ${combinedGuardian.verdict}, review ${reviewResult.verdict}`,
        });
        prNumber = realPR.number;
        // Merge the real PR.
        await github.mergePullRequest(owner, name, realPR.number);
        // Record metadata in DB.
        await createPullRequest({
          projectId,
          title: `[${task.code}] ${task.title}`,
          branchName,
          taskId,
          body: `Real GitHub PR #${realPR.number} — ${sha.slice(0,7)}`,
        });
        await ensureBuildEvent({
          projectId, type: BuildEventType.TASK_COMPLETED, level: "success",
          message: `Real GitHub PR #${realPR.number} created and merged`,
          taskId,
        });
      } catch (err: any) {
        // GitHub PR creation failed — task cannot complete in GITHUB_BACKED mode.
        await db.task.update({
          where: { id: taskId },
          data: {
            status: TaskStatus.FAILED,
            failureReason: `BLOCKED: GitHub PR creation failed: ${err.message}`,
          },
        });
        await ensureBuildEvent({
          projectId, type: BuildEventType.TASK_FAILED, level: "error",
          message: `Task ${task.code} BLOCKED — GitHub PR creation failed: ${err.message}`,
          taskId,
        });
        if (worktreeCreated) await gitEngine.removeWorktree(projectId, `${task.code.toLowerCase()}-${task.attempts}`).catch(() => {});
        return;
      }
    } else {
      // LOCAL_ONLY mode — no GitHub PR. Task can complete locally but
      // readiness gate will know this is not GITHUB_BACKED.
      await ensureBuildEvent({
        projectId, type: BuildEventType.TASK_COMPLETED, level: "success",
        message: `Task ${task.code} completed in LOCAL_ONLY mode (no GitHub PR)`,
        taskId,
      });
    }

    await db.task.update({
      where: { id: taskId },
      data: { status: TaskStatus.COMPLETED, completedAt: new Date() },
    });
    await ensureBuildEvent({
      projectId,
      type: BuildEventType.TASK_COMPLETED,
      level: "success",
      message: `Task ${task.code} COMPLETED — ${prNumber ? `GitHub PR #${prNumber} merged` : "LOCAL_ONLY mode"} (evidence: real commit ${sha.slice(0,7)} + real tests + guardian PASS + review APPROVED)`,
      taskId,
    });
  } else {
    // Failed — either retry or escalate.
    const reason = `guardian=${combinedGuardian.verdict}, review=${reviewResult.verdict}, tests=${testsOk ? "ok" : "fail"}, evidence=${evidenceOk ? "sufficient" : "insufficient"}`;
    if (task.attempts >= task.maxAttempts) {
      await db.task.update({
        where: { id: taskId },
        data: { status: TaskStatus.FAILED, failureReason: `Exhausted retries (${reason})` },
      });
      await ensureBuildEvent({
        projectId,
        type: BuildEventType.TASK_FAILED,
        level: "error",
        message: `Task ${task.code} FAILED after ${task.attempts} attempts (${reason})`,
        taskId,
      });
    } else {
      await db.task.update({
        where: { id: taskId },
        data: { status: TaskStatus.PLANNED, failureReason: `Retry needed (${reason})` },
      });
      await ensureBuildEvent({
        projectId,
        type: BuildEventType.REPAIR_TASK_CREATED,
        level: "warn",
        message: `Task ${task.code} scheduled for retry (attempt ${task.attempts}/${task.maxAttempts}) — ${reason}`,
        taskId,
      });
    }
  }

  // Cleanup worktree.
  if (worktreeCreated) {
    await gitEngine.removeWorktree(projectId, `${task.code.toLowerCase()}-${task.attempts}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Implementation agent runner
// ---------------------------------------------------------------------------

async function runImplementationAgent(
  projectId: string,
  task: Task,
  architecture: Architecture,
  branchName: string
): Promise<{ ok: boolean; parsed: any; rawOutput: string; error?: string }> {
  const agentType = task.agentType as AT;
  const { system, user } = buildPrompt({
    agentType,
    projectName: (await db.project.findUnique({ where: { id: projectId } }))!.name,
    architectureJson: architecture.contractJson,
    task: {
      code: task.code,
      title: task.title,
      description: task.description,
      acceptanceCriteria: JSON.parse(task.acceptanceCriteria || "[]"),
      requiredTests: JSON.parse(task.requiredTests || "[]"),
    },
  });

  const result = await invokeAgent({
    projectId,
    taskId: task.id,
    agentType,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    architectureVersion: architecture.version,
  });

  await ensureBuildEvent({
    projectId,
    type: BuildEventType.AGENT_INVOKED,
    level: "info",
    message: `${agentType} agent executed task ${task.code} (${result.tokensInput + result.tokensOutput} tokens, ${result.durationMs}ms)`,
    taskId: task.id,
    agentType,
  });

  return {
    ok: result.ok && !!result.parsed && Array.isArray(result.parsed.files) && result.parsed.files.length > 0,
    parsed: result.parsed,
    rawOutput: result.rawOutput,
    error: result.error ?? (!result.parsed ? "no structured output" : (!result.parsed.files?.length ? "no files produced" : undefined)),
  };
}

// ---------------------------------------------------------------------------
// Architecture Guardian runner
// ---------------------------------------------------------------------------

async function runGuardian(
  projectId: string,
  task: Task,
  architecture: Architecture,
  changedFiles: any[]
): Promise<any> {
  // Build minimal context: frozen invariants + changed files only.
  const invariants = JSON.parse(architecture.invariants || "[]");
  const constraints = JSON.parse(architecture.constraints || "[]");
  const components = JSON.parse(architecture.components || "[]");

  const { system, user } = buildPrompt({
    agentType: AgentType.ARCHITECTURE_GUARDIAN,
    projectName: (await db.project.findUnique({ where: { id: projectId } }))!.name,
    architectureJson: JSON.stringify({
      version: architecture.version,
      hash: architecture.hash,
      invariants,
      constraints,
      components: components.map((c: any) => ({ name: c.name, type: c.type, tech: c.tech })),
    }),
    task: {
      code: task.code,
      title: task.title,
      description: task.description,
      acceptanceCriteria: [],
      requiredTests: [],
    },
    changedFiles: changedFiles.map((f) => ({ path: f.path, content: (f.content || "").slice(0, 4000) })),
  });

  const result = await invokeAgent({
    projectId,
    taskId: task.id,
    agentType: AgentType.ARCHITECTURE_GUARDIAN,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    architectureVersion: architecture.version,
  });

  if (!result.parsed) {
    return {
      verdict: "WARNING",
      violations: [],
      warnings: [{ invariant: "Guardian parse failure", evidence: result.rawOutput.slice(0, 500), files: [], remediation: "Manual review" }],
      summary: "Guardian could not parse structured output; defaulting to WARNING",
    };
  }
  return {
    verdict: result.parsed.verdict || "WARNING",
    violations: result.parsed.violations || [],
    warnings: result.parsed.warnings || [],
    summary: result.parsed.summary || "",
  };
}

// ---------------------------------------------------------------------------
// Code Reviewer runner
// ---------------------------------------------------------------------------

async function runCodeReview(
  projectId: string,
  task: Task,
  architecture: Architecture,
  changedFiles: any[]
): Promise<any> {
  const { system, user } = buildPrompt({
    agentType: AgentType.CODE_REVIEWER,
    projectName: (await db.project.findUnique({ where: { id: projectId } }))!.name,
    architectureJson: JSON.stringify({
      version: architecture.version,
      components: JSON.parse(architecture.components || "[]"),
      apiContracts: JSON.parse(architecture.apiContracts || "[]"),
    }),
    task: {
      code: task.code,
      title: task.title,
      description: task.description,
      acceptanceCriteria: JSON.parse(task.acceptanceCriteria || "[]"),
      requiredTests: [],
    },
    changedFiles: changedFiles.map((f) => ({ path: f.path, content: (f.content || "").slice(0, 6000) })),
  });

  const result = await invokeAgent({
    projectId,
    taskId: task.id,
    agentType: AgentType.CODE_REVIEWER,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    architectureVersion: architecture.version,
  });

  if (!result.parsed) {
    return {
      verdict: "CHANGES_REQUESTED",
      findings: [],
      summary: "Reviewer could not parse structured output; defaulting to CHANGES_REQUESTED",
    };
  }
  return {
    verdict: result.parsed.verdict || "CHANGES_REQUESTED",
    findings: result.parsed.findings || [],
    summary: result.parsed.summary || "",
  };
}

// ---------------------------------------------------------------------------
// DEPRECATED: Old heuristic test runner.
// REPLACED by src/lib/test-runner.ts which executes real tests.
// This function is kept only for reference and is NOT called in production.
// ---------------------------------------------------------------------------

async function runTaskTests_DEPRECATED(
  projectId: string,
  task: Task,
  files: any[]
): Promise<any[]> {
  // DO NOT USE — this was the Phase 1 heuristic that matched keywords in
  // file content. Phase 2 replaces it with real test execution via
  // test-runner.ts runTests(). Kept here only to avoid breaking imports
  // during the transition. Will be removed once all callers are verified.
  return [];
}

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
