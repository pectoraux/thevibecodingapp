// Forge — Phase 8/18J Worker Authentication
//
// Phase 18J: Token type scoping + issuer/audience enforcement.
//
// KNOWN LIMITATION (documented honestly):
//   The HMAC shared secret (FORGE_WORKER_SECRET) is used for both signing
//   and verification. A worker that knows this secret can theoretically
//   forge control-plane tokens. Full asymmetric control-plane authority
//   (separate control-plane key pair) is future work (Phase 18K).
//
//   What IS fixed in 18J:
//     1. Token type field (REGISTRATION/SESSION/EXECUTION) — endpoints enforce.
//     2. Valid issuer/audience pairs — not all combinations accepted.
//     3. Registration tokens cannot be used for execution endpoints.
//
// Token claims:
//   tokenType: "REGISTRATION" | "SESSION" | "EXECUTION"
//   iss: "forge-control-plane" (for session/execution tokens)
//   iss: "forge-worker" (for registration tokens)
//   aud: "forge-control-plane" (for registration tokens)
//   aud: "forge-worker" (for session/execution tokens)
//   workerId, executionId, leaseId, projectId, capabilities, iat, exp, nonce

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

const WORKER_SECRET = process.env.FORGE_WORKER_SECRET;

if (!WORKER_SECRET) {
  console.error("[worker-auth] WARNING: FORGE_WORKER_SECRET not set — worker endpoints will be unauthenticated");
}

export type TokenType = "REGISTRATION" | "SESSION" | "EXECUTION";

export interface WorkerToken {
  tokenType: TokenType;
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
    payload.tokenType, payload.iss, payload.aud, payload.workerId,
    payload.executionId || "", payload.leaseId || "", payload.projectId || "",
    JSON.stringify(payload.capabilities), payload.iat, payload.exp, payload.nonce,
  ].join(".");
  return createHmac("sha256", WORKER_SECRET || "").update(data).digest("hex");
}

/**
 * Phase 18J: Valid issuer/audience pairs.
 * Only these combinations are accepted — not all four.
 */
const VALID_PAIRS: Record<string, string[]> = {
  "forge-control-plane": ["forge-worker"],     // Control plane → worker (session/execution)
  "forge-worker": ["forge-control-plane"],      // Worker → control plane (registration)
};

/**
 * Phase 18J: Token type → required issuer/audience pair.
 */
const TOKEN_TYPE_CONSTRAINTS: Record<TokenType, { iss: string; aud: string }> = {
  REGISTRATION: { iss: "forge-worker", aud: "forge-control-plane" },
  SESSION: { iss: "forge-control-plane", aud: "forge-worker" },
  EXECUTION: { iss: "forge-control-plane", aud: "forge-worker" },
};

/**
 * Create a worker registration token (used by the worker to bootstrap).
 * This uses the shared secret as a bootstrap credential.
 */
export function createRegistrationToken(workerId: string, capabilities: string[]): string {
  const now = Date.now();
  const payload: Omit<WorkerToken, "signature"> = {
    tokenType: "REGISTRATION",
    iss: "forge-worker",
    aud: "forge-control-plane",
    workerId,
    capabilities,
    iat: now,
    exp: now + 60000,
    nonce: randomUUID(),
  };
  const token: WorkerToken = { ...payload, signature: signTokenPayload(payload) };
  return `Bearer ${Buffer.from(JSON.stringify(token)).toString("base64")}`;
}

/**
 * Create a worker session token (issued by control plane after registration).
 * Used for claim operations.
 */
export function createWorkerSessionToken(workerId: string, capabilities: string[]): string {
  const now = Date.now();
  const payload: Omit<WorkerToken, "signature"> = {
    tokenType: "SESSION",
    iss: "forge-control-plane",
    aud: "forge-worker",
    workerId,
    capabilities,
    iat: now,
    exp: now + 300000,
    nonce: randomUUID(),
  };
  const token: WorkerToken = { ...payload, signature: signTokenPayload(payload) };
  return `Bearer ${Buffer.from(JSON.stringify(token)).toString("base64")}`;
}

/**
 * Create an execution-specific token (for heartbeat/complete/evidence with lease).
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
    tokenType: "EXECUTION",
    iss: "forge-control-plane",
    aud: "forge-worker",
    workerId,
    executionId,
    leaseId,
    projectId,
    capabilities,
    iat: now,
    exp: now + 300000,
    nonce: randomUUID(),
  };
  const token: WorkerToken = { ...payload, signature: signTokenPayload(payload) };
  return `Bearer ${Buffer.from(JSON.stringify(token)).toString("base64")}`;
}

/**
 * Verify a worker token from the Authorization header.
 * Returns the token if valid, null otherwise.
 *
 * Phase 18J: Enforces token type, valid issuer/audience pairs, and replay.
 *
 * @param expectedTokenType If provided, the token must match this type.
 *   Endpoints should pass their expected type to enforce scoping.
 */
export function verifyWorkerToken(
  authHeader: string | null,
  expectedTokenType?: TokenType
): WorkerToken | null {
  if (!WORKER_SECRET) return null;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;

  try {
    const tokenStr = authHeader.slice(7);
    const token = JSON.parse(Buffer.from(tokenStr, "base64").toString("utf-8")) as WorkerToken;

    // Verify required fields.
    if (!token.workerId || !token.signature || !token.iss || !token.aud || !token.exp || !token.nonce) {
      return null;
    }

    // Phase 18J: Verify tokenType is present and valid.
    if (!token.tokenType || !["REGISTRATION", "SESSION", "EXECUTION"].includes(token.tokenType)) {
      return null;
    }

    // Phase 18J: Enforce expected token type if specified.
    if (expectedTokenType && token.tokenType !== expectedTokenType) {
      return null;
    }

    // Phase 18J: Enforce valid issuer/audience pair for this token type.
    const constraints = TOKEN_TYPE_CONSTRAINTS[token.tokenType];
    if (token.iss !== constraints.iss || token.aud !== constraints.aud) {
      return null;
    }

    // Phase 18J: Also check against the valid pairs table.
    const validAudiences = VALID_PAIRS[token.iss];
    if (!validAudiences || !validAudiences.includes(token.aud)) {
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

    // Phase 18I: Replay protection — only for non-execution tokens.
    const isExecutionToken = token.tokenType === "EXECUTION";
    if (!isExecutionToken && usedNonces.has(token.nonce)) {
      return null;
    }

    // Verify signature.
    const expectedSignature = signTokenPayload({
      tokenType: token.tokenType,
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
    if (!isExecutionToken) {
      usedNonces.add(token.nonce);
    }
    if (usedNonces.size > MAX_NONCE_CACHE) {
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
 *
 * Phase 18J: Accepts an optional expectedTokenType for endpoint-specific scoping.
 */
export function getWorkerToken(req: Request, expectedTokenType?: TokenType): WorkerToken | null {
  const authHeader = req.headers.get("authorization");
  return verifyWorkerToken(authHeader, expectedTokenType);
}
