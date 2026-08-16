// Forge — Phase 8 Worker Authentication
//
// Restores the HMAC security boundary on all worker API endpoints.
// Every worker endpoint requires a valid signed token — no exceptions.
//
// The token is signed with FORGE_WORKER_SECRET (shared between control plane
// and worker). It establishes worker identity cryptographically.
//
// Token claims:
//   iss: "forge-control-plane" (for control-plane-issued tokens)
//   iss: "forge-worker" (for worker-issued registration tokens)
//   aud: "forge-worker"
//   workerId: the worker's identity
//   executionId: the job being executed (for execution-specific tokens)
//   leaseId: the lease identifier (for heartbeat/complete tokens)
//   capabilities: what the worker can do
//   iat/exp: validity window
//   nonce: replay protection

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

const WORKER_SECRET = process.env.FORGE_WORKER_SECRET;

if (!WORKER_SECRET) {
  console.error("[worker-auth] WARNING: FORGE_WORKER_SECRET not set — worker endpoints will be unauthenticated");
}

export interface WorkerToken {
  iss: string;
  aud: string;
  workerId: string;
  executionId?: string;
  leaseId?: string;
  projectId?: string;
  capabilities: string[];
  iat: number;
  exp: number;
  nonce: string;
  signature: string;
}

// Track used nonces for replay protection.
const usedNonces = new Set<string>();
const MAX_NONCE_CACHE = 10000;

function signTokenPayload(payload: Omit<WorkerToken, "signature">): string {
  const data = [
    payload.iss, payload.aud, payload.workerId,
    payload.executionId || "", payload.leaseId || "", payload.projectId || "",
    JSON.stringify(payload.capabilities), payload.iat, payload.exp, payload.nonce,
  ].join(".");
  return createHmac("sha256", WORKER_SECRET || "").update(data).digest("hex");
}

/**
 * Create a worker registration token (used by the worker to bootstrap).
 * This uses the shared secret as a bootstrap credential.
 */
export function createRegistrationToken(workerId: string, capabilities: string[]): string {
  const now = Date.now();
  const payload: Omit<WorkerToken, "signature"> = {
    iss: "forge-worker",
    aud: "forge-control-plane",
    workerId,
    capabilities,
    iat: now,
    exp: now + 60000, // 60 seconds — registration token is short-lived
    nonce: randomUUID(),
  };
  const token: WorkerToken = { ...payload, signature: signTokenPayload(payload) };
  return `Bearer ${Buffer.from(JSON.stringify(token)).toString("base64")}`;
}

/**
 * Create a worker session token (issued by control plane after registration).
 * Used for claim, heartbeat, complete operations.
 */
export function createWorkerSessionToken(workerId: string, capabilities: string[]): string {
  const now = Date.now();
  const payload: Omit<WorkerToken, "signature"> = {
    iss: "forge-control-plane",
    aud: "forge-worker",
    workerId,
    capabilities,
    iat: now,
    exp: now + 300000, // 5 minutes
    nonce: randomUUID(),
  };
  const token: WorkerToken = { ...payload, signature: signTokenPayload(payload) };
  return `Bearer ${Buffer.from(JSON.stringify(token)).toString("base64")}`;
}

/**
 * Create an execution-specific token (for heartbeat/complete with lease).
 */
export function createExecutionToken(
  workerId: string,
  executionId: string,
  leaseId: string,
  projectId: string,
  capabilities: string[]
): string {
  const now = Date.now();
  const payload: Omit<WorkerToken, "signature"> = {
    iss: "forge-control-plane",
    aud: "forge-worker",
    workerId,
    executionId,
    leaseId,
    projectId,
    capabilities,
    iat: now,
    exp: now + 300000, // 5 minutes
    nonce: randomUUID(),
  };
  const token: WorkerToken = { ...payload, signature: signTokenPayload(payload) };
  return `Bearer ${Buffer.from(JSON.stringify(token)).toString("base64")}`;
}

/**
 * Verify a worker token from the Authorization header.
 * Returns the token if valid, null otherwise.
 * Checks: signature, issuer, audience, expiry, replay.
 */
export function verifyWorkerToken(authHeader: string | null): WorkerToken | null {
  if (!WORKER_SECRET) return null;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;

  try {
    const tokenStr = authHeader.slice(7);
    const token = JSON.parse(Buffer.from(tokenStr, "base64").toString("utf-8")) as WorkerToken;

    // Verify required fields.
    if (!token.workerId || !token.signature || !token.iss || !token.aud || !token.exp || !token.nonce) {
      return null;
    }

    // Verify issuer (must be forge-control-plane for session/execution tokens,
    // or forge-worker for registration tokens).
    if (token.iss !== "forge-control-plane" && token.iss !== "forge-worker") {
      return null;
    }

    // Verify audience.
    if (token.aud !== "forge-worker" && token.aud !== "forge-control-plane") {
      return null;
    }

    // Verify expiry.
    const now = Date.now();
    if (now > token.exp) {
      return null;
    }

    // Verify not-issued-in-future.
    if (token.iat > now + 60000) {
      return null;
    }

    // Phase 18I: Replay protection — only for registration/session tokens.
    // Execution tokens (with executionId + leaseId) are DESIGNED for repeated
    // use (heartbeat, complete, submit-evidence). They must NOT be single-use.
    // The lease itself is the fencing mechanism for execution tokens —
    // if the lease is expired or reclaimed, the endpoint checks that.
    const isExecutionToken = !!token.executionId && !!token.leaseId;
    if (!isExecutionToken && usedNonces.has(token.nonce)) {
      return null;
    }

    // Verify signature.
    const expectedSignature = signTokenPayload({
      iss: token.iss,
      aud: token.aud,
      workerId: token.workerId,
      executionId: token.executionId,
      leaseId: token.leaseId,
      projectId: token.projectId,
      capabilities: token.capabilities,
      iat: token.iat,
      exp: token.exp,
      nonce: token.nonce,
    });

    const a = Buffer.from(token.signature, "hex");
    const b = Buffer.from(expectedSignature, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return null;
    }

    // Phase 18I: Only mark nonce as used for non-execution tokens.
    // Execution tokens are reusable within their lease period.
    if (!isExecutionToken) {
      usedNonces.add(token.nonce);
    }
    if (usedNonces.size > MAX_NONCE_CACHE) {
      // Simple cleanup — clear half.
      const iter = usedNonces.values();
      for (let i = 0; i < MAX_NONCE_CACHE / 2; i++) {
        iter.next();
        usedNonces.delete(iter.next().value);
      }
    }

    return token;
  } catch {
    return null;
  }
}

/**
 * Extract and verify a worker token from a Next.js Request.
 * Returns the token if valid, null otherwise.
 */
export function getWorkerToken(req: Request): WorkerToken | null {
  const authHeader = req.headers.get("authorization");
  return verifyWorkerToken(authHeader);
}
