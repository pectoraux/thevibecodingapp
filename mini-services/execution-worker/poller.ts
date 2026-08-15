// Forge Execution Worker — Phase 11A: Modular Worker
//
// This is a THIN orchestration layer. All execution logic lives in modules:
//   git/repository.ts — safe git operations (execFileSync, no shell interpolation)
//   llm/gateway.ts — BYOK provider abstraction (OpenAI, Anthropic, Google, xAI, zai)
//   verification/index.ts — VerificationPlan, deterministic Guardian, LLM Reviewer
//
// The poller only: registers, polls, claims, executes, reports.

import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { gitInit, gitClone, gitFetch, gitCheckoutBranch, gitCheckout, gitRevParse, gitAddAndCommit, gitDiff, gitDiffStat, gitPush, gitExec } from "./git/repository.js";
import { callLLM } from "./llm/gateway.js";
import { getVerificationCommands, runDeterministicGuardian, runLlmReviewer, runSemanticGuardian } from "./verification/index.js";

// --- Configuration ---
const CONTROL_PLANE_URL = process.env.FORGE_CONTROL_PLANE_URL || "http://localhost:3000";
const WORKER_SECRET = process.env.FORGE_WORKER_SECRET;
const WORKER_ID = process.env.FORGE_WORKER_ID || `worker-${randomUUID().slice(0, 8)}`;
const WORKER_VERSION = "phase15e";
const PROTOCOL_VERSION = "v1";
const POLL_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 60000;
const EXEC_ROOT = "/tmp/forge-exec";

if (!WORKER_SECRET) {
  console.error("[worker] FATAL: FORGE_WORKER_SECRET not set");
  process.exit(1);
}

console.log(`[worker] Starting Forge Execution Worker (${WORKER_VERSION})`);

// --- Token helpers ---
function signToken(payload: any): string {
  const data = [
    payload.iss, payload.aud, payload.workerId,
    payload.executionId || "", payload.leaseId || "", payload.projectId || "",
    JSON.stringify(payload.capabilities), payload.iat, payload.exp, payload.nonce,
  ].join(".");
  return createHmac("sha256", WORKER_SECRET).update(data).digest("hex");
}

function createRegToken(): string {
  const now = Date.now();
  const payload = {
    iss: "forge-worker", aud: "forge-control-plane", workerId: WORKER_ID,
    capabilities: ["node", "git", "test", "build"],
    iat: now, exp: now + 60000, nonce: randomUUID(),
  };
  return `Bearer ${Buffer.from(JSON.stringify({ ...payload, signature: signToken(payload) })).toString("base64")}`;
}

let sessionToken: string | null = null;
let executionToken: string | null = null;

// --- API client ---
async function apiCall(path: string, method: string, body?: any, token?: string): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = token;
  const res = await fetch(`${CONTROL_PLANE_URL}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// --- Worker API functions ---
async function register(): Promise<void> {
  const result = await apiCall("/api/worker/register", "POST", {
    workerVersion: WORKER_VERSION, protocolVersion: PROTOCOL_VERSION,
    capabilities: ["node", "git", "test", "build"], maxConcurrency: 1,
  }, createRegToken());
  sessionToken = result.sessionToken;
  console.log(`[worker] Registered`);
}

async function claimJob(): Promise<{ job: any; executionToken: string } | null> {
  const result = await apiCall("/api/worker/claim", "POST", {}, sessionToken!);
  if (result.job) {
    executionToken = result.executionToken;
    return { job: result.job, executionToken: result.executionToken };
  }
  return null;
}

async function getJobSpec(executionId: string): Promise<any> {
  return apiCall("/api/worker/job-spec", "POST", { executionId }, executionToken!);
}

async function submitEvidence(data: any): Promise<any> {
  return apiCall("/api/worker/submit-evidence", "POST", data, executionToken!);
}

async function completeJob(status: string): Promise<void> {
  await apiCall("/api/worker/complete", "POST", { status }, executionToken!);
}

async function sendHeartbeat(jobId: string): Promise<void> {
  try { await apiCall("/api/worker/heartbeat", "POST", { jobId }, executionToken!); } catch {}
}

async function triggerSchedulerTick(): Promise<void> {
  try { await apiCall("/api/scheduler/tick", "POST", {}, sessionToken!); } catch {}
}

// --- Execute a command in the sandbox ---
function runCommand(cwd: string, command: string, args: string[], timeoutMs: number): Promise<{
  exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean; success: boolean;
}> {
  return new Promise((resolve) => {
    let stdout = ""; let stderr = ""; let timedOut = false;
    const start = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: "/tmp" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => { stdout += d.toString(); if (stdout.length > 200000) stdout = stdout.slice(-200000); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-200000); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: stdout.slice(0, 100000), stderr: stderr.slice(0, 100000), durationMs: Date.now() - start, timedOut, success: !timedOut && code === 0 });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + "\nCommand not found", durationMs: Date.now() - start, timedOut, success: false });
    });
  });
}

// --- MAIN EXECUTE TASK ---
async function executeTask(spec: any): Promise<{
  commitSha: string | null;
  testResults: any[];
  guardianResult: any;
  reviewResult: any;
  filesChanged: string[];
  implementationLog: string;
}> {
  console.log(`[worker] Executing task ${spec.task.code} (${spec.executionId})`);

  const branchName = `forge/${spec.task.code}/attempt-${spec.attempt}`;

  // --- Repository continuity ---
  let sandboxPath: string;
  let repoCloned = false;
  let githubToken: string | null = null;

  if (spec.repository?.githubRepo) {
    sandboxPath = join(EXEC_ROOT, spec.projectId, spec.executionId);

    // P12: Authenticated clone — resolve GitHub credential from control plane.
    // NO anonymous fallback — BLOCKED if credential resolution fails.
    try {
      const credResult = await apiCall("/api/worker/resolve-github-credential", "POST", {
        projectId: spec.projectId,
      }, executionToken);
      githubToken = credResult.token;
    } catch (err: any) {
      // P12: No anonymous fallback for GitHub-backed projects.
      return blocked(
        "GitHub credential unavailable — cannot clone repository",
        `Credential resolution failed: ${err.message}`
      );
    }

    if (!githubToken) {
      // P12: No token = BLOCKED, not anonymous.
      return blocked(
        "GitHub credential unavailable — cannot clone repository",
        "No token returned from resolve-github-credential"
      );
    }

    // Build authenticated clone URL (token is never stored in .git/config permanently).
    const repoSlug = spec.repository.githubRepo;
    const cloneUrl = `https://x-access-token:${githubToken}@github.com/${repoSlug}.git`;
    console.log(`[worker] Cloning: ${repoSlug} (authenticated)`);
    repoCloned = gitClone(cloneUrl, sandboxPath);

    // After clone, remove the credential from .git/config for security.
    if (repoCloned) {
      gitExec(sandboxPath, ["remote", "set-url", "origin", `https://github.com/${repoSlug}.git`]);
    }

    if (!repoCloned) {
      return blocked("Could not clone repository", `git clone failed for ${repoSlug}`);
    }

    gitFetch(sandboxPath);

    if (spec.baseCommitSha) {
      const baseExists = gitRevParse(sandboxPath, spec.baseCommitSha);
      if (!baseExists) {
        return blocked(`Base commit ${spec.baseCommitSha.slice(0, 7)} not found`, `base commit ${spec.baseCommitSha} not found`);
      }
      gitCheckout(sandboxPath, spec.baseCommitSha);
      gitCheckoutBranch(sandboxPath, branchName, spec.baseCommitSha);
    } else {
      const defaultBranch = gitRevParse(sandboxPath, "origin/main") ? "origin/main" : "origin/master";
      gitCheckout(sandboxPath, defaultBranch);
      gitCheckoutBranch(sandboxPath, branchName, defaultBranch);
    }
  } else {
    sandboxPath = join(EXEC_ROOT, spec.projectId, spec.executionId);
    mkdirSync(sandboxPath, { recursive: true });
    gitInit(sandboxPath);

    if (spec.baseCommitSha) {
      const baseExists = gitRevParse(sandboxPath, spec.baseCommitSha);
      if (!baseExists) {
        return blocked(`Base commit ${spec.baseCommitSha.slice(0, 7)} not found in local repo`, `base commit ${spec.baseCommitSha} not found in local repo`);
      }
      gitCheckoutBranch(sandboxPath, branchName, spec.baseCommitSha);
    } else {
      gitCheckoutBranch(sandboxPath, branchName);
    }
  }

  if (spec.architecture) {
    writeFileSync(join(sandboxPath, "architecture.json"), JSON.stringify(spec.architecture, null, 2));
  }

  // --- LLM call via BYOK gateway ---
  const implPrompt = `You are a ${spec.task.agentType} implementation agent.
Task: ${spec.task.title}
Description: ${spec.task.description}
Acceptance criteria: ${JSON.stringify(spec.task.acceptanceCriteria)}
Architecture constraints: ${JSON.stringify(spec.architecture?.constraints || [])}

Generate the implementation files. Respond with ONLY JSON:
{ "files": [{ "path": "...", "content": "...", "language": "..." }] }
`;

  const llmResult = await callLLM(spec, [
    { role: "system", content: "You are a code generation agent. Generate real, working code." },
    { role: "user", content: implPrompt },
  ], apiCall, executionToken);

  if (!llmResult.success || !llmResult.content) {
    return blocked(`LLM unavailable: ${llmResult.error}`, `LLM call failed: ${llmResult.error}`);
  }

  let llmOutput: any = null;
  try {
    const jsonMatch = llmResult.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) llmOutput = JSON.parse(jsonMatch[0]);
  } catch {}

  if (!llmOutput?.files || llmOutput.files.length === 0) {
    return blocked("No files produced by LLM", "LLM produced no files");
  }

  // --- Write files ---
  const filesChanged: { path: string; content: string }[] = [];
  for (const f of llmOutput.files) {
    const fullPath = join(sandboxPath, f.path);
    const resolved = resolve(fullPath);
    if (!resolved.startsWith(sandboxPath)) continue;
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, f.content || "");
    filesChanged.push({ path: f.path, content: f.content || "" });
  }

  // --- P14: Full VerificationPlan execution (install, static, unit, build) ---
  const verCommands = getVerificationCommands(spec.verificationPlan);
  if (!verCommands) {
    return blocked("No VerificationPlan in architecture contract", "Architecture Contract must include a VerificationPlan");
  }

  let testResults: any[] = [];
  let verificationFailed = false;

  // Execute each verification phase. All required phases must pass.
  const phases: { name: string; commands: string[]; phase: string }[] = [
    { name: "install", commands: verCommands.install, phase: "install" },
    { name: "static", commands: verCommands.lint, phase: "static" },
    { name: "unit", commands: verCommands.test, phase: "unit" },
    { name: "build", commands: verCommands.build, phase: "build" },
  ];

  for (const phase of phases) {
    for (const cmd of phase.commands) {
      const [bin, ...args] = cmd.split(" ");
      const result = await runCommand(sandboxPath, bin, args, 120000);
      testResults.push({
        name: cmd, command: cmd, phase: phase.phase,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 5000), stderr: result.stderr.slice(0, 5000),
        passes: result.success,
        evidence: `exitCode=${result.exitCode}, duration=${result.durationMs}ms`,
        durationMs: result.durationMs, timedOut: result.timedOut,
      });
      if (!result.success) {
        verificationFailed = true;
        console.log(`[worker] Verification phase '${phase.phase}' FAILED: ${cmd}`);
        break;
      }
    }
    if (verificationFailed) break;
  }

  // P14: If any verification phase fails, don't commit or push.
  if (verificationFailed) {
    return {
      commitSha: null,
      testResults,
      guardianResult: { verdict: "VIOLATION", summary: "VerificationPlan phase failed — cannot proceed", violations: [], warnings: [] },
      reviewResult: { verdict: "REJECTED", summary: "Verification failed", findings: [] },
      filesChanged: filesChanged.map((f) => f.path),
      pushedToRemote: false,
      branchName: null,
      implementationLog: `BLOCKED: VerificationPlan phase failed`,
    };
  }

  // --- P13: Candidate commit (local only — NOT pushed yet) ---
  let commitSha: string | null = gitAddAndCommit(sandboxPath, `feat(${spec.task.code}): ${spec.task.title}`);
  if (commitSha) {
    console.log(`[worker] Candidate commit: ${commitSha.slice(0, 7)}`);
  }

  // --- Full diff for Guardian ---
  const diff = gitDiff(sandboxPath, spec.baseCommitSha || undefined);
  const diffStat = gitDiffStat(sandboxPath, spec.baseCommitSha || undefined);

  // --- P13: Deterministic Guardian (Layer 1) — BEFORE push ---
  const deterministicGuardianResult = runDeterministicGuardian(
    spec.architecture, filesChanged, diff + "\n\n--- DIFF STAT ---\n" + diffStat
  );

  // --- P13: Semantic Architecture Guardian (Layer 2) — BEFORE push ---
  const semanticGuardianResult = await runSemanticGuardian(
    spec, filesChanged, diff, deterministicGuardianResult, apiCall, executionToken
  );

  // P13: Combined Guardian — UNVERIFIED blocks (fail-closed).
  // VIOLATION or UNVERIFIED or ARCHITECTURE_CHANGE_REQUIRED from either = block.
  const blockVerdicts = ["VIOLATION", "UNVERIFIED", "ARCHITECTURE_CHANGE_REQUIRED"];
  const guardianResult = {
    deterministic: deterministicGuardianResult,
    semantic: semanticGuardianResult,
    verdict: blockVerdicts.includes(deterministicGuardianResult.verdict) || blockVerdicts.includes(semanticGuardianResult.verdict)
      ? (semanticGuardianResult.verdict === "UNVERIFIED" ? "UNVERIFIED"
        : deterministicGuardianResult.verdict === "VIOLATION" || semanticGuardianResult.verdict === "VIOLATION" ? "VIOLATION"
        : "ARCHITECTURE_CHANGE_REQUIRED")
      : deterministicGuardianResult.verdict === "WARNING" || semanticGuardianResult.verdict === "WARNING"
      ? "WARNING"
      : "PASS",
    summary: `Deterministic: ${deterministicGuardianResult.summary} | Semantic: ${semanticGuardianResult.summary}`,
  };

  // --- P13: Independent Reviewer — BEFORE push ---
  const reviewResult = await runLlmReviewer(spec, filesChanged, testResults, guardianResult, apiCall, executionToken);

  // --- P13: Push ONLY if verification passes (candidate → verified) ---
  let pushedToRemote = false;
  const guardianOk = guardianResult.verdict === "PASS" || guardianResult.verdict === "WARNING";
  const reviewOk = reviewResult.verdict === "APPROVED";
  const testsOk = testResults.length > 0 && testResults.every((t) => t.passes);

  if (commitSha && guardianOk && reviewOk && testsOk) {
    // Only push verified candidates to remote.
    if (repoCloned && spec.repository?.githubRepo) {
      const pushUrl = `https://x-access-token:${githubToken}@github.com/${spec.repository.githubRepo}.git`;
      pushedToRemote = gitPush(sandboxPath, branchName, pushUrl);
      if (githubToken) {
        gitExec(sandboxPath, ["remote", "set-url", "origin", `https://github.com/${spec.repository.githubRepo}.git`]);
      }
      console.log(`[worker] Push verified candidate: ${pushedToRemote ? "success" : "failed"}`);
    }
  } else {
    console.log(`[worker] Candidate NOT pushed — verification failed (guardian=${guardianResult.verdict}, review=${reviewResult.verdict}, tests=${testsOk})`);
  }

  // --- Cleanup (after evidence collected) ---
  try { rmSync(sandboxPath, { recursive: true, force: true }); } catch {}

  return {
    commitSha,
    testResults,
    guardianResult,
    reviewResult,
    filesChanged: filesChanged.map((f) => f.path),
    pushedToRemote,
    branchName,
    implementationLog: `Executed in sandbox. Branch: ${branchName}. Commit: ${commitSha?.slice(0, 7) || "none"}. Pushed: ${pushedToRemote}. Deterministic: ${deterministicGuardianResult.verdict}. Semantic: ${semanticGuardianResult.verdict}.`,
  };
}

function blocked(summary: string, log: string): any {
  console.log(`[worker] BLOCKED: ${summary}`);
  return {
    commitSha: null,
    testResults: [],
    guardianResult: { verdict: "VIOLATION", summary: `BLOCKED: ${summary}`, violations: [], warnings: [] },
    reviewResult: { verdict: "REJECTED", summary: summary, findings: [] },
    filesChanged: [],
    pushedToRemote: false,
    branchName: null,
    implementationLog: `BLOCKED: ${log}`,
  };
}

// --- Main worker loop ---
async function workerLoop(): Promise<void> {
  console.log(`[worker] Polling every ${POLL_INTERVAL_MS}ms`);
  while (true) {
    try {
      const claimed = await claimJob();
      if (claimed) {
        const { job } = claimed;
        console.log(`[worker] Claimed: ${job.executionId}`);
        const hb = setInterval(() => sendHeartbeat(job.id), HEARTBEAT_INTERVAL_MS);
        try {
          const { spec } = await getJobSpec(job.executionId);
          const result = await executeTask(spec);

          // P15: The control plane's submit-evidence is the CANONICAL authority.
          // It uses canCompleteTask() with remote verification.
          // The worker uses the response from submit-evidence, not its own check.
          const evidenceResponse = await submitEvidence({
            commitSha: result.commitSha,
            pushedToRemote: result.pushedToRemote || false,
            testResults: result.testResults,
            guardianResult: result.guardianResult,
            reviewResult: result.reviewResult,
            filesChanged: result.filesChanged,
            implementationLog: result.implementationLog,
          });

          // P15: Use the control plane's canonical decision.
          const success = evidenceResponse.success;
          await completeJob(success ? "SUCCEEDED" : "FAILED");
          console.log(`[worker] ${job.executionId} → ${success ? "SUCCEEDED" : "FAILED"}${evidenceResponse.failureReason ? ` (${evidenceResponse.failureReason})` : ""}`);
        } catch (err: any) {
          console.error(`[worker] ${job.executionId} failed: ${err.message}`);
          await completeJob("FAILED");
        } finally {
          clearInterval(hb);
        }
      } else {
        await triggerSchedulerTick();
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err: any) {
      console.error(`[worker] Loop error: ${err.message}`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

async function main() {
  await register();
  await workerLoop();
}

main().catch((err) => { console.error("[worker] Fatal:", err); process.exit(1); });
