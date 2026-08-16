// Forge — Phase 18X: Test supervisor helper.
//
// Starts a substrate supervisor mini-service as a child process for use in
// tests. Generates a launcher keypair, writes the private key to a temp
// file, spawns the supervisor with FORGE_LAUNCHER_KEY_FILE pointing at it
// (the supervisor reads + DELETES the file), waits for /health to return
// 200, then returns { url, launcherPublicKey, controlPlaneKeyPair, stop }.
//
// Used by:
//   tests/worker-runtime-wiring-invariants.ts
//   tests/e2e-substrate-trust-invariants.ts
//   tests/substrate-key-isolation-invariants.ts
//
// The test harness holds the launcher PRIVATE key (so it can sign
// capabilities if needed). In production, ONLY the supervisor has the
// private key; the worker NEVER does.

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { generateLauncherKeyPair } from "@/lib/substrate-attestation";
import {
  signExecutionCapability,
  type ExecutionCapability,
  type ExecutionCapabilityInput,
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
  /** Sign an ExecutionCapability using the control-plane private key. */
  signCapability: (input: ExecutionCapabilityInput) => ExecutionCapability;
  /** Stop the supervisor (SIGTERM → 5s grace → SIGKILL). */
  stop: () => Promise<void>;
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
 * 4. Spawn the supervisor: `bun mini-services/substrate-supervisor/index.ts`
 *    with env FORGE_LAUNCHER_KEY_FILE=<path> and
 *    FORGE_CONTROL_PLANE_PUBLIC_KEY=<control-plane public key>.
 * 5. Poll GET /health until 200 (or timeout).
 * 6. Return the supervisor handle.
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

  // 4. Spawn the supervisor.
  const env: Record<string, string> = {
    ...process.env,
    // Force the supervisor's PORT — the supervisor reads from process.env.PORT
    // if it does, but ours hardcodes 3004. We still set PORT for clarity.
    PORT: String(port),
  };
  if (!opts?.noLauncherKeyFile) {
    env.FORGE_LAUNCHER_KEY_FILE = launcherKeyFilePath;
  }
  if (!opts?.noControlPlaneKey) {
    env.FORGE_CONTROL_PLANE_PUBLIC_KEY = controlPlaneKeyPair.publicKeyPem;
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

  // 5. Wait for the supervisor to be ready (poll /health).
  // If the supervisor fails to start (FATAL exit), this throws.
  const startedAt = Date.now();
  const TIMEOUT_MS = 10000;
  let ready = false;
  let lastError = "";
  while (Date.now() - startedAt < TIMEOUT_MS) {
    // Check if the process exited (FATAL).
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
    // Kill the child before throwing.
    try { child.kill("SIGKILL"); } catch { /* best-effort */ }
    throw new Error(
      `Substrate supervisor did not become ready within ${TIMEOUT_MS}ms. ` +
        `Last error: ${lastError}\nstdout: ${stdout.slice(-2000)}\nstderr: ${stderr.slice(-2000)}`
    );
  }

  // 6. Return the handle.
  const signCapability = (input: ExecutionCapabilityInput): ExecutionCapability =>
    signExecutionCapability(input, controlPlaneKeyPair.privateKeyPem);

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return; // already exited
    try { child.kill("SIGTERM"); } catch { /* best-effort */ }
    // Wait up to 5s for graceful exit.
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
    // Best-effort cleanup of the launcher key file (in case the supervisor
    // didn't delete it — e.g., if it failed to start).
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
    signCapability,
    stop,
  };
}
