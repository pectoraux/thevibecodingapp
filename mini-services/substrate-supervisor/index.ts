// Forge — Phase 18X / 18Y: Substrate Supervisor.
//
// This is a TRUSTED mini-service that HOLDS THE LAUNCHER PRIVATE KEY in memory
// and runs substrate executions on behalf of the (UNTRUSTED) worker.
//
// ARCHITECTURE (Phase 18Y — Execution Capability Closure):
//
//   Control Plane (holds FORGE_CONTROL_PLANE_PRIVATE_KEY)
//       │  issues ExecutionCapability { executionId, nonce, leaseId,
//       │                            repoSha, planHash, archHash,
//       │                            workloadHash, runtimePlan (FULL plan),
//       │                            expiresAt }
//       │  pins: launcher public key (FORGE_LAUNCHER_PUBLIC_KEY)
//       │  endpoint: POST /api/supervisor/consume-capability (atomic nonce
//       │            consumption + lease check)
//       ▼
//   Worker (UNTRUSTED — has ONLY worker key, NO launcher key access,
//           NEVER supplies the workload)
//       │  POSTs { capability, repoPath } to the supervisor
//       │  (NO workload field — the supervisor derives it)
//       ▼
//   Substrate Supervisor (THIS SERVICE — TRUSTED, port 3004)
//       │  1. verifyExecutionCapability(capability, FORGE_CONTROL_PLANE_PUBLIC_KEY)
//       │     — rejects if signature invalid or capability expired.
//       │  2. POST /api/supervisor/consume-capability { executionId, nonce,
//       │     leaseId, capabilitySignature } with FORGE_SUPERVISOR_SECRET.
//       │     Control plane atomically consumes the nonce (anti-replay) +
//       │     verifies lease active. 403 on replay / expired / reclaimed.
//       │  3. deriveWorkloadFromPlan(cap.runtimePlan) → { binary, args, cwd,
//       │     envKeys, timeoutMs, includeProc }.
//       │  4. computeWorkloadHash(derived) — MUST equal cap.workloadHash.
//       │     Mismatch → 403 (defense-in-depth).
//       │  5. Verify repo: git -C repoPath rev-parse HEAD === cap.repositoryHeadSha
//       │     AND git -C repoPath status --porcelain is empty (clean tree).
//       │  6. Write plan.json (from cap.runtimePlan) + copy orchestrator.js
//       │     into a workspace dir.
//       │  7. runInSubstrate({ ..., nonce: cap.nonce,
//       │                     executionId: cap.executionId,
//       │                     launcherKeyPem, cwd: repoPath })
//       │  8. returns { attestation, result, results } — NEVER the launcher key
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
//   5. If FORGE_SUPERVISOR_SECRET is unset → FATAL exit (can't authenticate to
//      the consume-capability endpoint — the control plane would 401 every
//      call, blocking all workloads; fail-closed at startup is clearer).
//   6. If FORGE_CONTROL_PLANE_URL is unset → default http://localhost:3000.
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
//   - The supervisor NEVER accepts a `workload` field from the worker. The
//     request body is { capability, repoPath } only. The workload is DERIVED
//     from cap.runtimePlan.
//   - The supervisor binds the workload's nonce + executionId to the
//     capability's nonce + executionId (cannot be overridden by the request).
//   - The supervisor verifies workloadHash matches before running.
//   - The supervisor verifies git rev-parse HEAD matches cap.repositoryHeadSha
//     AND the working tree is clean (no untracked/modified files).
//   - The supervisor calls /api/supervisor/consume-capability to atomically
//     consume the nonce (anti-replay) before running.
//
// HONEST LIMITATIONS:
//   - A root-compromised supervisor host can `gcore` the supervisor process
//     and extract the launcher key from its memory. Full closure requires
//     hardware attestation (TPM/SGX/SEV-SNP). Out of scope for Phase 18X/18Y.
//   - The supervisor is co-located with the worker on the same host (in the
//     current deployment model). A root compromise of the host compromises
//     both. The supervisor provides isolation against a COMPROMISED WORKER
//     KEY (the worker can't forge the launcher signature), NOT against a
//     compromised host.

import { readFileSync, unlinkSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";

import { runInSubstrate } from "@/lib/substrate-namespace";
import {
  verifyExecutionCapability,
  deriveWorkloadFromPlan,
  computeWorkloadHash,
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
const SUPERVISOR_SECRET = process.env.FORGE_SUPERVISOR_SECRET ?? "";
const CONTROL_PLANE_URL = (process.env.FORGE_CONTROL_PLANE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

// The orchestrator.js script lives next to the supervisor's parent
// project. We resolve it relative to the project root (process.cwd()).
// In tests, the test harness runs `bun mini-services/substrate-supervisor/index.ts`
// from the project root, so process.cwd() is the project root.
function resolveOrchestratorPath(): string {
  // Try a few candidates — the supervisor may be run from the project root
  // or from mini-services/substrate-supervisor.
  const candidates = [
    join(process.cwd(), "mini-services/execution-worker/runtime/orchestrator.js"),
    join(process.cwd(), "../execution-worker/runtime/orchestrator.js"),
    join(process.cwd(), "../../execution-worker/runtime/orchestrator.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to the first candidate (will fail loudly below if missing).
  return candidates[0];
}

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
if (!SUPERVISOR_SECRET) {
  console.error("[substrate-supervisor] FATAL: FORGE_SUPERVISOR_SECRET not set. The supervisor needs this shared secret to authenticate to the control plane's /api/supervisor/consume-capability endpoint (Phase 18Y — atomic nonce consumption). Without it, the control plane would 401 every consume-capability call, blocking all workloads. Fail-closed at startup is clearer than a runtime 401 loop.");
  console.error("[substrate-supervisor] Set FORGE_SUPERVISOR_SECRET to a strong shared secret. Provision the SAME value on the control plane.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load the launcher key into memory, then DELETE the file.
// ---------------------------------------------------------------------------

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
  console.error(`[substrate-supervisor] FATAL: failed to delete launcher key file ${LAUNCHER_KEY_FILE} after reading it into memory: ${err instanceof Error ? err.message : String(err)}`);
  console.error("[substrate-supervisor] The launcher key would remain on disk, accessible to the worker. Refusing to start.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

interface ExecuteRequestBody {
  capability: ExecutionCapability;
  /**
   * Phase 18Y: The worker supplies ONLY the host-side repoPath (where it
   * cloned the repo). It does NOT supply the workload — the supervisor
   * derives it from cap.runtimePlan. repoPath is bind-mounted into the
   * substrate as /workspace/repo.
   */
  repoPath?: string;
}

interface ExecuteResponseBody {
  attestation: SandboxAttestation;
  result: CommandResult;
  results?: unknown;
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

      // Phase 18Y: REJECT any `workload` field. The worker must NOT supply
      // the workload — the supervisor derives it from cap.runtimePlan.
      // This is the core P0 closure: a compromised worker cannot supply
      // arbitrary commands.
      if ((body as { workload?: unknown }).workload !== undefined) {
        sendJson(res, 403, {
          error: "Phase 18Y: the supervisor does NOT accept a 'workload' field. The workload is derived from cap.runtimePlan (control-plane-signed). The worker cannot supply the workload.",
        } satisfies ErrorResponseBody);
        return;
      }

      const repoPath = body.repoPath;
      if (!repoPath || typeof repoPath !== "string") {
        sendJson(res, 400, { error: "repoPath is required (string) — the host-side path where the worker cloned the repo" } satisfies ErrorResponseBody);
        return;
      }
      if (!existsSync(repoPath)) {
        sendJson(res, 400, { error: `repoPath does not exist: ${repoPath}` } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // 1. Verify the ExecutionCapability signature + expiry.
      // =====================================================================
      const capResult = verifyExecutionCapability(body.capability, CONTROL_PLANE_PUBLIC_KEY);
      if (!capResult.valid) {
        sendJson(res, 403, {
          error: "Invalid execution capability",
          reasons: capResult.reasons,
        } satisfies ErrorResponseBody);
        return;
      }
      const cap = body.capability;

      // =====================================================================
      // 2. Call /api/supervisor/consume-capability (atomic nonce consumption
      //    + lease check). The control plane atomically marks the nonce as
      //    consumed (substrateNonceConsumed=true) IF the lease is still
      //    active AND the nonce matches AND the leaseId matches. If the
      //    nonce was already consumed (replay) → 403. If the lease expired
      //    or was reclaimed → 403.
      // =====================================================================
      const consumeUrl = `${CONTROL_PLANE_URL}/api/supervisor/consume-capability`;
      let consumeOk = false;
      let consumeReason = "";
      try {
        const consumeResp = await fetch(consumeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPERVISOR_SECRET}`,
          },
          body: JSON.stringify({
            executionId: cap.executionId,
            nonce: cap.nonce,
            leaseId: cap.leaseId,
            capabilitySignature: cap.signature,
          }),
        });
        if (consumeResp.ok) {
          consumeOk = true;
        } else {
          consumeOk = false;
          try {
            const errBody = await consumeResp.json() as { error?: string; reason?: string };
            consumeReason = `${errBody.error ?? "(no error)"}${errBody.reason ? ` [${errBody.reason}]` : ""}`;
          } catch {
            try { consumeReason = await consumeResp.text(); } catch { /* ignore */ }
          }
        }
      } catch (err) {
        consumeOk = false;
        consumeReason = `failed to reach consume-capability endpoint at ${consumeUrl}: ${err instanceof Error ? err.message : String(err)}`;
      }

      if (!consumeOk) {
        sendJson(res, 403, {
          error: "Capability nonce consumption failed (replay, expired lease, reclaimed lease, or control plane unreachable)",
          reasons: [consumeReason],
        } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // 3. Derive the workload from cap.runtimePlan (NOT from the request).
      // =====================================================================
      const derived = deriveWorkloadFromPlan(cap.runtimePlan);

      // =====================================================================
      // 4. Compute the workload hash and compare to cap.workloadHash.
      //    Mismatch → 403 (defense-in-depth — the control plane signed
      //    both, so they should always match; if they don't, something is
      //    very wrong).
      // =====================================================================
      const derivedWorkloadHash = computeWorkloadHash(derived);
      if (derivedWorkloadHash !== cap.workloadHash) {
        sendJson(res, 403, {
          error: "Workload hash mismatch — cap.workloadHash does not match the hash derived from cap.runtimePlan. The capability does not authorize this workload.",
          reasons: [
            `derived=${derivedWorkloadHash.slice(0, 16)}... cap=${cap.workloadHash.slice(0, 16)}...`,
          ],
        } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // 5. Verify the repo: git rev-parse HEAD === cap.repositoryHeadSha
      //    AND the working tree is clean (no untracked/modified files).
      //    A mismatch means the worker is trying to run a different SHA than
      //    the control plane authorized. A dirty tree means the worker
      //    modified the repo after cloning (could be malicious).
      // =====================================================================
      let headSha = "";
      try {
        headSha = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
          encoding: "utf-8",
          shell: false,
          timeout: 10000,
        }).trim();
      } catch (err) {
        sendJson(res, 403, {
          error: `Failed to read git HEAD from repoPath ${repoPath}: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies ErrorResponseBody);
        return;
      }
      if (headSha !== cap.repositoryHeadSha) {
        sendJson(res, 403, {
          error: "Repository HEAD SHA mismatch — the worker cloned a different SHA than the capability authorizes",
          reasons: [
            `repoHead=${headSha.slice(0, 16)}... cap.repositoryHeadSha=${cap.repositoryHeadSha.slice(0, 16)}...`,
          ],
        } satisfies ErrorResponseBody);
        return;
      }
      let porcelain = "";
      try {
        porcelain = execFileSync("git", ["-C", repoPath, "status", "--porcelain"], {
          encoding: "utf-8",
          shell: false,
          timeout: 10000,
        }).trim();
      } catch (err) {
        sendJson(res, 403, {
          error: `Failed to check git working-tree status for repoPath ${repoPath}: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies ErrorResponseBody);
        return;
      }
      if (porcelain !== "") {
        sendJson(res, 403, {
          error: "Repository working tree is NOT clean — worker modified the repo after cloning (or there are untracked files). Rejecting (defense-in-depth).",
          reasons: [porcelain.split("\n").slice(0, 5).join("; ")],
        } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // 6. Write plan.json + copy orchestrator.js into the workspace dir.
      // =====================================================================
      // Phase 18Y: the workspace dir is `dirname(repoPath)` — the worker
      // created this dir and cloned the repo into `${workspace}/repo`. We
      // write plan.json + orchestrator.js alongside the repo (at
      // `${workspace}/plan.json` + `${workspace}/orchestrator.js`). The
      // substrate bind-mounts `${workspace}` as `/workspace` inside the
      // chroot, so the orchestrator sees:
      //   /workspace/plan.json     → ${workspace}/plan.json
      //   /workspace/orchestrator.js → ${workspace}/orchestrator.js
      //   /workspace/repo/server.js → ${workspace}/repo/server.js
      //   /workspace/results.json   → ${workspace}/results.json (written
      //                               by the orchestrator)
      //
      // We DO NOT create our own separate workspace dir — that would break
      // the bind-mount layout (the orchestrator expects /workspace/repo/*
      // to be the cloned repo, which only works if `cwd` is the parent of
      // `repo/`).
      //
      // The worker's workspace cleanup (in executeRuntimeVerificationInWorker's
      // finally block) will remove plan.json + orchestrator.js + results.json
      // + the repo. We don't clean up here.
      const workspace = dirname(repoPath);
      const planPath = join(workspace, "plan.json");
      const orchestratorPath = join(workspace, "orchestrator.js");
      try {
        writeFileSync(planPath, JSON.stringify(cap.runtimePlan, null, 2));
        const orchSrc = resolveOrchestratorPath();
        if (!existsSync(orchSrc)) {
          throw new Error(`orchestrator.js not found at ${orchSrc}`);
        }
        copyFileSync(orchSrc, orchestratorPath);
      } catch (err) {
        sendJson(res, 500, {
          error: `Failed to set up workspace: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // 7. Run the substrate. The nonce + executionId come from the
      //    capability (NOT from the request body) — they're bound into the
      //    launcher signature, so the worker CANNOT override them.
      //
      //    The cwd is `workspace` (the parent of repoPath). runInSubstrate
      //    bind-mounts this into the substrate as /workspace. The
      //    orchestrator reads /workspace/plan.json (we just wrote it to
      //    ${workspace}/plan.json).
      // =====================================================================
      let substrateResult: { result: CommandResult; attestation: SandboxAttestation };
      try {
        substrateResult = await runInSubstrate({
          binary: derived.binary,
          args: derived.args,
          cwd: workspace,
          timeoutMs: derived.timeoutMs,
          includeProc: derived.includeProc,
          nonce: cap.nonce,
          executionId: cap.executionId,
          launcherKeyPem,
        });
      } catch (err) {
        sendJson(res, 500, {
          error: `runInSubstrate failed: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies ErrorResponseBody);
        return;
      }

      const { result, attestation } = substrateResult;

      // =====================================================================
      // 8. Read results.json from the workspace (if the orchestrator wrote
      //    it). Best-effort — the orchestrator may have crashed before
      //    writing it.
      // =====================================================================
      let results: unknown = null;
      const resultsPath = join(workspace, "results.json");
      try {
        const raw = readFileSync(resultsPath, "utf-8");
        results = JSON.parse(raw);
      } catch {
        // No results.json — the orchestrator may have crashed. The
        // attestation is still valid (the substrate ran). The worker will
        // synthesize a failed result from the substrate's stdout/stderr.
      }

      // NOTE: we do NOT clean up the workspace here — the worker owns it
      // and will clean it up in its finally block.

      // =====================================================================
      // 9. Return the attestation + result + results. The launcher key is
      //    NEVER in the response.
      // =====================================================================
      const responseBody: ExecuteResponseBody = { attestation, result, results };
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
  console.log(`[substrate-supervisor] Control plane URL: ${CONTROL_PLANE_URL}`);
  console.log("[substrate-supervisor] Endpoints: POST /execute, GET /health");
  console.log("[substrate-supervisor] Phase 18Y: supervisor derives workload from cap.runtimePlan; worker does NOT supply workload.");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
      // Hard limit: 4 MiB. The capability (with the full plan) can be large
      // but shouldn't exceed a few hundred KB.
      if (raw.length > 4 * 1024 * 1024) {
        reject(new Error("Request body exceeds 4 MiB limit"));
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
