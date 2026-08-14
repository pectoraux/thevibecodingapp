import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";

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
    const token = getWorkerToken(req);
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
        // Default plan for Node.js projects.
        return {
          runtime: "node",
          packageManager: "npm",
          install: ["npm install --silent"],
          unit: ["npm test -- --json --silent"],
          build: ["npm run build"],
          static: ["npm run lint"],
        };
      })(),

      // P10-1: Base commit SHA for dependent tasks.
      // Resolve from the task graph: find the latest completed dependency's commit.
      baseCommitSha: await (async () => {
        const deps = JSON.parse(task.dependencies || "[]") as string[];
        if (deps.length === 0) return null;

        // Find all completed dependency tasks.
        const depTasks = await db.task.findMany({
          where: {
            projectId: job.projectId,
            code: { in: deps },
            status: "COMPLETED",
            commitSha: { not: null },
          },
          orderBy: { completedAt: "desc" },
        });

        // Return the most recent completed dependency's commit SHA.
        if (depTasks.length > 0 && depTasks[0].commitSha) {
          return depTasks[0].commitSha;
        }

        return null;
      })(),

      // Required capabilities
      requiredCapabilities: JSON.parse(job.requiredCapabilities || "[]"),
    };

    return NextResponse.json({ spec });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
