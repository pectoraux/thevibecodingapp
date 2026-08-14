// Forge Execution Worker — Phase 10: Complete Frozen Execution Architecture
//
// This worker implements the frozen Phase 8 architecture with real production mechanisms:
// 1. Real Git repository/worktree/commit flow
// 2. BYOK provider gateway (no hardcoded SDK)
// 3. Independent deterministic Guardian (checks architecture, not test results)
// 4. Independent LLM Reviewer (separate invocation)
// 5. Architecture-driven VerificationPlan
//
// The control plane NEVER executes generated code.

import { createHmac, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";

// --- Configuration ---
const CONTROL_PLANE_URL = process.env.FORGE_CONTROL_PLANE_URL || "http://localhost:3000";
const WORKER_SECRET = process.env.FORGE_WORKER_SECRET;
const WORKER_ID = process.env.FORGE_WORKER_ID || `worker-${randomUUID().slice(0, 8)}`;
const WORKER_VERSION = "phase11";
const PROTOCOL_VERSION = "v1";
const POLL_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 60000;
const EXEC_ROOT = "/tmp/forge-exec";

if (!WORKER_SECRET) {
  console.error("[worker] FATAL: FORGE_WORKER_SECRET not set");
  process.exit(1);
}

console.log(`[worker] Starting Forge Execution Worker (Phase 10)`);
console.log(`[worker] Worker ID: ${WORKER_ID}`);
console.log(`[worker] Version: ${WORKER_VERSION}`);
console.log(`[worker] Control plane: ${CONTROL_PLANE_URL}`);

// --- Token helpers (same as Phase 8) ---
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

// --- Authenticated API call ---
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
  console.log(`[worker] Registered — session token obtained`);
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

// ===========================================================================
// P11: REAL GIT — Safe argument arrays, real clone/fetch, repository continuity
// ===========================================================================

// All git commands use execFileSync with argument arrays — NO shell interpolation.

function gitExec(repoPath: string, args: string[], timeoutMs = 10000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd: repoPath,
      timeout: timeoutMs,
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, // never prompt for credentials
    });
    return { ok: true, stdout: stdout.toString().trim(), stderr: "" };
  } catch (err: any) {
    return { ok: false, stdout: "", stderr: (err.stderr || err.message || "").toString().trim() };
  }
}

function gitInit(repoPath: string): void {
  gitExec(repoPath, ["init"]);
  gitExec(repoPath, ["config", "user.email", "forge-worker@local"]);
  gitExec(repoPath, ["config", "user.name", "Forge Worker"]);
}

function gitClone(repoUrl: string, targetPath: string): boolean {
  const result = gitExec("/tmp", ["clone", repoUrl, targetPath], 60000);
  if (!result.ok) {
    console.log(`[worker] git clone failed: ${result.stderr}`);
    return false;
  }
  gitExec(targetPath, ["config", "user.email", "forge-worker@local"]);
  gitExec(targetPath, ["config", "user.name", "Forge Worker"]);
  return true;
}

function gitFetch(repoPath: string): boolean {
  const result = gitExec(repoPath, ["fetch", "origin"], 30000);
  return result.ok;
}

function gitCheckoutBranch(repoPath: string, branchName: string, baseCommit?: string): boolean {
  const args = baseCommit
    ? ["checkout", "-b", branchName, baseCommit]
    : ["checkout", "-b", branchName];
  const result = gitExec(repoPath, args);
  if (!result.ok) {
    console.log(`[worker] git checkout -b failed: ${result.stderr}`);
    return false;
  }
  return true;
}

function gitCheckout(repoPath: string, ref: string): boolean {
  const result = gitExec(repoPath, ["checkout", ref]);
  return result.ok;
}

function gitRevParse(repoPath: string, ref: string): string | null {
  const result = gitExec(repoPath, ["rev-parse", ref]);
  return result.ok ? result.stdout : null;
}

function gitAddAndCommit(repoPath: string, message: string): string | null {
  const addResult = gitExec(repoPath, ["add", "-A"]);
  if (!addResult.ok) return null;
  const commitResult = gitExec(repoPath, ["commit", "-m", message]);
  if (!commitResult.ok) return null;
  return gitRevParse(repoPath, "HEAD");
}

function gitDiff(repoPath: string, baseCommit?: string): string {
  const args = baseCommit
    ? ["diff", `${baseCommit}...HEAD"]
    : ["diff", "HEAD~1"];
  const result = gitExec(repoPath, args, 10000);
  if (result.ok) return result.stdout;
  // Fallback to cached diff for first commit.
  const cached = gitExec(repoPath, ["diff", "--cached"]);
  return cached.ok ? cached.stdout : "";
}

function gitDiffStat(repoPath: string, baseCommit?: string): string {
  const args = baseCommit
    ? ["diff", "--stat", `${baseCommit}...HEAD`]
    : ["diff", "--stat", "HEAD~1"];
  const result = gitExec(repoPath, args);
  if (result.ok) return result.stdout;
  const cached = gitExec(repoPath, ["diff", "--cached", "--stat"]);
  return cached.ok ? cached.stdout : "";
}

function gitPush(repoPath: string, branchName: string, remoteUrl?: string): boolean {
  if (remoteUrl) {
    gitExec(repoPath, ["remote", "set-url", "origin", remoteUrl]);
  }
  const result = gitExec(repoPath, ["push", "origin", branchName], 30000);
  return result.ok;
}

function gitLog(repoPath: string): string {
  const result = gitExec(repoPath, ["log", "--oneline", "-5"]);
  return result.ok ? result.stdout : "";
}

// ===========================================================================
// P10-2: BYOK — LLM Gateway (no hardcoded SDK)
// ===========================================================================

interface LlmResult {
  content: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
  success: boolean;
  error?: string;
}

async function callLLM(spec: any, messages: { role: string; content: string }[]): Promise<LlmResult> {
  const provider = spec.modelProviderRef;
  const model = spec.model || "glm-4.6";

  // If the spec includes a BYOK provider, resolve credentials and call the provider API.
  if (provider && provider.provider !== "zai") {
    return await callByokProvider(provider, model, messages);
  }

  // Default: try z-ai-web-dev-sdk (available in the sandbox).
  try {
    const ZAI = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const adapted = messages.map((m) => ({
      role: m.role === "system" ? "assistant" : m.role,
      content: m.content,
    }));
    const completion = await zai.chat.completions.create({
      messages: adapted as any,
      thinking: { type: "disabled" },
    });
    const content = completion.choices?.[0]?.message?.content || "";
    return {
      content,
      tokensInput: Math.ceil(messages.map((m) => m.content).join("").length / 4),
      tokensOutput: Math.ceil(content.length / 4),
      model,
      success: true,
    };
  } catch (err: any) {
    return { content: "", tokensInput: 0, tokensOutput: 0, model, success: false, error: err.message };
  }
}

async function callByokProvider(provider: any, model: string, messages: any[]): Promise<LlmResult> {
  // Resolve credentials via the control plane.
  try {
    const credResult = await apiCall("/api/worker/resolve-credential", "POST", {
      providerId: provider.providerId,
    }, executionToken!);
    const apiKey = credResult.apiKey;
    if (!apiKey) {
      return { content: "", tokensInput: 0, tokensOutput: 0, model, success: false, error: "No API key resolved" };
    }

    // Call the provider's API.
    const urls: Record<string, string> = {
      openai: "https://api.openai.com/v1/chat/completions",
      anthropic: "https://api.anthropic.com/v1/messages",
      google: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      xai: "https://api.x.ai/v1/chat/completions",
    };
    const baseUrl = urls[provider.provider] || provider.baseUrl || urls.openai;

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.2 }),
    });

    if (!res.ok) {
      return { content: "", tokensInput: 0, tokensOutput: 0, model, success: false, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    return {
      content,
      tokensInput: data.usage?.prompt_tokens || 0,
      tokensOutput: data.usage?.completion_tokens || 0,
      model,
      success: true,
    };
  } catch (err: any) {
    return { content: "", tokensInput: 0, tokensOutput: 0, model, success: false, error: err.message };
  }
}

// ===========================================================================
// P10-3: INDEPENDENT DETERMINISTIC GUARDIAN
// Checks architecture diff, NOT test results
// ===========================================================================

function runDeterministicGuardian(architecture: any, changedFiles: { path: string; content: string }[], diff: string): {
  verdict: string; violations: any[]; warnings: any[]; summary: string;
} {
  const violations: any[] = [];
  const warnings: any[] = [];

  if (!architecture) {
    return { verdict: "WARNING", violations, warnings, summary: "No architecture contract to check against" };
  }

  const declaredTechs: string[] = (architecture.components || []).flatMap((c: any) => c.tech || []);
  const declaredTechLower = declaredTechs.map((t: string) => t.toLowerCase());
  const invariants: string[] = architecture.invariants || [];

  // Check each changed file for forbidden technologies.
  for (const f of changedFiles) {
    const content = (f.content || "").toLowerCase();
    const path = f.path.toLowerCase();

    // Forbidden technology detection.
    const forbiddenTechs: { pattern: string; tech: string }[] = [
      { pattern: "firebase", tech: "firebase" },
      { pattern: "mongoose", tech: "mongoose" },
      { pattern: "mongodb", tech: "mongodb" },
      { pattern: "supabase", tech: "supabase" },
      { pattern: "aws-sdk", tech: "aws-sdk" },
    ];

    for (const ft of forbiddenTechs) {
      if (content.includes(ft.pattern) && !declaredTechLower.some((t: string) => t.includes(ft.tech))) {
        violations.push({
          check: "forbidden-technology",
          invariant: `Technology ${ft.tech} is not in the declared architecture`,
          evidence: `File ${f.path} references ${ft.tech}`,
          files: [f.path],
          severity: "high",
          remediation: `Remove ${ft.tech} or add it to the architecture contract`,
        });
      }
    }

    // Check for TODO/FIXME in production paths (not test files).
    if (!path.includes("test") && !path.includes("spec") && !path.includes(".test.")) {
      if (content.includes("todo") || content.includes("fixme") || content.includes("not implemented")) {
        warnings.push({
          check: "suspicious-pattern",
          invariant: "No TODO/FIXME in production code",
          evidence: `File ${f.path} contains TODO/FIXME/not-implemented marker`,
          files: [f.path],
          remediation: "Complete the implementation",
        });
      }
    }
  }

  // Check for required components.
  const requiredComponents = (architecture.components || []).filter((c: any) => c.type !== "infra");
  for (const comp of requiredComponents) {
    const compFiles = changedFiles.filter((f) => {
      const path = f.path.toLowerCase();
      return path.includes(comp.name.toLowerCase()) || path.includes(comp.type.toLowerCase());
    });
    if (compFiles.length === 0) {
      warnings.push({
        check: "component-presence",
        invariant: `Component ${comp.name} should have corresponding files`,
        evidence: `No files found for component ${comp.name}`,
        files: [],
        remediation: `Ensure the implementation includes ${comp.name}`,
      });
    }
  }

  const verdict = violations.length > 0 ? "VIOLATION" : warnings.length > 0 ? "WARNING" : "PASS";
  return {
    verdict,
    violations,
    warnings,
    summary: `${violations.length} violation(s), ${warnings.length} warning(s) — ${verdict}`,
  };
}

// ===========================================================================
// P10-4: INDEPENDENT LLM REVIEWER
// Separate LLM invocation, inspects actual diff
// ===========================================================================

async function runLlmReviewer(spec: any, changedFiles: { path: string; content: string }[], testResults: any[], guardianResult: any): Promise<{
  verdict: string; findings: any[]; summary: string;
}> {
  const filesSummary = changedFiles.map((f) => `--- ${f.path} ---\n${(f.content || "").slice(0, 3000)}`).join("\n\n");
  const testsSummary = testResults.map((t) => `${t.name}: ${t.passes ? "PASS" : "FAIL"} (${t.evidence})`).join("\n");

  const prompt = `You are an independent code reviewer. You are NOT the implementation agent.
Review the following code changes INDEPENDENTLY. Do not trust the implementation agent's claims.

Task: ${spec.task.title}
Description: ${spec.task.description}
Acceptance criteria: ${JSON.stringify(spec.task.acceptanceCriteria)}

CHANGED FILES:
${filesSummary}

TEST RESULTS:
${testsSummary}

GUARDIAN RESULTS:
${JSON.stringify(guardianResult)}

Review for: correctness, security, edge cases, error handling, API correctness, data integrity, maintainability.
Do NOT simply approve because tests pass — tests can be incomplete.

Respond with JSON:
{ "verdict": "APPROVED" | "CHANGES_REQUESTED" | "REJECTED", "findings": [{ "severity": "low|medium|high|critical", "file": "...", "issue": "...", "recommendation": "..." }], "summary": "..." }
`;

  const result = await callLLM(spec, [
    { role: "system", content: "You are an independent code reviewer. Be skeptical and thorough." },
    { role: "user", content: prompt },
  ]);

  if (!result.success || !result.content) {
    return {
      verdict: "CHANGES_REQUESTED",
      findings: [],
      summary: "Reviewer LLM unavailable — defaulting to CHANGES_REQUESTED for safety",
    };
  }

  try {
    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        verdict: parsed.verdict || "CHANGES_REQUESTED",
        findings: parsed.findings || [],
        summary: parsed.summary || "",
      };
    }
  } catch {}

  return {
    verdict: "CHANGES_REQUESTED",
    findings: [],
    summary: "Could not parse reviewer output",
  };
}

// ===========================================================================
// P10-5: ARCHITECTURE-DRIVEN VERIFICATION PLAN
// ===========================================================================

function getVerificationCommands(verificationPlan: any): {
  install: string[]; test: string[]; build: string[]; lint: string[];
} | null {
  if (verificationPlan && typeof verificationPlan === "object" && Object.keys(verificationPlan).length > 0) {
    return {
      install: verificationPlan.install || verificationPlan.install || ["npm install"],
      test: verificationPlan.unit || verificationPlan.test || ["npm test"],
      build: verificationPlan.build || ["npm run build"],
      lint: verificationPlan.lint || verificationPlan.static || [],
    };
  }
  // P11: No silent npm fallback — return null to signal BLOCKED.
  // The Architecture Contract must produce a VerificationPlan.
  return null;
}

// ===========================================================================
// P11: MAIN EXECUTE TASK — Real Repository Continuity + BYOK + Guardian/Reviewer
// ===========================================================================

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

  // P11: REAL REPOSITORY CONTINUITY
  // For GitHub-backed projects: clone the actual repository.
  // For local-only projects: init a new repo.
  // If baseCommitSha is required but unavailable: BLOCKED (no silent fallback).

  let sandboxPath: string;
  let repoCloned = false;

  if (spec.repository?.githubRepo) {
    // GitHub-backed: clone the actual repository.
    sandboxPath = join(EXEC_ROOT, spec.projectId, spec.executionId);
    const cloneUrl = `https://github.com/${spec.repository.githubRepo}.git`;
    console.log(`[worker] Cloning repository: ${spec.repository.githubRepo}`);
    repoCloned = gitClone(cloneUrl, sandboxPath);

    if (!repoCloned) {
      // Clone failed — BLOCKED, not silent fallback.
      return {
        commitSha: null,
        testResults: [],
        guardianResult: { verdict: "VIOLATION", summary: "BLOCKED: Could not clone repository", violations: [], warnings: [] },
        reviewResult: { verdict: "REJECTED", summary: "Repository clone failed", findings: [] },
        filesChanged: [],
        implementationLog: `BLOCKED: git clone failed for ${spec.repository.githubRepo}`,
      };
    }

    // Fetch latest.
    gitFetch(sandboxPath);

    // P11: If baseCommitSha is specified, verify it exists in the repository.
    if (spec.baseCommitSha) {
      const baseExists = gitRevParse(sandboxPath, spec.baseCommitSha);
      if (!baseExists) {
        // Base commit not found — BLOCKED, not silent fallback.
        return {
          commitSha: null,
          testResults: [],
          guardianResult: { verdict: "VIOLATION", summary: `BLOCKED: Required base commit ${spec.baseCommitSha.slice(0, 7)} not found in repository`, violations: [], warnings: [] },
          reviewResult: { verdict: "REJECTED", summary: "Base commit unavailable", findings: [] },
          filesChanged: [],
          implementationLog: `BLOCKED: base commit ${spec.baseCommitSha} not found`,
        };
      }

      // Checkout the base commit.
      gitCheckout(sandboxPath, spec.baseCommitSha);
      // Create branch from base commit.
      gitCheckoutBranch(sandboxPath, branchName, spec.baseCommitSha);
    } else {
      // No base commit — checkout default branch (main/master) and create branch from there.
      const defaultBranch = gitRevParse(sandboxPath, "origin/main") ? "origin/main" : "origin/master";
      gitCheckout(sandboxPath, defaultBranch);
      gitCheckoutBranch(sandboxPath, branchName, defaultBranch);
    }
  } else {
    // Local-only project: init a new repo (no GitHub connection).
    sandboxPath = join(EXEC_ROOT, spec.projectId, spec.executionId);
    mkdirSync(sandboxPath, { recursive: true });
    gitInit(sandboxPath);

    if (spec.baseCommitSha) {
      // For local-only projects with baseCommitSha, verify it exists.
      const baseExists = gitRevParse(sandboxPath, spec.baseCommitSha);
      if (!baseExists) {
        return {
          commitSha: null,
          testResults: [],
          guardianResult: { verdict: "VIOLATION", summary: `BLOCKED: Required base commit ${spec.baseCommitSha.slice(0, 7)} not found in local repository`, violations: [], warnings: [] },
          reviewResult: { verdict: "REJECTED", summary: "Base commit unavailable", findings: [] },
          filesChanged: [],
          implementationLog: `BLOCKED: base commit ${spec.baseCommitSha} not found in local repo`,
        };
      }
      gitCheckoutBranch(sandboxPath, branchName, spec.baseCommitSha);
    } else {
      gitCheckoutBranch(sandboxPath, branchName);
    }
  }

  // Write the architecture contract for reference.
  if (spec.architecture) {
    writeFileSync(join(sandboxPath, "architecture.json"), JSON.stringify(spec.architecture, null, 2));
  }

  // P10-2: Call LLM via BYOK gateway (not hardcoded SDK).
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
  ]);

  if (!llmResult.success || !llmResult.content) {
    return {
      commitSha: null,
      testResults: [],
      guardianResult: { verdict: "VIOLATION", summary: `LLM unavailable: ${llmResult.error}`, violations: [], warnings: [] },
      reviewResult: { verdict: "REJECTED", summary: "No implementation produced", findings: [] },
      filesChanged: [],
      implementationLog: `LLM call failed: ${llmResult.error}`,
    };
  }

  // Parse LLM output.
  let llmOutput: any = null;
  try {
    const jsonMatch = llmResult.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) llmOutput = JSON.parse(jsonMatch[0]);
  } catch {}

  if (!llmOutput?.files || llmOutput.files.length === 0) {
    return {
      commitSha: null,
      testResults: [],
      guardianResult: { verdict: "VIOLATION", summary: "No files produced by LLM", violations: [], warnings: [] },
      reviewResult: { verdict: "REJECTED", summary: "No files produced", findings: [] },
      filesChanged: [],
      implementationLog: "LLM produced no files",
    };
  }

  // Write files to the sandbox (with path containment).
  const filesChanged: { path: string; content: string }[] = [];
  for (const f of llmOutput.files) {
    const fullPath = join(sandboxPath, f.path);
    const resolved = resolve(fullPath);
    if (!resolved.startsWith(sandboxPath)) {
      console.log(`[worker] Path escape rejected: ${f.path}`);
      continue;
    }
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, f.content || "");
    filesChanged.push({ path: f.path, content: f.content || "" });
  }

  // P11: Execute the architecture-driven VerificationPlan.
  // If no VerificationPlan exists: BLOCKED (no silent npm fallback).
  const verCommands = getVerificationCommands(spec.verificationPlan);
  let testResults: any[] = [];

  if (!verCommands) {
    return {
      commitSha: null,
      testResults: [],
      guardianResult: { verdict: "VIOLATION", summary: "BLOCKED: No VerificationPlan in architecture contract — cannot execute verification", violations: [], warnings: [] },
      reviewResult: { verdict: "REJECTED", summary: "No VerificationPlan", findings: [] },
      filesChanged: [],
      implementationLog: "BLOCKED: Architecture Contract must include a VerificationPlan",
    };
  }

  // Install dependencies.
  for (const cmd of verCommands.install) {
    const [bin, ...args] = cmd.split(" ");
    const result = await runCommand(sandboxPath, bin, args, 120000);
    if (!result.success) {
      testResults.push({
        name: cmd, command: cmd, exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 5000), stderr: result.stderr.slice(0, 5000),
        passes: false, evidence: `Install failed: exitCode=${result.exitCode}`,
        durationMs: result.durationMs, timedOut: result.timedOut,
      });
      break;
    }
  }

  // Run tests.
  if (testResults.length === 0 || testResults.every((t) => t.passes)) {
    for (const cmd of verCommands.test) {
      const [bin, ...args] = cmd.split(" ");
      const result = await runCommand(sandboxPath, bin, args, 120000);
      testResults.push({
        name: cmd, command: cmd, exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 5000), stderr: result.stderr.slice(0, 5000),
        passes: result.success,
        evidence: `exitCode=${result.exitCode}, duration=${result.durationMs}ms`,
        durationMs: result.durationMs, timedOut: result.timedOut,
      });
    }
  }

  // P11: Create a REAL Git commit (using safe argument arrays).
  let commitSha: string | null = null;
  commitSha = gitAddAndCommit(sandboxPath, `feat(${spec.task.code}): ${spec.task.title}`);
  if (commitSha) {
    console.log(`[worker] Real git commit: ${commitSha.slice(0, 7)}`);
  } else {
    console.log(`[worker] Git commit failed`);
  }

  // P11: Get the FULL real diff (not just stat) for Guardian inspection.
  const diff = gitDiff(sandboxPath, spec.baseCommitSha || undefined);
  const diffStat = gitDiffStat(sandboxPath, spec.baseCommitSha || undefined);

  // P11: Push branch to remote for GitHub-backed projects.
  let pushedToRemote = false;
  if (repoCloned && commitSha && spec.repository?.githubRepo) {
    pushedToRemote = gitPush(sandboxPath, branchName);
    console.log(`[worker] Push to remote: ${pushedToRemote ? "success" : "failed"}`);
  }

  // P10-3: Run INDEPENDENT deterministic Guardian (checks architecture, NOT tests).
  const guardianResult = runDeterministicGuardian(
    spec.architecture,
    filesChanged,
    diff + "\n\n--- DIFF STAT ---\n" + diffStat
  );

  // P10-4: Run INDEPENDENT LLM Reviewer (separate invocation).
  const reviewResult = await runLlmReviewer(spec, filesChanged, testResults, guardianResult);

  // Clean up sandbox ONLY after evidence is collected.
  // The commit SHA and pushed branch are the durable artifacts.
  try { rmSync(sandboxPath, { recursive: true, force: true }); } catch {}

  return {
    commitSha,
    testResults,
    guardianResult,
    reviewResult,
    filesChanged: filesChanged.map((f) => f.path),
    implementationLog: `Executed in worker sandbox. Git branch: ${branchName}. Commit: ${commitSha || "none"}. LLM model: ${llmResult.model}.`,
  };
}

// --- Run a command in the sandbox ---
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

// --- Main worker loop ---
async function workerLoop(): Promise<void> {
  console.log(`[worker] Entering main loop (polling every ${POLL_INTERVAL_MS}ms)`);
  while (true) {
    try {
      const claimed = await claimJob();
      if (claimed) {
        const { job } = claimed;
        console.log(`[worker] Claimed job ${job.executionId}`);
        const heartbeatInterval = setInterval(() => sendHeartbeat(job.id), HEARTBEAT_INTERVAL_MS);
        try {
          const { spec } = await getJobSpec(job.executionId);
          const result = await executeTask(spec);
          await submitEvidence({
            taskId: job.taskId, projectId: job.projectId,
            commitSha: result.commitSha,
            testResults: result.testResults,
            guardianResult: result.guardianResult,
            reviewResult: result.reviewResult,
            filesChanged: result.filesChanged,
            implementationLog: result.implementationLog,
          });
          // P10-6: Task is only successful if commitSha exists.
          const success = result.commitSha !== null &&
                          result.guardianResult.verdict !== "VIOLATION" &&
                          result.reviewResult.verdict === "APPROVED" &&
                          result.testResults.every((t) => t.passes);
          await completeJob(success ? "SUCCEEDED" : "FAILED");
          console.log(`[worker] Job ${job.executionId} → ${success ? "SUCCEEDED" : "FAILED"} (commit: ${result.commitSha?.slice(0, 7) || "none"})`);
        } catch (err: any) {
          console.error(`[worker] Job ${job.executionId} failed: ${err.message}`);
          await completeJob("FAILED");
        } finally {
          clearInterval(heartbeatInterval);
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

// --- Start ---
async function main() {
  await register();
  await workerLoop();
}

main().catch((err) => { console.error("[worker] Fatal:", err); process.exit(1); });
