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
import { executeRuntimeVerificationInWorker, generateSubstrateNonce, type OrchestratorPlan, type RuntimeVerificationJob } from "./runtime/verify.js";

// --- Configuration ---
const CONTROL_PLANE_URL = process.env.FORGE_CONTROL_PLANE_URL || "http://localhost:3000";
const WORKER_SECRET = process.env.FORGE_WORKER_SECRET; // Bootstrap only (Phase 18P).
const WORKER_VERSION = "phase16d";
const PROTOCOL_VERSION = "v1";
const POLL_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 60000;
const EXEC_ROOT = "/tmp/forge-exec";

// Phase 18P: Control-plane public key for verifying session/execution tokens.
// The control plane signs tokens with its PRIVATE key; the worker verifies
// with this PUBLIC key. A worker with FORGE_WORKER_SECRET can NO LONGER forge
// control-plane tokens — it doesn't have the control-plane private key.
const CONTROL_PLANE_PUBLIC_KEY = process.env.FORGE_CONTROL_PLANE_PUBLIC_KEY;

// Phase 18M: Worker identity must be STABLE across restarts.
// In production (NODE_ENV=production), FORGE_WORKER_ID is REQUIRED.
// No random fallback — a random ID means a new identity on every restart,
// which breaks the Ed25519 trust model.
const isProduction = process.env.NODE_ENV === "production";

let WORKER_ID: string;
if (process.env.FORGE_WORKER_ID) {
  WORKER_ID = process.env.FORGE_WORKER_ID;
} else if (isProduction) {
  console.error("[worker] FATAL: FORGE_WORKER_ID is required in production. A random worker ID is not durable and breaks the Ed25519 trust model.");
  process.exit(1);
} else {
  // Development only — random ID is acceptable for local dev/testing.
  WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;
  console.warn(`[worker] WARNING: FORGE_WORKER_ID not set — using ephemeral ID '${WORKER_ID}'. This is NOT safe for production. Key persistence will not survive restart with a different ID.`);
}

if (!WORKER_SECRET) {
  console.error("[worker] FATAL: FORGE_WORKER_SECRET not set (required for bootstrap registration)");
  process.exit(1);
}

// Phase 18P: In production, control-plane public key is REQUIRED for verifying
// session/execution tokens. Without it, the worker cannot verify that tokens
// were issued by the control plane (not forged by another worker).
if (isProduction && !CONTROL_PLANE_PUBLIC_KEY) {
  console.error("[worker] FATAL: FORGE_CONTROL_PLANE_PUBLIC_KEY is required in production. The worker must verify control-plane tokens with the control-plane's public key.");
  process.exit(1);
}

console.log(`[worker] Starting Forge Execution Worker (${WORKER_VERSION})`);

// --- Token helpers ---
// Phase 18P: Worker tokens include tokenType + signatureAlgorithm.
// Registration tokens use HMAC (bootstrap only).
// Session/execution tokens are verified with the control-plane Ed25519 public key.
function signToken(payload: any): string {
  const data = [
    payload.tokenType, payload.iss, payload.aud, payload.workerId,
    payload.executionId || "", payload.leaseId || "", payload.projectId || "",
    JSON.stringify(payload.capabilities), payload.iat, payload.exp, payload.nonce,
    payload.signatureAlgorithm || "hmac",
  ].join(".");
  return createHmac("sha256", WORKER_SECRET).update(data).digest("hex");
}

function createRegToken(): string {
  const now = Date.now();
  const payload = {
    tokenType: "REGISTRATION" as const,
    iss: "forge-worker", aud: "forge-control-plane", workerId: WORKER_ID,
    capabilities: ["node", "git", "test", "build"],
    iat: now, exp: now + 60000, nonce: randomUUID(),
    signatureAlgorithm: "hmac" as const, // Bootstrap: HMAC only for first registration.
  };
  return `Bearer ${Buffer.from(JSON.stringify({ ...payload, signature: signToken(payload) })).toString("base64")}`;
}

// Phase 18M: Worker Ed25519 keypair for evidence signing — DURABLE across restarts.
// The key is persisted to disk so the worker identity survives process restarts.
// Without this, every restart generates a new key, but the control plane treats
// the key as immutable — the worker would be permanently locked out after restart.
//
// Phase 18M hardening:
//   - Production requires FORGE_WORKER_KEY_DIR (not /tmp fallback).
//   - Corrupted key file is FATAL (not silent regeneration).
//   - Existing key file permissions are validated (must be 0o600).
//   - Phase 18N: Directory permissions validated (must be 0o700).
//   - Phase 18N: Key file opened with O_NOFOLLOW to prevent symlink substitution (TOCTOU).
import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";

let workerPrivateKeyPem: string | null = null;
let workerPublicKeyPem: string | null = null;

// Phase 18M: In production, FORGE_WORKER_KEY_DIR is REQUIRED.
// /tmp is not durable storage — it can be cleared on reboot/redeploy.
const WORKER_KEY_DIR = process.env.FORGE_WORKER_KEY_DIR || "/tmp/forge-worker-keys";
if (isProduction && !process.env.FORGE_WORKER_KEY_DIR) {
  console.error("[worker] FATAL: FORGE_WORKER_KEY_DIR is required in production. /tmp is not durable storage for cryptographic identity.");
  process.exit(1);
}

// Deterministic key file path based on worker ID.
const WORKER_KEY_PATH = `${WORKER_KEY_DIR}/${WORKER_ID}.pem`;

function loadOrGenerateWorkerKeypair(): void {
  // Phase 18N: Validate directory permissions before any file operations.
  const keyDir = dirname(WORKER_KEY_PATH);
  if (existsSync(keyDir)) {
    const dirStat = statSync(keyDir);
    const dirMode = dirStat.mode & 0o777;
    if (dirMode !== 0o700) {
      console.error(`[worker] FATAL: Key directory ${keyDir} has insecure permissions (${dirMode.toString(8)}). Expected 0o700 (owner access only).`);
      process.exit(1);
    }
    if (!dirStat.isDirectory()) {
      console.error(`[worker] FATAL: Key directory path ${keyDir} is not a directory.`);
      process.exit(1);
    }
  }

  // Phase 18N: Try to load existing key using O_NOFOLLOW to prevent symlink substitution.
  if (existsSync(WORKER_KEY_PATH)) {
    // Phase 18M: Validate file permissions before loading.
    const stat = statSync(WORKER_KEY_PATH);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      console.error(`[worker] FATAL: Key file ${WORKER_KEY_PATH} has insecure permissions (${mode.toString(8)}). Expected 0o600 (owner read/write only).`);
      console.error("[worker] Refusing to load insecure key file. Fix permissions or remove the file and use /api/worker/rotate-key to establish a new identity.");
      process.exit(1);
    }
    // Phase 18N: Reject symlinks — key file must be a regular file.
    if (!stat.isFile()) {
      console.error(`[worker] FATAL: Key file ${WORKER_KEY_PATH} is not a regular file (possibly a symlink). Refusing to load.`);
      process.exit(1);
    }

    try {
      // Phase 18O: Open with O_NOFOLLOW to prevent TOCTOU symlink race.
      // Use numeric flags: O_RDONLY (0) | O_NOFOLLOW (0o400000 on Linux).
      // Then read FROM the fd — not from the path again — to eliminate the race.
      const O_NOFOLLOW = 0o400000; // Linux: prevent following symlinks on open.
      const fd = openSync(WORKER_KEY_PATH, O_NOFOLLOW, 0o600);
      // Read from the file descriptor, NOT from the path.
      // This ensures we read the exact object that was opened, not a potentially
      // swapped path target between statSync and readFileSync.
      const fileContent = readFileSync(fd, "utf-8");
      closeSync(fd);
      const keyData = JSON.parse(fileContent);
      if (!keyData.privateKeyPem || !keyData.publicKeyPem) {
        throw new Error("Key file is missing required fields (privateKeyPem or publicKeyPem)");
      }
      workerPrivateKeyPem = keyData.privateKeyPem;
      workerPublicKeyPem = keyData.publicKeyPem;
      console.log(`[worker] Loaded existing Ed25519 keypair from ${WORKER_KEY_PATH}`);
      return;
    } catch (err: any) {
      console.error(`[worker] FATAL: Failed to load keypair from ${WORKER_KEY_PATH}: ${err.message}`);
      console.error("[worker] Corrupted key file detected. This is an identity-integrity error.");
      console.error("[worker] To recover: fix the key file, or use /api/worker/rotate-key to establish a new identity through the rotation protocol.");
      console.error("[worker] Refusing to generate a new identity silently — this would break the trust anchor.");
      process.exit(1);
    }
  }

  // No existing key — generate a new one and persist it.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  workerPrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  workerPublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  // Persist to disk so the key survives restarts.
  try {
    // Phase 18N: Create directory with 0o700 (owner access only).
    mkdirSync(dirname(WORKER_KEY_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(WORKER_KEY_PATH, JSON.stringify({
      privateKeyPem: workerPrivateKeyPem,
      publicKeyPem: workerPublicKeyPem,
    }, null, 2), { mode: 0o600 }); // Owner read/write only.
    console.log(`[worker] Generated and persisted new Ed25519 keypair to ${WORKER_KEY_PATH}`);
  } catch (err: any) {
    console.error(`[worker] FATAL: Failed to persist keypair to ${WORKER_KEY_PATH}: ${err.message}`);
    console.error("[worker] Worker identity will NOT survive restart. Refusing to start with ephemeral identity.");
    if (isProduction) {
      process.exit(1);
    } else {
      console.warn("[worker] (development mode — continuing with ephemeral key)");
    }
  }
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
  // Phase 18L: Load or generate DURABLE Ed25519 keypair (survives restart).
  loadOrGenerateWorkerKeypair();

  // Phase 18T: Sign enrollment or re-registration challenge with Ed25519 private key.
  // For FIRST registration: sign "FORGE_ENROLLMENT:{workerId}:{enrollmentSecret}"
  // For RE-registration (restart): fetch server-issued challenge, sign it.
  const enrollmentSecret = process.env.FORGE_WORKER_ENROLLMENT_SECRET;
  let enrollmentSignature: string | undefined;
  let reregisterChallenge: string | undefined;
  let reregisterNonce: string | undefined;

  if (workerPrivateKeyPem) {
    if (enrollmentSecret) {
      // First registration — sign enrollment challenge.
      const challenge = `FORGE_ENROLLMENT:${WORKER_ID}:${enrollmentSecret}`;
      enrollmentSignature = cryptoSign(null, Buffer.from(challenge, "utf-8"), workerPrivateKeyPem).toString("hex");
    } else {
      // Phase 18T: Re-registration (restart) — fetch server-issued challenge.
      try {
        const challengeRes = await apiCall("/api/worker/challenge", "POST", {}, createRegToken());
        reregisterChallenge = challengeRes.challenge;
        reregisterNonce = challengeRes.nonce;
        enrollmentSignature = cryptoSign(null, Buffer.from(reregisterChallenge, "utf-8"), workerPrivateKeyPem).toString("hex");
      } catch (err: any) {
        console.error(`[worker] Failed to get re-registration challenge: ${err.message}`);
        // If challenge endpoint fails, try first-registration path (may be initial setup).
        const fallbackChallenge = `FORGE_ENROLLMENT:${WORKER_ID}:${""}`;
        enrollmentSignature = cryptoSign(null, Buffer.from(fallbackChallenge, "utf-8"), workerPrivateKeyPem).toString("hex");
      }
    }
  }

  const result = await apiCall("/api/worker/register", "POST", {
    workerVersion: WORKER_VERSION, protocolVersion: PROTOCOL_VERSION,
    capabilities: ["node", "git", "test", "build"], maxConcurrency: 1,
    publicKeyPem: workerPublicKeyPem,
    enrollmentSecret,
    enrollmentSignature,
    reregisterChallenge,
    reregisterNonce,
  }, createRegToken());
  sessionToken = result.sessionToken;
  console.log(`[worker] Registered (with Ed25519 public key + enrollment proof)`);
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

// Phase 18O: Worker signs task evidence with Ed25519 private key.
// The signature binds BOTH the evidence AND the execution identity
// (workerId, executionId, leaseId) into the signed commitment.
// This prevents evidence replay across different executions.
function signTaskEvidence(data: any, executionContext: { workerId: string; executionId: string; leaseId: string }): { signature: string; evidenceHash: string } | null {
  if (!workerPrivateKeyPem) {
    console.warn("[worker] No Ed25519 private key — evidence will be unsigned (development mode)");
    return null;
  }
  // Phase 18O: The signed envelope includes execution identity + evidence.
  // This binds the evidence to a specific execution, preventing replay.
  const envelope = {
    evidence: data,
    executionId: executionContext.executionId,
    leaseId: executionContext.leaseId,
    workerId: executionContext.workerId,
  };
  const canonical = JSON.stringify(envelope, Object.keys(envelope).sort());
  const evidenceHash = createHash("sha256").update(canonical).digest("hex");
  const signature = cryptoSign(null, Buffer.from(evidenceHash, "utf-8"), workerPrivateKeyPem).toString("hex");
  return { signature, evidenceHash };
}

async function submitEvidence(data: any): Promise<any> {
  // Phase 18O: Sign the evidence WITH execution identity binding.
  // Extract execution identity from the execution token (parsed from the HMAC token).
  // The token contains executionId and leaseId; workerId is WORKER_ID.
  let executionId = "";
  let leaseId = "";
  // Parse the execution token to extract executionId and leaseId.
  if (executionToken) {
    try {
      const tokenStr = executionToken.replace("Bearer ", "");
      const token = JSON.parse(Buffer.from(tokenStr, "base64").toString("utf-8"));
      executionId = token.executionId || "";
      leaseId = token.leaseId || "";
    } catch {}
  }

  const sig = signTaskEvidence(data, { workerId: WORKER_ID, executionId, leaseId });
  const body: any = { ...data };
  if (sig) {
    body.evidenceSignature = sig.signature;
    body.evidenceHash = sig.evidenceHash;
    body.signedBy = WORKER_ID;
    body.signedExecutionId = executionId;
    body.signedLeaseId = leaseId;
  }
  return apiCall("/api/worker/submit-evidence", "POST", body, executionToken!);
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

// ---------------------------------------------------------------------------
// Phase 18W-B: Runtime Evidence Envelope construction (REAL SUBSTRATE WIRING)
// ---------------------------------------------------------------------------
//
// This is the INTEGRATION POINT between the worker poller and the in-substrate
// runtime verification orchestrator. The poller calls this AFTER the task
// execution flow has produced a verified candidate commit (and the control
// plane has acknowledged it via submit-evidence). Runtime verification runs
// the merged application at the exact canonical SHA inside the substrate
// (linux-namespace-sandbox) and produces a SIGNED ExecutionEvidenceEnvelope
// whose `substrateAttestation` is the REAL launcher-signed attestation —
// NEVER null.
//
// FLOW:
//   1. Resolve the GitHub credential from the control plane
//      (`/api/worker/resolve-github-credential`) — needed for `git clone`.
//   2. Build the authenticated repository URL.
//   3. Build the RuntimeVerificationJob (policy + plan + nonce + executionId +
//      launcherKeyFile + workerPrivateKeyPem).
//   4. Call executeRuntimeVerificationInWorker(job) — runs the orchestrator
//      INSIDE the substrate (node /workspace/orchestrator.js), captures the
//      launcher-signed attestation, and constructs the signed envelope.
//   5. POST the signed envelope to /api/worker/submit-runtime-evidence.
//
// FAIL-CLOSED: if the substrate cannot be established (gcc missing, unshare
// fails, launcher won't compile, facts file missing/empty), the call THROWS.
// The poller's workerLoop catches the throw and reports the job as FAILED.
// There is NO path where this function submits an envelope with
// `substrateAttestation: null`.

// Phase 18X: the worker does NOT have the launcher private key. It talks
// to the substrate supervisor (mini-services/substrate-supervisor, port
// 3004) which holds the launcher key IN MEMORY (file deleted at startup).
// The worker needs:
//   - SUBSTRATE_SUPERVISOR_URL (default http://localhost:3004) — where to
//     POST { capability, repoPath } (Phase 18Y — NO workload field).
//   - The control plane's signed ExecutionCapability (carrying nonce,
//     executionId, leaseId, repoSha, planHash, archHash, workloadHash,
//     runtimePlan (the FULL plan), expiresAt).
// The worker NEVER sees the launcher key file path, content, or any env
// var pointing to it. The worker NEVER supplies the workload — the
// supervisor DERIVES it from cap.runtimePlan.
const SUBSTRATE_SUPERVISOR_URL =
  process.env.SUBSTRATE_SUPERVISOR_URL || "http://localhost:3004";

async function buildAndSubmitRuntimeEvidenceEnvelope(params: {
  executionId: string;
  leaseId: string;
  projectId: string;
  repositoryHeadSha: string;
  githubRepo: string;
  runtimePlanHash: string;
  architectureHash: string | null;
  plan: OrchestratorPlan;
  /** Optional override for the substrate nonce. If not provided, the poller
   *  generates one (in production, the control plane issues this via the
   *  job-spec response — Phase 18W-C will verify it at submission time). */
  substrateNonce?: string;
  /** Phase 18X: The control-plane-signed ExecutionCapability. The supervisor
   *  verifies this before running the substrate. The capability carries the
   *  authoritative nonce + executionId. */
  capability?: import("@/lib/execution-capability").ExecutionCapability;
}): Promise<any> {
  if (!workerPrivateKeyPem) {
    throw new Error(
      "[worker] Cannot sign runtime evidence envelope — no Ed25519 private key. " +
      "Worker registration did not establish a keypair. Refusing to submit unsigned evidence."
    );
  }
  if (!params.capability) {
    throw new Error(
      "[worker] No ExecutionCapability provided. The substrate supervisor " +
      "requires a control-plane-signed capability to run the substrate " +
      "(Phase 18X — the worker cannot ask the supervisor to run arbitrary workloads)."
    );
  }
  if (!SUBSTRATE_SUPERVISOR_URL) {
    throw new Error(
      "[worker] SUBSTRATE_SUPERVISOR_URL is not set. The worker needs the " +
      "substrate supervisor URL to POST the workload (Phase 18X — the worker " +
      "does NOT hold the launcher key; it delegates to the supervisor)."
    );
  }

  // 1. Resolve the GitHub credential for an authenticated clone URL.
  let githubToken: string | null = null;
  try {
    const credResult = await apiCall("/api/worker/resolve-github-credential", "POST", {
      projectId: params.projectId,
    }, executionToken!);
    githubToken = credResult.token;
  } catch (err: any) {
    throw new Error(
      `[worker] Failed to resolve GitHub credential for runtime verification: ${err.message}`
    );
  }
  if (!githubToken) {
    throw new Error(
      "[worker] No GitHub token returned from resolve-github-credential — cannot clone for runtime verification."
    );
  }

  // 2. Build authenticated clone URL.
  const repoSlug = params.githubRepo;
  const cloneUrl = `https://x-access-token:${githubToken}@github.com/${repoSlug}.git`;

  // 3. Resolve the substrate nonce. Prefer the one from the job-spec (issued
  // by the control plane). If the control plane didn't issue one (e.g., DB
  // unavailable), generate one locally — the control plane's Phase 18W-C
  // verifier will reject mismatched nonces. The poller logs which path was
  // taken so the operator can spot misconfiguration.
  const nonce = params.substrateNonce || generateSubstrateNonce();
  if (!params.substrateNonce) {
    console.warn(
      `[worker] substrateNonce not provided by control plane — generating locally (${nonce}). ` +
      "Phase 18W-C verification will require the control plane to track this nonce."
    );
  }

  // 4. Build the RuntimeVerificationJob.
  // Phase 18X: the job carries `capability` (NOT `launcherKeyFile`). The
  // supervisor verifies the capability, then runs the substrate with the
  // launcher key it holds in memory.
  const job: RuntimeVerificationJob = {
    executionId: params.executionId,
    workerId: WORKER_ID,
    leaseId: params.leaseId,
    repositoryHeadSha: params.repositoryHeadSha,
    repositoryUrl: cloneUrl,
    architectureHash: params.architectureHash,
    runtimePlanHash: params.runtimePlanHash,
    plan: params.plan,
    nonce,
    capability: params.capability,
    supervisorUrl: SUBSTRATE_SUPERVISOR_URL,
    workerPrivateKeyPem,
  };

  // 5. Execute runtime verification inside the substrate. FAIL-CLOSED: this
  // throws if the substrate cannot be established.
  console.log(`[worker] Starting runtime verification at SHA ${params.repositoryHeadSha.slice(0, 7)} (executionId=${params.executionId}, nonce=${nonce.slice(0, 8)}...)`);
  const envelope = await executeRuntimeVerificationInWorker(job);

  // Sanity: substrateAttestation MUST be non-null (executeRuntimeVerificationInWorker
  // guarantees this — but assert defensively in case of a future refactor).
  if (!envelope.substrateAttestation) {
    throw new Error(
      "[worker] executeRuntimeVerificationInWorker returned an envelope with substrateAttestation=null. " +
      "This is a CRITICAL invariant violation — the substrate runner must never produce a null attestation."
    );
  }

  console.log(
    `[worker] Runtime verification completed: passed=${envelope.passed}, ` +
    `failureReason=${envelope.failureReason || "none"}, ` +
    `substrateType=${envelope.substrateAttestation.substrateType}, ` +
    `seccompMode=${envelope.substrateAttestation.seccompMode}, ` +
    `launcherSignature present=${!!envelope.substrateAttestation.launcherSignature}`
  );

  // 6. Submit the signed envelope to the control plane.
  return apiCall("/api/worker/submit-runtime-evidence", "POST", {
    envelope,
    attempt: 0,
  }, executionToken!);
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

// ---------------------------------------------------------------------------
// Phase 18W-B: Convert the control plane's RuntimeVerificationPlan (string
// commands) to the OrchestratorPlan (binary+args) the in-substrate
// orchestrator reads. The orchestrator runs INSIDE the chroot, so it cannot
// parse strings — we pre-split on the worker side using a simple whitespace
// tokenizer (NO shell — the binary is the first token, the rest are args).
// ---------------------------------------------------------------------------

function splitCommand(cmd: string): { binary: string; args: string[] } {
  const parts = (cmd || "").split(/\s+/).filter(Boolean);
  return { binary: parts[0] || "", args: parts.slice(1) };
}

function orchestratorPlanFromSpec(spec: any): OrchestratorPlan | null {
  // The control plane returns the RuntimeVerificationPlan inside
  // spec.verificationPlan or spec.architecture.contractJson.verificationPlan.
  // The plan shape matches RuntimeVerificationPlan in src/lib/runtime-verification.ts.
  let plan: any = null;
  if (spec?.verificationPlan) {
    plan = spec.verificationPlan;
  } else if (spec?.architecture?.contractJson) {
    try {
      const contract = typeof spec.architecture.contractJson === "string"
        ? JSON.parse(spec.architecture.contractJson)
        : spec.architecture.contractJson;
      if (contract?.verificationPlan) plan = contract.verificationPlan;
    } catch {}
  }
  if (!plan) return null;
  if (!plan.installCommands?.length || !plan.buildCommands?.length || !plan.startCommand) {
    return null;
  }

  const install = splitCommand(plan.installCommands[0]);
  const build = splitCommand(plan.buildCommands[0]);
  const start = splitCommand(plan.startCommand);

  return {
    install: { binary: install.binary, args: install.args, timeoutMs: 600000 },
    build: { binary: build.binary, args: build.args, timeoutMs: 600000 },
    start: { binary: start.binary, args: start.args, timeoutMs: plan.startupTimeoutMs || 30000 },
    port: plan.expectedPort,
    startupTimeoutMs: plan.startupTimeoutMs || 30000,
    healthChecks: (plan.healthChecks || []).map((hc: any) => ({
      name: hc.name,
      path: hc.path,
      expectedStatus: hc.expectedStatus,
      timeoutMs: hc.timeoutMs || 5000,
      required: hc.required || "required",
    })),
    apiJourneys: (plan.apiJourneys || []).map((j: any) => ({
      name: j.name,
      required: j.required || "optional",
      steps: (j.steps || []).map((s: any) => ({
        name: s.name,
        method: s.method || "GET",
        path: s.path,
        expectedStatus: s.expectedStatus,
        body: s.body,
      })),
    })),
  };
}

/**
 * Phase 18W-B: After a task is verified + pushed, run runtime verification
 * against the canonical HEAD (the integration branch). This runs the
 * MERGED application inside the substrate — not the candidate branch — to
 * verify the deployed product works, not just the candidate diff.
 *
 * Pragmatic gate: only run if (a) the candidate was pushed, (b) the spec
 * includes a RuntimeVerificationPlan, (c) the project has a canonicalHeadSha
 * (so we can clone + checkout the exact revision). If any condition fails,
 * skip runtime verification (log why). The control plane's submit-evidence
 * is still the canonical task-completion authority.
 */
async function maybeRunRuntimeVerification(
  spec: any,
  taskResult: { commitSha: string | null; pushedToRemote: boolean },
  evidenceResponse: any,
): Promise<void> {
  // Skip if the task itself didn't produce a verified candidate.
  if (!taskResult.commitSha || !taskResult.pushedToRemote) {
    console.log("[worker] Skipping runtime verification — candidate not pushed");
    return;
  }
  // Skip if submit-evidence didn't accept the task.
  if (evidenceResponse?.success !== true) {
    console.log("[worker] Skipping runtime verification — task evidence not accepted");
    return;
  }
  // Skip if no runtime verification plan in the spec.
  const orchPlan = orchestratorPlanFromSpec(spec);
  if (!orchPlan) {
    console.log("[worker] Skipping runtime verification — no RuntimeVerificationPlan in spec");
    return;
  }
  // Skip if no GitHub repo (runtime verification needs an authenticated clone).
  if (!spec.repository?.githubRepo) {
    console.log("[worker] Skipping runtime verification — no GitHub repo connected");
    return;
  }

  // The control plane is authoritative for the canonical HEAD. The poller
  // uses spec.baseCommitSha (which is project.canonicalHeadSha at job-spec
  // time). In production this is the post-merge canonical HEAD; here we use
  // the base SHA as a proxy.
  const canonicalSha = spec.baseCommitSha || taskResult.commitSha;
  if (!canonicalSha) {
    console.log("[worker] Skipping runtime verification — no canonical HEAD SHA");
    return;
  }

  // Derive architecture hash + runtime plan hash from the spec.
  const architectureHash = spec.architecture?.hash || null;
  // The runtime plan hash is computed canonically by the control plane — we
  // don't have hashRuntimePlan imported here. Pass a placeholder; the control
  // plane re-derives it at submission time (it has the architecture contract).
  const runtimePlanHash = architectureHash ? `${architectureHash}-runtime` : "unknown";

  // The substrate nonce — prefer the one from the job-spec response. Phase
  // 18W-C will verify at submission time. For now, the poller generates one
  // if the control plane didn't issue one.
  const substrateNonce = spec.substrateNonce as string | undefined;

  // Parse leaseId from the execution token (same pattern as submitEvidence).
  let leaseId = "";
  if (executionToken) {
    try {
      const tokenStr = executionToken.replace("Bearer ", "");
      const token = JSON.parse(Buffer.from(tokenStr, "base64").toString("utf-8"));
      leaseId = token.leaseId || "";
    } catch {}
  }

  // Phase 18X: Build the ExecutionCapability the supervisor will verify.
  // The control plane signs this with its private key (the worker cannot
  // forge it). In production, the control plane issues the capability via
  // the job-spec response (spec.capability). If absent, the poller fails-
  // closed — it cannot run runtime verification without a capability.
  const capability = spec.capability as
    | import("@/lib/execution-capability").ExecutionCapability
    | undefined;

  try {
    await buildAndSubmitRuntimeEvidenceEnvelope({
      executionId: spec.executionId,
      leaseId,
      projectId: spec.projectId,
      repositoryHeadSha: canonicalSha,
      githubRepo: spec.repository.githubRepo,
      runtimePlanHash,
      architectureHash,
      plan: orchPlan,
      substrateNonce,
      capability,
    });
  } catch (err: any) {
    // FAIL-CLOSED for runtime verification: the task itself already succeeded
    // (submit-evidence accepted it). A runtime verification failure does NOT
    // fail the task — but it does block PRODUCTION_READY (the control plane's
    // gate). Log the error so the operator can investigate.
    console.error(`[worker] Runtime verification FAILED for ${spec.executionId}: ${err.message}`);
  }
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

          // Phase 18W-B: After successful task completion, run runtime
          // verification against the canonical HEAD. This runs the merged
          // application inside the substrate (linux-namespace-sandbox) and
          // submits a SIGNED ExecutionEvidenceEnvelope whose
          // substrateAttestation is the REAL launcher-signed attestation.
          // FAIL-CLOSED: if the substrate cannot be established, the runtime
          // verification call THROWS — but the task itself has already
          // succeeded (submit-evidence accepted it). The throw is caught and
          // logged here; PRODUCTION_READY is blocked at the control plane.
          if (success) {
            await maybeRunRuntimeVerification(spec, result, evidenceResponse);
          }
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
