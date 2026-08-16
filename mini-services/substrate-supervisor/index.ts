// Forge — Phase 18X: Substrate Supervisor.
//
// This is a TRUSTED mini-service that HOLDS THE LAUNCHER PRIVATE KEY in memory
// and runs substrate executions on behalf of the (UNTRUSTED) worker.
//
// ARCHITECTURE:
//
//   Control Plane (holds FORGE_CONTROL_PLANE_PRIVATE_KEY)
//       │  issues ExecutionCapability (signed: executionId, nonce, leaseId,
//       │                            repoSha, planHash, archHash, expiresAt)
//       │  pins: launcher public key (FORGE_LAUNCHER_PUBLIC_KEY)
//       ▼
//   Worker (UNTRUSTED — has ONLY worker key, NO launcher key access)
//       │  POSTs { capability, workload, repoPath } to the supervisor
//       ▼
//   Substrate Supervisor (THIS SERVICE — TRUSTED, port 3004)
//       │  1. verifyExecutionCapability(capability, FORGE_CONTROL_PLANE_PUBLIC_KEY)
//       │     — rejects if signature invalid or capability expired.
//       │  2. runInSubstrate({ ..., nonce: cap.nonce, executionId: cap.executionId,
//       │                     launcherKeyPem })  // from memory — NEVER in response
//       │  3. returns { attestation, result } — NEVER the launcher key
//       ▼
//   Worker receives the signed attestation, builds the envelope, signs with
//   its worker key, submits to the control plane.
//
// STARTUP:
//   1. Read FORGE_LAUNCHER_KEY_FILE into memory (the launcher private key PEM).
//   2. DELETE the file (unlinkSync). The key is now ONLY in this process's
//      memory — no other process on this host can read it from disk.
//   3. If FORGE_LAUNCHER_KEY_FILE is unset OR the file can't be read → FATAL exit.
//   4. If FORGE_CONTROL_PLANE_PUBLIC_KEY is unset → FATAL exit (can't verify
//      execution capabilities — would run any workload the worker asks for).
//
// ENDPOINTS:
//   GET  /health  → 200 "OK"
//   POST /execute → runs a workload inside the substrate, returns attestation.
//
// INVARIANTS:
//   - The launcher key PEM is NEVER written to any response.
//   - The launcher key PEM is NEVER logged.
//   - The launcher key file is DELETED at startup (only the in-memory copy
//     remains; the kernel's page cache may still have it, but the file name
//     is gone — a worker can't `cat` it).
//   - The supervisor NEVER executes a workload without a valid
//     ExecutionCapability (signed by the control plane).
//   - The supervisor binds the workload's nonce + executionId to the
//     capability's nonce + executionId (cannot be overridden by the request).
//
// HONEST LIMITATIONS:
//   - A root-compromised supervisor host can `gcore` the supervisor process
//     and extract the launcher key from its memory. Full closure requires
//     hardware attestation (TPM/SGX/SEV-SNP). Out of scope for Phase 18X.
//   - The supervisor is co-located with the worker on the same host (in the
//     current deployment model). A root compromise of the host compromises
//     both. The supervisor provides isolation against a COMPROMISED WORKER
//     KEY (the worker can't forge the launcher signature), NOT against a
//     compromised host.

import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { runInSubstrate } from "@/lib/substrate-namespace";
import {
  verifyExecutionCapability,
  type ExecutionCapability,
} from "@/lib/execution-capability";
import type { SandboxAttestation } from "@/lib/substrate-attestation";
import type { CommandResult } from "@/lib/runtime-executor";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = 3004;
const LAUNCHER_KEY_FILE = process.env.FORGE_LAUNCHER_KEY_FILE;
const CONTROL_PLANE_PUBLIC_KEY = process.env.FORGE_CONTROL_PLANE_PUBLIC_KEY;

if (!LAUNCHER_KEY_FILE) {
  console.error("[substrate-supervisor] FATAL: FORGE_LAUNCHER_KEY_FILE not set. The supervisor needs the launcher private key to sign substrate attestations.");
  console.error("[substrate-supervisor] Provision the launcher key file (PEM, Ed25519) and set FORGE_LAUNCHER_KEY_FILE to its path. The supervisor will read it into memory and delete the file at startup.");
  process.exit(1);
}
if (!CONTROL_PLANE_PUBLIC_KEY) {
  console.error("[substrate-supervisor] FATAL: FORGE_CONTROL_PLANE_PUBLIC_KEY not set. The supervisor needs the control plane's public key to verify ExecutionCapabilities — without it, any worker could ask the supervisor to run arbitrary workloads.");
  console.error("[substrate-supervisor] Set FORGE_CONTROL_PLANE_PUBLIC_KEY to the control plane's Ed25519 public key (PEM, SPKI).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load the launcher key into memory, then DELETE the file.
// ---------------------------------------------------------------------------
//
// After this block, the launcher key exists ONLY in this process's memory.
// No other process on this host can read it from disk (the file is gone).
// A root-compromised host can still `gcore` the supervisor and extract the
// key from memory — see HONEST LIMITATIONS above.

if (!existsSync(LAUNCHER_KEY_FILE)) {
  console.error(`[substrate-supervisor] FATAL: FORGE_LAUNCHER_KEY_FILE points to a non-existent file: ${LAUNCHER_KEY_FILE}`);
  process.exit(1);
}

let launcherKeyPem: string;
try {
  launcherKeyPem = readFileSync(LAUNCHER_KEY_FILE, "utf-8");
} catch (err) {
  console.error(`[substrate-supervisor] FATAL: failed to read launcher key from ${LAUNCHER_KEY_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!launcherKeyPem.includes("PRIVATE KEY")) {
  console.error(`[substrate-supervisor] FATAL: launcher key file ${LAUNCHER_KEY_FILE} does not contain a PEM private key (missing "PRIVATE KEY" marker).`);
  process.exit(1);
}

// DELETE the file. The key is now ONLY in memory.
try {
  unlinkSync(LAUNCHER_KEY_FILE);
  console.log(`[substrate-supervisor] Launcher key loaded into memory, file deleted: ${LAUNCHER_KEY_FILE}`);
} catch (err) {
  // If unlink fails, we still have the key in memory — but the file is on
  // disk, which is a security hole. Fail-closed.
  console.error(`[substrate-supervisor] FATAL: failed to delete launcher key file ${LAUNCHER_KEY_FILE} after reading it into memory: ${err instanceof Error ? err.message : String(err)}`);
  console.error("[substrate-supervisor] The launcher key would remain on disk, accessible to the worker. Refusing to start.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

interface ExecuteRequestBody {
  capability: ExecutionCapability;
  workload: {
    binary: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    timeoutMs: number;
    includeProc?: boolean;
  };
  repoPath?: string;
}

interface ExecuteResponseBody {
  attestation: SandboxAttestation;
  result: CommandResult;
}

interface ErrorResponseBody {
  error: string;
  reasons?: string[];
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // POST /execute — run a workload inside the substrate.
  if (req.method === "POST" && req.url === "/execute") {
    try {
      const body = await readBody(req) as ExecuteRequestBody;

      if (!body || typeof body !== "object") {
        sendJson(res, 400, { error: "Request body must be a JSON object" } satisfies ErrorResponseBody);
        return;
      }
      if (!body.capability) {
        sendJson(res, 403, { error: "No execution capability provided" } satisfies ErrorResponseBody);
        return;
      }
      if (!body.workload) {
        sendJson(res, 400, { error: "No workload provided" } satisfies ErrorResponseBody);
        return;
      }
      const w = body.workload;
      if (!w.binary || typeof w.binary !== "string") {
        sendJson(res, 400, { error: "workload.binary is required (string)" } satisfies ErrorResponseBody);
        return;
      }
      if (!Array.isArray(w.args)) {
        sendJson(res, 400, { error: "workload.args must be an array of strings" } satisfies ErrorResponseBody);
        return;
      }
      if (!w.cwd || typeof w.cwd !== "string") {
        sendJson(res, 400, { error: "workload.cwd is required (string)" } satisfies ErrorResponseBody);
        return;
      }
      if (typeof w.timeoutMs !== "number" || w.timeoutMs <= 0) {
        sendJson(res, 400, { error: "workload.timeoutMs must be a positive number" } satisfies ErrorResponseBody);
        return;
      }

      // 1. Verify the ExecutionCapability signature + expiry.
      const capResult = verifyExecutionCapability(body.capability, CONTROL_PLANE_PUBLIC_KEY);
      if (!capResult.valid) {
        sendJson(res, 403, {
          error: "Invalid execution capability",
          reasons: capResult.reasons,
        } satisfies ErrorResponseBody);
        return;
      }

      // 2. Run the substrate. The nonce + executionId come from the
      //    capability (NOT from the request body) — they're bound into the
      //    launcher signature, so the worker CANNOT override them.
      const cap = body.capability;
      const { result, attestation } = await runInSubstrate({
        binary: w.binary,
        args: w.args,
        cwd: w.cwd,
        env: w.env,
        timeoutMs: w.timeoutMs,
        includeProc: w.includeProc,
        nonce: cap.nonce,
        executionId: cap.executionId,
        launcherKeyPem, // from memory — NEVER sent in response
      });

      // 3. Return the attestation + result. The launcher key is NEVER in
      //    the response.
      const responseBody: ExecuteResponseBody = { attestation, result };
      sendJson(res, 200, responseBody);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[substrate-supervisor] /execute failed: ${message}`);
      sendJson(res, 500, { error: message } satisfies ErrorResponseBody);
    }
    return;
  }

  // GET /health — liveness check.
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // Everything else → 404.
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`[substrate-supervisor] listening on :${PORT}`);
  console.log("[substrate-supervisor] Launcher key is in memory; the file has been deleted.");
  console.log("[substrate-supervisor] Endpoints: POST /execute, GET /health");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
      // Hard limit: 1 MiB. The workload spec shouldn't be huge.
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body exceeds 1 MiB limit"));
        req.destroy();
        return;
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Request body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
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
// Fail-closed: unhandled errors must crash the supervisor (don't silently
// keep running in a bad state).
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (reason) => {
  console.error("[substrate-supervisor] FATAL: unhandled rejection — exiting:", reason);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("[substrate-supervisor] FATAL: uncaught exception — exiting:", err);
  process.exit(1);
});
