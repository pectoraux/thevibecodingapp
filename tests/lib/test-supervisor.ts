// Forge — Phase 18X / 18Y: Test supervisor helper.
//
// Starts a substrate supervisor mini-service as a child process for use in
// tests. Generates a launcher keypair, writes the private key to a temp
// file, spawns the supervisor with FORGE_LAUNCHER_KEY_FILE pointing at it
// (the supervisor reads + DELETES the file), waits for /health to return
// 200, then returns { url, launcherPublicKey, controlPlaneKeyPair, stop }.
//
// Phase 18Y: ALSO starts a mock consume-capability HTTP server (in-memory
// Set of consumed nonces) on a separate port, and sets
// FORGE_CONTROL_PLANE_URL + FORGE_SUPERVISOR_SECRET on the supervisor child
// process so the supervisor's call to /api/supervisor/consume-capability
// succeeds. The mock implements the SAME atomic-consumption logic as the
// real control-plane endpoint (but in-memory, no DB).
//
// Used by:
//   tests/worker-runtime-wiring-invariants.ts
//   tests/e2e-substrate-trust-invariants.ts
//   tests/substrate-key-isolation-invariants.ts
//   tests/control-plane-capability-invariants.ts
//   tests/e2e-launcher-key-isolation-invariants.ts
//
// The test harness holds the launcher PRIVATE key (so it can sign
// capabilities if needed). In production, ONLY the supervisor has the
// private key; the worker NEVER does.

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { generateKeyPairSync, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";

import { generateLauncherKeyPair } from "@/lib/substrate-attestation";
import {
  signExecutionCapability,
  deriveWorkloadFromPlan,
  computeWorkloadHash,
  verifyExecutionCapability,
  type ExecutionCapability,
} from "@/lib/execution-capability";

export interface TestSupervisor {
  /** The supervisor's base URL (e.g., http://localhost:3004). */
  url: string;
  /** The supervisor's child process — kill() to stop. */
  process: ChildProcess;
  /** The launcher public key (for verifying attestations). */
  launcherPublicKey: string;
  /** The launcher private key (test-only — the supervisor holds it in memory). */
  launcherPrivateKey: string;
  /** The control-plane keypair — the test signs capabilities with the private key. */
  controlPlaneKeyPair: {
    privateKeyPem: string;
    publicKeyPem: string;
  };
  /** The path where the launcher key file USED TO BE (deleted by supervisor). */
  launcherKeyFilePath: string;
  /** The shared secret used to authenticate to the mock consume-capability endpoint. */
  supervisorSecret: string;
  /** The mock consume-capability server's port (in-memory, no DB). */
  mockConsumeCapabilityPort: number;
  /** Sign an ExecutionCapability using the control-plane private key. */
  signCapability: (input: Omit<SignCapabilityInput, "workloadHash" | "runtimePlan"> & Partial<Pick<SignCapabilityInput, "workloadHash" | "runtimePlan">>) => ExecutionCapability;
  /** Stop the supervisor (SIGTERM → 5s grace → SIGKILL) + stop the mock. */
  stop: () => Promise<void>;
}

/**
 * Phase 18Y: input to signCapability. The runtimePlan + workloadHash are
 * optional — if not provided, signCapability uses an empty plan + derives
 * the workloadHash from it. Most tests don't care about the plan content;
 * they just need a signed capability the supervisor will accept.
 *
 * The runtimePlan is the FULL plan object (signed into the capability). The
 * supervisor DERIVES the workload from this and verifies workloadHash.
 */
export interface SignCapabilityInput {
  executionId: string;
  nonce: string;
  leaseId: string;
  repositoryHeadSha: string;
  runtimePlanHash: string;
  architectureHash: string | null;
  workloadHash: string;
  runtimePlan: Record<string, unknown>;
  expiresAt: string;
}

const SUPERVISOR_SCRIPT = resolve(
  process.cwd(),
  "mini-services/substrate-supervisor/index.ts"
);

/**
 * Start a test substrate supervisor on the given port (default 3004).
 *
 * 1. Generate a launcher keypair.
 * 2. Write the launcher PRIVATE key to a temp file (mode 0600).
 * 3. Generate a control-plane Ed25519 keypair (for signing capabilities).
 * 4. Generate a supervisor secret (for authenticating to consume-capability).
 * 5. Start a mock consume-capability HTTP server (in-memory, no DB).
 * 6. Spawn the supervisor: `bun mini-services/substrate-supervisor/index.ts`
 *    with env FORGE_LAUNCHER_KEY_FILE=<path>,
 *    FORGE_CONTROL_PLANE_PUBLIC_KEY=<control-plane public key>,
 *    FORGE_CONTROL_PLANE_URL=http://localhost:<mockPort>,
 *    FORGE_SUPERVISOR_SECRET=<secret>.
 * 7. Poll GET /health until 200 (or timeout).
 * 8. Return the supervisor handle.
 *
 * The supervisor READS the launcher key into memory and DELETES the file.
 * The test can verify the file is gone (key isolation invariant).
 */
export async function startTestSupervisor(opts?: {
  port?: number;
  /** If true, don't set FORGE_CONTROL_PLANE_PUBLIC_KEY — for testing the
   *  fail-closed path. */
  noControlPlaneKey?: boolean;
  /** If true, don't set FORGE_LAUNCHER_KEY_FILE — for testing the fail-closed path. */
  noLauncherKeyFile?: boolean;
  /** If true, don't set FORGE_SUPERVISOR_SECRET — for testing the fail-closed path. */
  noSupervisorSecret?: boolean;
  /** If true, don't start the mock consume-capability server (for testing
   *  the supervisor's behavior when the control plane is unreachable). */
  noMockConsumeCapability?: boolean;
}): Promise<TestSupervisor> {
  const port = opts?.port ?? 3004;
  const url = `http://localhost:${port}`;

  // 1. Generate the launcher keypair.
  const launcher = generateLauncherKeyPair();

  // 2. Write the launcher PRIVATE key to a temp file.
  const launcherKeyFilePath = `/tmp/forge-test-supervisor-key-${randomUUID()}.pem`;
  if (!opts?.noLauncherKeyFile) {
    writeFileSync(launcherKeyFilePath, launcher.privateKeyPem, { mode: 0o600 });
  }

  // 3. Generate the control-plane keypair (for signing capabilities).
  const cp = generateKeyPairSync("ed25519");
  const controlPlaneKeyPair = {
    privateKeyPem: cp.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: cp.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };

  // 4. Generate a supervisor secret.
  const supervisorSecret = `forge-test-supervisor-secret-${randomUUID()}`;

  // 5. Start the mock consume-capability server (in-memory, no DB).
  const mockConsumeCapabilityPort = pickTestPort();
  const consumedNonces = new Set<string>();
  const mockServer = opts?.noMockConsumeCapability
    ? null
    : startMockConsumeCapabilityServer(mockConsumeCapabilityPort, supervisorSecret, controlPlaneKeyPair.publicKeyPem, consumedNonces);
  if (mockServer) {
    await waitForServer(`http://localhost:${mockConsumeCapabilityPort}/health`, 5000);
  }

  // 6. Spawn the supervisor.
  const env: Record<string, string> = {
    ...process.env,
    PORT: String(port),
  };
  if (!opts?.noLauncherKeyFile) {
    env.FORGE_LAUNCHER_KEY_FILE = launcherKeyFilePath;
  }
  if (!opts?.noControlPlaneKey) {
    env.FORGE_CONTROL_PLANE_PUBLIC_KEY = controlPlaneKeyPair.publicKeyPem;
  }
  if (!opts?.noSupervisorSecret) {
    env.FORGE_SUPERVISOR_SECRET = supervisorSecret;
  }
  // Point the supervisor at the mock consume-capability server (Phase 18Y).
  // The supervisor will POST to {FORGE_CONTROL_PLANE_URL}/api/supervisor/consume-capability.
  if (mockServer) {
    env.FORGE_CONTROL_PLANE_URL = `http://localhost:${mockConsumeCapabilityPort}`;
  }

  const child = spawn("bun", [SUPERVISOR_SCRIPT], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
    if (stdout.length > 50000) stdout = stdout.slice(-50000);
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 50000) stderr = stderr.slice(-50000);
  });

  // 7. Wait for the supervisor to be ready (poll /health).
  const startedAt = Date.now();
  const TIMEOUT_MS = 15000;
  let ready = false;
  let lastError = "";
  while (Date.now() - startedAt < TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(
        `Substrate supervisor exited with code ${child.exitCode} before becoming ready. ` +
          `stdout: ${stdout.slice(-2000)}\nstderr: ${stderr.slice(-2000)}`
      );
    }
    try {
      const resp = await fetch(`${url}/health`);
      if (resp.ok) {
        ready = true;
        break;
      }
      lastError = `HTTP ${resp.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!ready) {
    try { child.kill("SIGKILL"); } catch { /* best-effort */ }
    if (mockServer) { try { mockServer.close(); } catch { /* best-effort */ } }
    throw new Error(
      `Substrate supervisor did not become ready within ${TIMEOUT_MS}ms. ` +
        `Last error: ${lastError}\nstdout: ${stdout.slice(-2000)}\nstderr: ${stderr.slice(-2000)}`
    );
  }

  // 8. Return the handle.
  const signCapability = (
    input: Omit<SignCapabilityInput, "workloadHash" | "runtimePlan"> &
      Partial<Pick<SignCapabilityInput, "workloadHash" | "runtimePlan">>
  ): ExecutionCapability => {
    // Phase 18Y: if runtimePlan / workloadHash are not provided, default to
    // an empty plan and derive the workloadHash from it. Most tests don't
    // care about the plan content; they just need a signed capability the
    // supervisor will accept.
    const runtimePlan: Record<string, unknown> = input.runtimePlan ?? {};
    const workloadHash: string =
      input.workloadHash ??
      computeWorkloadHash(deriveWorkloadFromPlan(runtimePlan));
    const fullInput: SignCapabilityInput = {
      executionId: input.executionId,
      nonce: input.nonce,
      leaseId: input.leaseId,
      repositoryHeadSha: input.repositoryHeadSha,
      runtimePlanHash: input.runtimePlanHash,
      architectureHash: input.architectureHash,
      workloadHash,
      runtimePlan,
      expiresAt: input.expiresAt,
    };
    return signExecutionCapability(fullInput, controlPlaneKeyPair.privateKeyPem);
  };

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) {
      // Supervisor already exited.
    } else {
      try { child.kill("SIGTERM"); } catch { /* best-effort */ }
      await new Promise<void>((resolveP) => {
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* best-effort */ }
          resolveP();
        }, 5000);
        child.once("close", () => {
          clearTimeout(timer);
          resolveP();
        });
      });
    }
    if (mockServer) {
      try { mockServer.close(); } catch { /* best-effort */ }
    }
    if (existsSync(launcherKeyFilePath)) {
      try { rmSync(launcherKeyFilePath, { force: true }); } catch { /* best-effort */ }
    }
  };

  return {
    url,
    process: child,
    launcherPublicKey: launcher.publicKeyPem,
    launcherPrivateKey: launcher.privateKeyPem,
    controlPlaneKeyPair,
    launcherKeyFilePath,
    supervisorSecret,
    mockConsumeCapabilityPort,
    signCapability,
    stop,
  };
}

// ---------------------------------------------------------------------------
// Mock consume-capability server (Phase 18Y)
// ---------------------------------------------------------------------------

/**
 * Start a mock /api/supervisor/consume-capability server on the given port.
 *
 * This server has the SAME shape as the real control-plane endpoint, but
 * with IN-MEMORY state (a Set of consumed nonces) instead of a DB. It:
 *   1. Authenticates the supervisor via the Bearer token (supervisorSecret).
 *   2. Verifies the capability signature (controlPlanePublicKeyPem).
 *   3. Atomically consumes the nonce: if the nonce is already in
 *      consumedNonces → 403 (replay). Otherwise add to the Set → 200.
 *
 * Endpoints:
 *   GET  /health  → 200 "OK"
 *   POST /api/supervisor/consume-capability → 200 (consumed) or 403 (replay/invalid).
 *
 * NOTE: the real endpoint uses updateMany with where: { ..., leaseId,
 * leaseExpiresAt: { gt: now } } (atomic at the DB level). This mock uses a
 * Set + a JS lock (single-threaded) to approximate atomicity. It's not a
 * perfect simulation of the DB-level atomicity, but it correctly implements
 * the replay-detection behavior the supervisor depends on.
 */
function startMockConsumeCapabilityServer(
  port: number,
  supervisorSecret: string,
  controlPlanePublicKeyPem: string,
  consumedNonces: Set<string>
): ReturnType<typeof createServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }
    if (req.method === "POST" && req.url === "/api/supervisor/consume-capability") {
      handleConsume(req, res, supervisorSecret, controlPlanePublicKeyPem, consumedNonces);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });
  server.listen(port);
  return server;
}

async function handleConsume(
  req: IncomingMessage,
  res: ServerResponse,
  supervisorSecret: string,
  controlPlanePublicKeyPem: string,
  consumedNonces: Set<string>
): Promise<void> {
  // Authenticate.
  const authHeader = req.headers["authorization"] ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    sendJson(res, 401, { error: "Missing Bearer token" });
    return;
  }
  const presented = authHeader.slice(7);
  const presentedBuf = Buffer.from(presented, "utf-8");
  const expectedBuf = Buffer.from(supervisorSecret, "utf-8");
  if (presentedBuf.length !== expectedBuf.length || !timingSafeEqual(presentedBuf, expectedBuf)) {
    sendJson(res, 401, { error: "Invalid supervisor secret" });
    return;
  }

  // Parse body.
  let body: any;
  try {
    const raw = await readBodyPromise(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const executionId = typeof body.executionId === "string" ? body.executionId : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!executionId || !nonce || !leaseId) {
    sendJson(res, 400, { error: "executionId, nonce, leaseId are required" });
    return;
  }

  // Atomic consume: check + add (single-threaded JS, so atomic).
  if (consumedNonces.has(nonce)) {
    sendJson(res, 403, {
      error: "Capability nonce already consumed (replay)",
      reason: "REPLAY",
    });
    return;
  }
  consumedNonces.add(nonce);

  sendJson(res, 200, {
    consumed: true,
    executionId,
    consumedAt: new Date().toISOString(),
  });
}

function readBodyPromise(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
      if (raw.length > 1024 * 1024) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickTestPort(): number {
  // Pick a port in the test range (3099-3199). Use randomUUID for
  // uniqueness; modulo a small range to keep ports in the test range.
  // Avoids conflicts with the supervisor (3004) and the Next.js dev
  // server (3000).
  const seed = parseInt(randomUUID().replace(/[^0-9]/g, "").slice(0, 6), 10);
  return 3099 + (seed % 100);
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
      lastErr = `HTTP ${resp.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms (last error: ${lastErr})`);
}

// Re-export the helpers tests use directly (signExecutionCapability,
// deriveWorkloadFromPlan, computeWorkloadHash, verifyExecutionCapability)
// for convenience.
export {
  signExecutionCapability,
  deriveWorkloadFromPlan,
  computeWorkloadHash,
  verifyExecutionCapability,
};
