// Forge — Phase 18Y: Test capability + repo helpers.
//
// Helpers for constructing a valid ExecutionCapability (with the FULL
// runtimePlan + workloadHash — Phase 18Y) and setting up a real git repo
// for tests that need the supervisor to verify git rev-parse HEAD +
// clean working tree.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  signExecutionCapability,
  deriveWorkloadFromPlan,
  computeWorkloadHash,
  type ExecutionCapability,
  type ExecutionCapabilityInput,
} from "@/lib/execution-capability";
import { hashRuntimePlan, type RuntimeVerificationPlan } from "@/lib/runtime-verification";

// ---------------------------------------------------------------------------
// makeTestPlan — a minimal RuntimeVerificationPlan that the orchestrator can
// execute (install=/bin/echo, build=/bin/echo, start=node server.js, port,
// /health check). Used as cap.runtimePlan.
// ---------------------------------------------------------------------------

/**
 * The plan shape the orchestrator reads from /workspace/plan.json.
 * (Same as OrchestratorPlan in mini-services/execution-worker/runtime/verify.ts.)
 */
export interface TestOrchestratorPlan {
  install: { binary: string; args: string[]; timeoutMs: number };
  build: { binary: string; args: string[]; timeoutMs: number };
  start: {
    binary: string;
    args: string[];
    env?: Record<string, string>;
    timeoutMs: number;
  };
  port: number;
  startupTimeoutMs: number;
  healthChecks: Array<{
    name: string;
    path: string;
    expectedStatus: number;
    timeoutMs: number;
    required: "required" | "optional";
  }>;
  apiJourneys: unknown[];
}

/**
 * Construct a minimal test plan that the orchestrator can execute.
 * The app is expected to be a Node.js HTTP server that listens on `port`
 * and responds 200 on /health.
 */
export function makeTestPlan(port: number = 3000): TestOrchestratorPlan {
  return {
    install: { binary: "/bin/echo", args: ["install-step"], timeoutMs: 10000 },
    build: { binary: "/bin/echo", args: ["build-step"], timeoutMs: 10000 },
    start: {
      binary: "node",
      args: ["/workspace/repo/server.js"],
      env: { PORT: String(port) },
      timeoutMs: 30000,
    },
    port,
    startupTimeoutMs: 10000,
    healthChecks: [
      {
        name: "health",
        path: "/health",
        expectedStatus: 200,
        timeoutMs: 5000,
        required: "required",
      },
    ],
    apiJourneys: [],
  };
}

// ---------------------------------------------------------------------------
// makeTestCapability — sign a valid ExecutionCapability with the FULL plan +
// workloadHash (Phase 18Y).
// ---------------------------------------------------------------------------

export interface MakeTestCapabilityOpts {
  executionId: string;
  nonce: string;
  leaseId: string;
  repositoryHeadSha: string;
  /** Optional — defaults to makeTestPlan(). */
  plan?: TestOrchestratorPlan;
  architectureHash?: string | null;
  /** Optional override — defaults to Date.now() + 5 minutes. */
  expiresAt?: string;
  /** Optional override — if provided, used instead of deriving from plan. */
  runtimePlanHash?: string;
  /** Optional override — if provided, used instead of deriving from plan. */
  workloadHash?: string;
}

/**
 * Sign a valid ExecutionCapability (Phase 18Y) with the FULL runtimePlan +
 * workloadHash. The capability is signed with `controlPlanePrivateKeyPem`.
 *
 * The runtimePlan is the FULL plan object — the supervisor DERIVES the
 * workload from this (binary="node", args=["/workspace/orchestrator.js"],
 * cwd="/workspace/repo") and verifies workloadHash matches.
 */
export function makeTestCapability(
  opts: MakeTestCapabilityOpts,
  controlPlanePrivateKeyPem: string
): ExecutionCapability {
  const plan = opts.plan ?? makeTestPlan();
  // Cast the plan to RuntimeVerificationPlan for hashRuntimePlan. The test
  // plan is structurally compatible (it has the same fields the orchestrator
  // reads). hashRuntimePlan uses canonicalSerialize which sorts keys
  // recursively, so the hash is stable.
  const runtimePlanHash =
    opts.runtimePlanHash ??
    hashRuntimePlan(plan as unknown as RuntimeVerificationPlan);
  const workloadHash =
    opts.workloadHash ??
    computeWorkloadHash(deriveWorkloadFromPlan(plan as unknown as Record<string, unknown>));
  const input: ExecutionCapabilityInput = {
    executionId: opts.executionId,
    nonce: opts.nonce,
    leaseId: opts.leaseId,
    repositoryHeadSha: opts.repositoryHeadSha,
    runtimePlanHash,
    architectureHash: opts.architectureHash ?? null,
    workloadHash,
    runtimePlan: plan as unknown as Record<string, unknown>,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
  return signExecutionCapability(input, controlPlanePrivateKeyPem);
}

// ---------------------------------------------------------------------------
// setupTestRepo — create a real git repo with a server.js, return its SHA.
// ---------------------------------------------------------------------------

/**
 * Create a minimal Node.js HTTP server app at `dir`. Responds 200 OK on
 * /health, 404 on anything else. Initialized as a git repo so we have a
 * real SHA to checkout + verify (Phase 18Y).
 *
 * @param dir        target directory (will be created; cleared if exists).
 * @param portOverride  if provided, the server HARDCODES this port (ignoring
 *                      process.env.PORT). Used for "wrong port" tests.
 */
export function setupTestRepo(dir: string, portOverride?: number): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const port = portOverride ?? 3000;
  const listenLine = portOverride
    ? `server.listen(${portOverride}, "127.0.0.1", () => {`
    : `server.listen(parseInt(process.env.PORT || "3000"), "127.0.0.1", () => {`;
  const serverJs = `const http = require("http");
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("OK"); return; }
  res.writeHead(404); res.end("Not found");
});
${listenLine}
  console.log("SERVER_LISTENING");
});
`;
  writeFileSync(join(dir, "server.js"), serverJs);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "forge-test-app",
    version: "1.0.0",
    scripts: { start: "node server.js" },
  }, null, 2));
  execFileSync("git", ["init"], { cwd: dir, shell: false });
  execFileSync("git", ["config", "user.email", "test@forge"], { cwd: dir, shell: false });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, shell: false });
  execFileSync("git", ["add", "."], { cwd: dir, shell: false });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, shell: false });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir, encoding: "utf-8", shell: false,
  }).trim();
}

/**
 * Phase 18Y: Create a workspace dir + a `repo` subdir inside it containing
 * a real git repo. Returns { workspace, repoPath, sha }.
 *
 * The supervisor computes `workspace = dirname(repoPath)` and writes
 * plan.json + orchestrator.js into it. The substrate bind-mounts
 * `${workspace}` as `/workspace` inside the chroot, so the orchestrator
 * sees `/workspace/plan.json`, `/workspace/orchestrator.js`,
 * `/workspace/repo/server.js`, `/workspace/results.json`.
 *
 * Tests that POST directly to /execute (without going through
 * executeRuntimeVerificationInWorker) MUST use this helper — passing a
 * bare repoPath (not inside a workspace dir) would cause the supervisor
 * to write plan.json + orchestrator.js into the parent of repoPath (e.g.,
 * `/tmp`), which is wrong.
 */
export function setupTestWorkspace(prefix: string, portOverride?: number): {
  workspace: string;
  repoPath: string;
  sha: string;
} {
  const workspace = `/tmp/forge-ws-${prefix}-${randomUUID()}`;
  mkdirSync(workspace, { recursive: true });
  const repoPath = join(workspace, "repo");
  const sha = setupTestRepo(repoPath, portOverride);
  return { workspace, repoPath, sha };
}

/**
 * Create a crashing app (exits immediately with code 1) for testing the
 * "failed app still produces valid attestation" path.
 */
export function setupCrashingRepo(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "server.js"), `process.stderr.write("CRASHING_ON_PURPOSE\\n"); process.exit(1);`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "forge-test-crash-app",
    version: "1.0.0",
    scripts: { start: "node server.js" },
  }, null, 2));
  execFileSync("git", ["init"], { cwd: dir, shell: false });
  execFileSync("git", ["config", "user.email", "test@forge"], { cwd: dir, shell: false });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, shell: false });
  execFileSync("git", ["add", "."], { cwd: dir, shell: false });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, shell: false });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir, encoding: "utf-8", shell: false,
  }).trim();
}

/**
 * Generate a random nonce (UUID) — convenience for tests that need a
 * unique nonce per execution.
 */
export function testNonce(): string {
  return randomUUID();
}
