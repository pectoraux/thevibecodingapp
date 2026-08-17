// Forge — Phase 18X / 18Y / 18Z-PRE: Substrate Supervisor.
//
// This is a TRUSTED mini-service that HOLDS THE LAUNCHER PRIVATE KEY in memory
// and runs substrate executions on behalf of the (UNTRUSTED) worker.
//
// ARCHITECTURE (Phase 18Z-PRE — Repository Execution Boundary):
//
//   Control Plane (holds FORGE_CONTROL_PLANE_PRIVATE_KEY)
//       │  signs capability { executionId, nonce, leaseId,
//       │                            repositoryHeadSha, repositoryUrl,
//       │                            runtimePlanHash, architectureHash,
//       │                            workloadHash, runtimePlan (FULL plan),
//       │                            expiresAt }
//       │  pins: launcher public key (FORGE_LAUNCHER_PUBLIC_KEY)
//       │  endpoint: POST /api/supervisor/consume-capability (atomic nonce
//       │            consumption + lease check)
//       │  endpoint: POST /api/supervisor/resolve-repo-credential (returns
//       │            the authenticated cloneUrl for the capability's repo)
//       ▼
//   Worker (UNTRUSTED — has ONLY worker key, NO launcher key access,
//           NEVER supplies the workload, NEVER supplies a repoPath)
//       │  POSTs { capability } to the supervisor
//       │  (NO repoPath, NO workload — the supervisor derives the workload
//       │   from cap.runtimePlan and clones the repo itself)
//       ▼
//   Substrate Supervisor (THIS SERVICE — TRUSTED, port 3004)
//       │  1. REJECT if `repoPath` is present in the request body (defense-
//       │     in-depth — the worker must NOT supply a host path).
//       │  2. REJECT if `workload` is present (Phase 18Y — the supervisor
//       │     derives the workload from cap.runtimePlan).
//       │  3. verifyExecutionCapability(capability, FORGE_CONTROL_PLANE_PUBLIC_KEY)
//       │     — rejects if signature invalid or capability expired.
//       │  4. PRE-CONSUMPTION CHECKS (all deterministic, request-independent):
//       │     a. cap.workloadHash is present.
//       │     b. cap.runtimePlan is present and is an object.
//       │     c. Derive workload from cap.runtimePlan.
//       │     d. Compute workloadHash from the derived workload.
//       │     e. Compare to cap.workloadHash. Mismatch → 403.
//       │     f. cap.repositoryUrl is present and is an HTTPS or file:// URL.
//       │     g. cap.repositoryHeadSha is a 40-hex-char SHA.
//       │     (A failure here returns 403 WITHOUT consuming the nonce —
//       │      closing the DoS vector where a malformed request burns the
//       │      capability.)
//       │  5. CONSUME THE CAPABILITY (only after all pre-checks pass):
//       │     POST /api/supervisor/consume-capability { executionId, nonce,
//       │     leaseId, capabilitySignature } with FORGE_SUPERVISOR_SECRET.
//       │     Control plane atomically consumes the nonce (anti-replay) +
//       │     verifies lease active. 403 on replay / expired / reclaimed.
//       │  6. CREATE per-execution workspace: /tmp/forge-executions/<executionId>/
//       │     (deterministic path based on executionId — auditable).
//       │  7. RESOLVE the repository credential: POST
//       │     /api/supervisor/resolve-repo-credential { executionId,
//       │     repositoryUrl: cap.repositoryUrl } → { cloneUrl }.
//       │     The supervisor NEVER asks the worker for a credential.
//       │  8. CLONE the repo at the exact SHA (the supervisor does the clone,
//       │     NOT the worker):
//       │     git clone <cloneUrl> <workspace>/repo
//       │     git -C <workspace>/repo checkout <cap.repositoryHeadSha>
//       │  9. VERIFY the SHA: git -C <workspace>/repo rev-parse HEAD ===
//       │     cap.repositoryHeadSha. Mismatch → 403 + cleanup.
//       │ 10. VERIFY the FULL tree (defense-in-depth — the clone is fresh so
//       │     the tree is clean by construction):
//       │     git -C <workspace>/repo status --porcelain → empty.
//       │     git -C <workspace>/repo clean -nd → empty (catches untracked).
//       │     git -C <workspace>/repo config --get core.hooksPath → empty
//       │     or ".git/hooks" (catches hook tampering).
//       │ 11. Write plan.json + copy orchestrator.js into the workspace.
//       │ 12. runInSubstrate({ binary: "node",
//       │                     args: ["/workspace/orchestrator.js"],
//       │                     cwd: workspace, nonce: cap.nonce,
//       │                     executionId: cap.executionId,
//       │                     launcherKeyPem, timeoutMs: derived.timeoutMs })
//       │ 13. Read results.json from the workspace.
//       │ 14. Return { attestation, result, results } — NEVER the launcher key.
//       │ 15. Cleanup: keep the workspace for audit (under
//       │     /tmp/forge-executions/<executionId>/).
//       ▼
//   Worker receives the signed attestation, builds the envelope, signs with
//   its worker key, submits to the control plane.
//
// STARTUP:
//   1. Read FORGE_LAUNCHER_KEY_FILE into memory (the launcher private key PEM).
//   2. DELETE the file (unlinkSync). The key is now ONLY in this process's
//      memory — no other process on this host can read it from disk.
//   3. If FORGE_LAUNCHER_KEY_FILE is unset OR the file can't be read → FATAL exit.
//   4. If FORGE_CONTROL_PLANE_PUBLIC_KEY is unset → FATAL exit.
//   5. If FORGE_SUPERVISOR_SECRET is unset → FATAL exit.
//   6. If FORGE_CONTROL_PLANE_URL is unset → default http://localhost:3000.
//
// ENDPOINTS:
//   GET  /health  → 200 "OK"
//   POST /execute → runs a workload inside the substrate, returns attestation.
//
// INVARIANTS:
//   - The launcher key PEM is NEVER written to any response.
//   - The launcher key PEM is NEVER logged.
//   - The launcher key file is DELETED at startup.
//   - The supervisor NEVER executes a workload without a valid
//     ExecutionCapability (signed by the control plane).
//   - The supervisor NEVER accepts a `workload` field (Phase 18Y).
//   - The supervisor NEVER accepts a `repoPath` field (Phase 18Z-PRE).
//   - The supervisor CLONES the repo itself (Phase 18Z-PRE) — the worker
//     has ZERO host-path authority over the repo.
//   - The supervisor RESOLVES the clone credential from the control plane
//     — the worker never sees a credential.
//   - The supervisor VERIFIES the cloned HEAD === cap.repositoryHeadSha.
//   - The supervisor CONSUMES the nonce ONLY after all pre-checks pass
//     (Phase 18Z-PRE — closes the DoS vector).
//   - The supervisor binds the workload's nonce + executionId to the
//     capability's nonce + executionId.
//   - The supervisor verifies workloadHash matches before running.
//   - The supervisor creates a per-execution workspace at
//     /tmp/forge-executions/<executionId>/ — auditable + isolated.
//
// HONEST LIMITATIONS:
//   - A root-compromised supervisor host can `gcore` the supervisor process
//     and extract the launcher key from its memory. Full closure requires
//     hardware attestation (TPM/SGX/SEV-SNP). Out of scope for Phase 18X/18Y/18Z.
//   - The supervisor is co-located with the worker on the same host. A root
//     compromise of the host compromises both. The supervisor provides
//     isolation against a COMPROMISED WORKER KEY, NOT against a compromised
//     host.
//   - The supervisor's clone uses git's HTTPS-with-embedded-token URL. The
//     token ends up in <workspace>/repo/.git/config. The supervisor cleans
//     up the workspace on its own schedule; in the window before cleanup,
//     a root-compromised host could read the token from .git/config.
//     Production should use `git -c credential.helper=` + a credential
//     helper, or an env-var-based credential (GIT_ASKPASS) — see TODO in
//     the clone section.

import { readFileSync, unlinkSync, existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { runInSubstrate } from "@/lib/substrate-namespace";
import {
  verifyExecutionCapability,
  deriveWorkloadFromPlan,
  computeWorkloadHash,
  type ExecutionCapability,
} from "@/lib/execution-capability";
import type { SandboxAttestation } from "@/lib/substrate-attestation";
import type { CommandResult } from "@/lib/runtime-executor";
import type { ArtifactManifest } from "@/lib/artifact-manifest";
import { ArtifactStore } from "@/lib/artifact-store";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = 3004;
const LAUNCHER_KEY_FILE = process.env.FORGE_LAUNCHER_KEY_FILE;
const CONTROL_PLANE_PUBLIC_KEY = process.env.FORGE_CONTROL_PLANE_PUBLIC_KEY;
const SUPERVISOR_SECRET = process.env.FORGE_SUPERVISOR_SECRET ?? "";
const CONTROL_PLANE_URL = (process.env.FORGE_CONTROL_PLANE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

// Per-execution workspaces live under this dir. Deterministic path
// /tmp/forge-executions/<executionId>/ — auditable + isolated.
const EXECUTIONS_ROOT = "/tmp/forge-executions";

// Phase 18Z-A: Content-addressed artifact store root. The supervisor persists
// every artifact the launcher recorded in the manifest (build logs, runtime
// stdout/stderr, health traces, the signed attestation itself, ...) keyed by
// SHA-256. Consumers retrieve artifacts by sha256 (the content-addressed key),
// NOT by storageRef (which is just the logical path the launcher signed).
const ARTIFACT_STORE_ROOT =
  process.env.FORGE_ARTIFACT_STORE_ROOT ?? "/tmp/forge-artifacts";

// Constructed once at startup (the dir is created in the constructor).
const artifactStore = new ArtifactStore(ARTIFACT_STORE_ROOT);

// The orchestrator.js script lives next to the supervisor's parent
// project. We resolve it relative to the project root (process.cwd()).
function resolveOrchestratorPath(): string {
  const candidates = [
    join(process.cwd(), "mini-services/execution-worker/runtime/orchestrator.js"),
    join(process.cwd(), "../execution-worker/runtime/orchestrator.js"),
    join(process.cwd(), "../../execution-worker/runtime/orchestrator.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
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
  console.error("[substrate-supervisor] FATAL: FORGE_SUPERVISOR_SECRET not set. The supervisor needs this shared secret to authenticate to the control plane's /api/supervisor/* endpoints (consume-capability, resolve-repo-credential). Without it, the control plane would 401 every call, blocking all workloads. Fail-closed at startup is clearer than a runtime 401 loop.");
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
}

interface ExecuteResponseBody {
  attestation: SandboxAttestation;
  result: CommandResult;
  results?: unknown;
  /** Phase 18Z-A: the launcher-signed artifact manifest. */
  manifest: ArtifactManifest | null;
}

interface ErrorResponseBody {
  error: string;
  reasons?: string[];
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // POST /execute — run a workload inside the substrate.
  if (req.method === "POST" && req.url === "/execute") {
    let workspace: string | null = null;
    try {
      const body = await readBody(req) as ExecuteRequestBody & Record<string, unknown>;

      if (!body || typeof body !== "object") {
        sendJson(res, 400, { error: "Request body must be a JSON object" } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // Phase 18Z-PRE: REJECT any `repoPath` field. The worker must NOT
      // supply a host path — the supervisor clones the repo itself.
      // =====================================================================
      if ((body as { repoPath?: unknown }).repoPath !== undefined) {
        sendJson(res, 403, {
          error: "Phase 18Z-PRE: the supervisor does NOT accept a 'repoPath' field. The supervisor clones the repo itself (using the repositoryUrl from the signed capability + a control-plane-resolved credential). The worker cannot supply a host path.",
        } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // Phase 18Y: REJECT any `workload` field. The worker must NOT supply
      // the workload — the supervisor derives it from cap.runtimePlan.
      // =====================================================================
      if ((body as { workload?: unknown }).workload !== undefined) {
        sendJson(res, 403, {
          error: "Phase 18Y: the supervisor does NOT accept a 'workload' field. The workload is derived from cap.runtimePlan (control-plane-signed). The worker cannot supply the workload.",
        } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // Phase 18Z.1: REJECT any `workerId` field. The worker must NOT supply
      // its own identity in the request body — the supervisor reads workerId
      // from the SIGNED capability (cap.workerId). This closes the gap where
      // a worker could lie about its identity and have the manifest signed
      // under a different workerId (which the control plane would then
      // accept, because the manifest signature was valid). The capability
      // signature covers workerId, so the worker cannot forge it.
      // =====================================================================
      if ((body as { workerId?: unknown }).workerId !== undefined) {
        sendJson(res, 403, {
          error: "Phase 18Z.1: the supervisor does NOT accept a 'workerId' field in the request body. The workerId is derived from the signed capability.",
        } satisfies ErrorResponseBody);
        return;
      }

      if (!body.capability) {
        sendJson(res, 403, { error: "No execution capability provided" } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // 1. Verify the ExecutionCapability signature + expiry (PRE-CHECK).
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
      // 2. PRE-CONSUMPTION CHECKS (all deterministic, request-independent).
      //    A failure here returns 403 WITHOUT consuming the nonce — closing
      //    the DoS vector where a malformed request burns the capability.
      // =====================================================================
      const preCheckReasons: string[] = [];

      // 2a. cap.workloadHash is present.
      if (typeof cap.workloadHash !== "string" || cap.workloadHash.length === 0) {
        preCheckReasons.push("cap.workloadHash is missing or empty");
      }

      // 2b. cap.runtimePlan is present and is an object.
      if (!cap.runtimePlan || typeof cap.runtimePlan !== "object" || Array.isArray(cap.runtimePlan)) {
        preCheckReasons.push("cap.runtimePlan is missing or not an object");
      }

      // 2c-2e. Derive the workload from cap.runtimePlan, compute its hash,
      // and compare to cap.workloadHash. Mismatch → 403.
      let derived: ReturnType<typeof deriveWorkloadFromPlan> | null = null;
      if (preCheckReasons.length === 0) {
        try {
          derived = deriveWorkloadFromPlan(cap.runtimePlan);
          const derivedWorkloadHash = computeWorkloadHash(derived);
          if (derivedWorkloadHash !== cap.workloadHash) {
            preCheckReasons.push(
              `workloadHash mismatch — derived=${derivedWorkloadHash.slice(0, 16)}... cap=${cap.workloadHash.slice(0, 16)}...`
            );
          }
        } catch (err) {
          preCheckReasons.push(
            `failed to derive workload from cap.runtimePlan: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // 2f. cap.repositoryUrl is present and is an HTTPS or file:// URL.
      if (typeof cap.repositoryUrl !== "string" || cap.repositoryUrl.length === 0) {
        preCheckReasons.push("cap.repositoryUrl is missing or empty");
      } else if (
        !cap.repositoryUrl.startsWith("https://") &&
        !cap.repositoryUrl.startsWith("file://")
      ) {
        preCheckReasons.push(
          `cap.repositoryUrl must be an HTTPS or file:// URL (got: ${cap.repositoryUrl.slice(0, 60)}...)`
        );
      }

      // 2g. cap.repositoryHeadSha is a 40-hex-char SHA.
      if (typeof cap.repositoryHeadSha !== "string" || !/^[0-9a-f]{40}$/.test(cap.repositoryHeadSha)) {
        preCheckReasons.push(
          `cap.repositoryHeadSha must be a 40-hex-char SHA (got: ${String(cap.repositoryHeadSha).slice(0, 60)})`
        );
      }

      if (preCheckReasons.length > 0) {
        sendJson(res, 403, {
          error: "Phase 18Z-PRE: pre-consumption check failed — capability is malformed or unauthorized. The nonce was NOT consumed (DoS vector closed).",
          reasons: preCheckReasons,
        } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // 3. CONSUME THE CAPABILITY (only after all pre-checks pass).
      //    POST /api/supervisor/consume-capability — the control plane
      //    atomically consumes the nonce + verifies the lease is active.
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
      // 4. CREATE per-execution workspace: /tmp/forge-executions/<executionId>/
      //    Deterministic path — auditable + isolated.
      // =====================================================================
      workspace = join(EXECUTIONS_ROOT, cap.executionId);
      try {
        // Remove any stale workspace from a prior failed run.
        if (existsSync(workspace)) {
          rmSync(workspace, { recursive: true, force: true });
        }
        mkdirSync(workspace, { recursive: true });
      } catch (err) {
        sendJson(res, 500, {
          error: `Failed to create workspace ${workspace}: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // 5. RESOLVE the repository credential.
      //    POST /api/supervisor/resolve-repo-credential { executionId,
      //    repositoryUrl: cap.repositoryUrl } → { cloneUrl }.
      //    The supervisor NEVER asks the worker for a credential.
      // =====================================================================
      const resolveUrl = `${CONTROL_PLANE_URL}/api/supervisor/resolve-repo-credential`;
      let cloneUrl = "";
      try {
        const resolveResp = await fetch(resolveUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPERVISOR_SECRET}`,
          },
          body: JSON.stringify({
            executionId: cap.executionId,
            repositoryUrl: cap.repositoryUrl,
          }),
        });
        if (!resolveResp.ok) {
          let detail = "";
          try {
            const errBody = await resolveResp.json() as { error?: string; reason?: string };
            detail = `${errBody.error ?? "(no error)"}${errBody.reason ? ` [${errBody.reason}]` : ""}`;
          } catch {
            try { detail = await resolveResp.text(); } catch { /* ignore */ }
          }
          sendJson(res, 403, {
            error: `Failed to resolve repository credential for ${cap.repositoryUrl}: ${detail}`,
          } satisfies ErrorResponseBody);
          return;
        }
        const resolveBody = await resolveResp.json() as { cloneUrl?: string; credentialType?: string };
        cloneUrl = resolveBody.cloneUrl ?? "";
        if (!cloneUrl) {
          sendJson(res, 500, {
            error: "Control plane returned 200 but no cloneUrl",
          } satisfies ErrorResponseBody);
          return;
        }
      } catch (err) {
        sendJson(res, 500, {
          error: `Failed to reach resolve-repo-credential endpoint at ${resolveUrl}: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // 6. CLONE the repo at the exact SHA (the supervisor does the clone,
      //    NOT the worker). Use spawnSync with arg array — NO shell.
      // =====================================================================
      const repoDir = join(workspace, "repo");
      const cloneResult = runCommand("/tmp", "git", ["clone", cloneUrl, repoDir], 120000);
      if (cloneResult.status !== 0) {
        sendJson(res, 500, {
          error: `git clone failed (exit ${cloneResult.status}): ${cloneResult.stderr.slice(0, 500)}`,
        } satisfies ErrorResponseBody);
        return;
      }
      const checkoutResult = runCommand(repoDir, "git", ["checkout", cap.repositoryHeadSha], 30000);
      if (checkoutResult.status !== 0) {
        sendJson(res, 403, {
          error: `git checkout ${cap.repositoryHeadSha} failed (exit ${checkoutResult.status}): ${checkoutResult.stderr.slice(0, 500)}`,
          reasons: ["The capability's repositoryHeadSha could not be checked out — the repo may not contain this commit."],
        } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // 7. VERIFY the SHA: git rev-parse HEAD === cap.repositoryHeadSha.
      // =====================================================================
      const revResult = runCommand(repoDir, "git", ["rev-parse", "HEAD"], 10000);
      if (revResult.status !== 0) {
        sendJson(res, 403, {
          error: `git rev-parse HEAD failed: ${revResult.stderr.slice(0, 500)}`,
        } satisfies ErrorResponseBody);
        return;
      }
      const headSha = revResult.stdout.trim();
      if (headSha !== cap.repositoryHeadSha) {
        sendJson(res, 403, {
          error: "Repository HEAD SHA mismatch — the cloned repo's HEAD does not match cap.repositoryHeadSha",
          reasons: [
            `repoHead=${headSha.slice(0, 16)}... cap.repositoryHeadSha=${cap.repositoryHeadSha.slice(0, 16)}...`,
          ],
        } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // 8. VERIFY the FULL tree (defense-in-depth — the clone is fresh so
      //    the tree is clean by construction, but verify anyway).
      // =====================================================================
      // git status --porcelain catches tracked-file modifications.
      const statusResult = runCommand(repoDir, "git", ["status", "--porcelain"], 10000);
      if (statusResult.status !== 0) {
        sendJson(res, 403, {
          error: `git status --porcelain failed: ${statusResult.stderr.slice(0, 500)}`,
        } satisfies ErrorResponseBody);
        return;
      }
      if (statusResult.stdout.trim() !== "") {
        sendJson(res, 403, {
          error: "Repository working tree is NOT clean after clone — unexpected dirty state (the clone should be clean by construction).",
          reasons: [statusResult.stdout.split("\n").slice(0, 5).join("; ")],
        } satisfies ErrorResponseBody);
        return;
      }

      // git clean -nd (dry-run) catches UNTRACKED files.
      const cleanResult = runCommand(repoDir, "git", ["clean", "-nd"], 10000);
      if (cleanResult.status !== 0) {
        sendJson(res, 403, {
          error: `git clean -nd failed: ${cleanResult.stderr.slice(0, 500)}`,
        } satisfies ErrorResponseBody);
        return;
      }
      if (cleanResult.stdout.trim() !== "") {
        sendJson(res, 403, {
          error: "Repository has untracked files after clone — the worker cannot leave junk (the clone should have no untracked files).",
          reasons: [cleanResult.stdout.split("\n").slice(0, 5).join("; ")],
        } satisfies ErrorResponseBody);
        return;
      }

      // git config --get core.hooksPath — catches hook tampering.
      const hooksResult = runCommand(repoDir, "git", ["config", "--get", "core.hooksPath"], 5000);
      // git config --get exits 1 if the key is unset (which is the normal case).
      const hooksPath = hooksResult.status === 0 ? hooksResult.stdout.trim() : "";
      if (hooksPath !== "" && hooksPath !== ".git/hooks") {
        sendJson(res, 403, {
          error: "Repository has a custom core.hooksPath — security risk (the cloned repo's hooks could be attacker-controlled).",
          reasons: [`core.hooksPath=${hooksPath}`],
        } satisfies ErrorResponseBody);
        return;
      }

      // =====================================================================
      // 9. Write plan.json + copy orchestrator.js into the workspace dir.
      //    The substrate bind-mounts `workspace` as `/workspace` inside the
      //    chroot, so the orchestrator sees:
      //      /workspace/plan.json       → <workspace>/plan.json
      //      /workspace/orchestrator.js → <workspace>/orchestrator.js
      //      /workspace/repo/server.js  → <workspace>/repo/server.js
      //      /workspace/results.json    → <workspace>/results.json
      // =====================================================================
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
      // 10. Run the substrate. The nonce + executionId come from the
      //     capability (NOT from the request body) — they're bound into the
      //     launcher signature, so the worker CANNOT override them.
      //
      //     Phase 18Z-A: pass workerId (from the capability — the worker
      //     identity is bound into the manifest) + repositorySha
      //     (cap.repositoryHeadSha — the exact SHA the manifest covers).
      // =====================================================================
      let substrateResult: { result: CommandResult; attestation: SandboxAttestation; manifest: ArtifactManifest | null };
      try {
        substrateResult = await runInSubstrate({
          binary: derived!.binary,
          args: derived!.args,
          cwd: workspace,
          timeoutMs: derived!.timeoutMs,
          includeProc: derived!.includeProc,
          nonce: cap.nonce,
          executionId: cap.executionId,
          launcherKeyPem,
          // Phase 18Z.1: workerId comes from the SIGNED capability (NOT from
          // the request body). The capability signature covers workerId, so
          // the worker cannot lie about its identity.
          workerId: cap.workerId,
          repositorySha: cap.repositoryHeadSha,
        });
      } catch (err) {
        sendJson(res, 500, {
          error: `runInSubstrate failed: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies ErrorResponseBody);
        return;
      }

      const { result, attestation, manifest } = substrateResult;

      // =====================================================================
      // 11. Read results.json from the workspace (if the orchestrator wrote
      //     it). Best-effort — the orchestrator may have crashed.
      // =====================================================================
      let results: unknown = null;
      const resultsPath = join(workspace, "results.json");
      try {
        const raw = readFileSync(resultsPath, "utf-8");
        results = JSON.parse(raw);
      } catch {
        // No results.json — the orchestrator may have crashed. The
        // attestation is still valid (the substrate ran).
      }

      // =====================================================================
      // 11.5 (Phase 18Z-A / 18Z.1): Persist artifacts to the content-addressed store.
      //
      // The manifest's storageRef values point at LOGICAL paths within the
      // workspace (e.g., "logs/install.log", "attestation.json"). The
      // supervisor reads each artifact from <workspace>/<storageRef>, stores
      // it in the ArtifactStore keyed by sha256 (the content-addressed key),
      // and verifies the stored content's hash matches the manifest's
      // declared sha256.
      //
      // The manifest's storageRef is NOT modified — it stays as the launcher
      // signed it (mutating it would break the signature). Consumers retrieve
      // artifacts by sha256 from the store, NOT by storageRef.
      //
      // Phase 18Z.1 — FAIL-CLOSED: if ANY artifact cannot be read, stored, or
      // re-hashed to the declared sha256, the supervisor returns HTTP 500 and
      // does NOT return the manifest. Evidence is untrusted. The control
      // plane's `artifactRetrievable` predicate at submit-runtime-evidence time
      // is a SECONDARY check — the supervisor's persistence is the primary
      // gate. (Before 18Z.1, the supervisor logged warnings + returned 200,
      // which let a worker submit an envelope whose manifest was signed but
      // whose artifacts were never actually persisted → unverifiable at audit
      // time. That gap is now closed.)
      // =====================================================================
      if (manifest && Array.isArray(manifest.entries)) {
        const persistFailures: string[] = [];
        for (const entry of manifest.entries) {
          // Defense-in-depth: reject path traversal in the storageRef before
          // reading from the workspace. (verifyArtifactManifest also checks
          // this, but we check here too so a malicious manifest can't read
          // files outside the workspace.)
          if (
            !entry.path ||
            entry.path.startsWith("/") ||
            entry.path.includes("..") ||
            entry.path.includes("\\")
          ) {
            persistFailures.push(
              `Artifact persistence failed — manifest entry ${entry.artifactId} has a path-traversal storageRef '${entry.path}'. Evidence is untrusted.`
            );
            continue;
          }
          const artifactPath = join(workspace, entry.path);
          if (!existsSync(artifactPath)) {
            persistFailures.push(
              `Artifact persistence failed — manifest entry ${entry.artifactId} file not found at ${entry.path}. Evidence is untrusted.`
            );
            continue;
          }
          let content: Buffer;
          try {
            content = readFileSync(artifactPath);
          } catch (readErr) {
            persistFailures.push(
              `Artifact persistence failed — ${entry.artifactId}: ${readErr instanceof Error ? readErr.message : String(readErr)}. Evidence is untrusted.`
            );
            continue;
          }
          // Store with declared sha256 — the store verifies the content
          // hash matches (throws on mismatch → fail-closed).
          try {
            artifactStore.store(content, entry.sha256);
          } catch (storeErr) {
            persistFailures.push(
              `Artifact persistence failed — ${entry.artifactId}: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}. Evidence is untrusted.`
            );
            continue;
          }
          // Phase 18Z.1: retrieve + re-hash to verify the persisted content
          // matches the declared sha256 (defense-in-depth — catches disk
          // corruption that occurred between store() and the read-back).
          try {
            const retrieved = artifactStore.retrieve(entry.sha256);
            const actualHash = createHash("sha256").update(retrieved).digest("hex");
            if (actualHash !== entry.sha256) {
              persistFailures.push(
                `Artifact persistence failed — ${entry.artifactId}: post-store hash mismatch (declared=${entry.sha256.slice(0, 16)}... actual=${actualHash.slice(0, 16)}...). Evidence is untrusted.`
              );
            }
          } catch (retrieveErr) {
            persistFailures.push(
              `Artifact persistence failed — ${entry.artifactId}: post-store retrieve error: ${retrieveErr instanceof Error ? retrieveErr.message : String(retrieveErr)}. Evidence is untrusted.`
            );
          }
        }
        if (persistFailures.length > 0) {
          sendJson(res, 500, {
            error: `Phase 18Z.1: artifact persistence failed — ${persistFailures.length} failure(s). Evidence is untrusted; the manifest is NOT returned.`,
            reasons: persistFailures,
          } satisfies ErrorResponseBody);
          return;
        }
      }

      // =====================================================================
      // 12. Return the attestation + result + results + manifest. The
      //     launcher key is NEVER in the response.
      // =====================================================================
      // NOTE: we KEEP the workspace for audit (under
      // /tmp/forge-executions/<executionId>/). Failed executions can be
      // inspected post-mortem. A separate GC process should clean up old
      // workspaces (out of scope for 18Z-PRE).
      const responseBody: ExecuteResponseBody = { attestation, result, results, manifest };
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
  console.log("[substrate-supervisor] Phase 18Z-PRE: supervisor clones the repo itself (worker supplies ONLY { capability }, no repoPath).");
  console.log(`[substrate-supervisor] Per-execution workspaces: ${EXECUTIONS_ROOT}/<executionId>/`);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a command synchronously with arg array (NO shell). Returns stdout,
 * stderr, and exit status. Used for git operations during the clone +
 * verify phase (before the substrate is entered).
 *
 * spawnSync is safe here because:
 *   - We pass args as an array (shell: false), so no shell interpolation.
 *   - The commands are short-lived (clone / checkout / status), so blocking
 *     is acceptable.
 *   - The supervisor is single-threaded per request (Node's event loop),
 *     but spawnSync is called only AFTER the async consume-capability +
 *     resolve-repo-credential calls — the long-pole operations are async.
 */
function runCommand(
  cwd: string,
  binary: string,
  args: string[],
  timeoutMs: number
): { status: number; stdout: string; stderr: string } {
  try {
    const result = spawnSync(binary, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (err) {
    return {
      status: -1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

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
