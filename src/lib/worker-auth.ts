// Forge — Phase 8/18J/18P Worker Authentication
//
// Phase 18P: Asymmetric Control-Plane Authority.
//
// The control plane now signs session/execution tokens with its own Ed25519
// private key (FORGE_CONTROL_PLANE_PRIVATE_KEY). The worker verifies with the
// control plane's public key (FORGE_CONTROL_PLANE_PUBLIC_KEY).
//
// A compromised worker that knows FORGE_WORKER_SECRET can NO LONGER forge
// control-plane tokens — it doesn't have the control plane's private key.
//
// For worker→control-plane (registration), the worker signs with its own
// Ed25519 private key (the same key used for evidence signing). The control
// plane verifies with the worker's registered public key.
//
// The HMAC shared secret (FORGE_WORKER_SECRET) is retained ONLY as a
// bootstrap credential for the very first registration (before the worker
// has an Ed25519 key registered). After registration, all subsequent
// tokens use asymmetric signing.
//
// Token claims:
//   tokenType: "REGISTRATION" | "SESSION" | "EXECUTION"
//   iss: "forge-control-plane" (for session/execution tokens)
//   iss: "forge-worker" (for registration tokens)
//   aud: "forge-control-plane" (for registration tokens)
//   aud: "forge-worker" (for session/execution tokens)
//   workerId, executionId, leaseId, projectId, capabilities, iat, exp, nonce
//   signatureAlgorithm: "ed25519" (asymmetric)

import { createHmac, timingSafeEqual, randomUUID, sign as cryptoSign, verify as cryptoVerify, generateKeyPairSync } from "node:crypto";

// Phase 18P: Control-plane Ed25519 keypair for signing session/execution tokens.
// The private key NEVER leaves the control plane. The public key is distributed
// to workers (via FORGE_CONTROL_PLANE_PUBLIC_KEY env var or configuration).
let controlPlanePrivateKeyPem: string | null = null;
let controlPlanePublicKeyPem: string | null = null;

function initControlPlaneKeys(): void {
  // If keys are provided via env, use them.
  const envPrivateKey = process.env.FORGE_CONTROL_PLANE_PRIVATE_KEY;
  const envPublicKey = process.env.FORGE_CONTROL_PLANE_PUBLIC_KEY;

  if (envPrivateKey && envPublicKey) {
    controlPlanePrivateKeyPem = envPrivateKey;
    controlPlanePublicKeyPem = envPublicKey;
    return;
  }

  // If only public key is provided (verification-only mode), use it.
  if (envPublicKey) {
    controlPlanePublicKeyPem = envPublicKey;
    // Private key not available — can verify but not sign.
    // This is appropriate for worker-side verification.
    return;
  }

  // Development mode: auto-generate a keypair (NOT for production).
  if (process.env.NODE_ENV !== "production") {
    console.warn("[worker-auth] WARNING: FORGE_CONTROL_PLANE_PRIVATE_KEY/PUBLIC_KEY not set — generating ephemeral keypair (development only)");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    controlPlanePrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    controlPlanePublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    return;
  }

  // Production: keys are REQUIRED.
  console.error("[worker-auth] FATAL: FORGE_CONTROL_PLANE_PRIVATE_KEY and FORGE_CONTROL_PLANE_PUBLIC_KEY are required in production.");
  console.error("[worker-auth] Generate with: node -e \"const c=require('crypto');const {privateKey,publicKey}=c.generateKeyPairSync('ed25519');console.log('PRIVATE:',privateKey.export({type:'pkcs8',format:'pem'}).toString());console.log('PUBLIC:',publicKey.export({type:'spki',format:'pem'}).toString())\"");
}

initControlPlaneKeys();

// Legacy HMAC secret — retained ONLY for bootstrap registration.
const WORKER_SECRET = process.env.FORGE_WORKER_SECRET;

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
  signatureAlgorithm: "ed25519" | "hmac";
  signature: string;
}

const usedNonces = new Set<string>();
const MAX_NONCE_CACHE = 10000;

// Phase 18P: Valid issuer/audience pairs.
const VALID_PAIRS: Record<string, string[]> = {
  "forge-control-plane": ["forge-worker"],
  "forge-worker": ["forge-control-plane"],
};

const TOKEN_TYPE_CONSTRAINTS: Record<TokenType, { iss: string; aud: string }> = {
  REGISTRATION: { iss: "forge-worker", aud: "forge-control-plane" },
  SESSION: { iss: "forge-control-plane", aud: "forge-worker" },
  EXECUTION: { iss: "forge-control-plane", aud: "forge-worker" },
};

function canonicalTokenData(payload: Omit<WorkerToken, "signature">): string {
  return [
    payload.tokenType, payload.iss, payload.aud, payload.workerId,
    payload.executionId || "", payload.leaseId || "", payload.projectId || "",
    JSON.stringify(payload.capabilities), payload.iat, payload.exp, payload.nonce,
    payload.signatureAlgorithm,
  ].join(".");
}

// Phase 18P: Sign with Ed25519 (control-plane private key).
function signWithEd25519(payload: Omit<WorkerToken, "signature">): string {
  const data = Buffer.from(canonicalTokenData(payload), "utf-8");
  return cryptoSign(null, data, controlPlanePrivateKeyPem!).toString("hex");
}

// Phase 18P: Verify with Ed25519 (control-plane public key).
function verifyWithEd25519(payload: Omit<WorkerToken, "signature">, signature: string): boolean {
  if (!controlPlanePublicKeyPem) return false;
  const data = Buffer.from(canonicalTokenData(payload), "utf-8");
  const sigBuf = Buffer.from(signature, "hex");
  try {
    return cryptoVerify(null, data, controlPlanePublicKeyPem, sigBuf);
  } catch {
    return false;
  }
}

// Legacy HMAC signing (bootstrap registration only).
function signWithHmac(payload: Omit<WorkerToken, "signature">): string {
  const data = canonicalTokenData(payload);
  return createHmac("sha256", WORKER_SECRET || "").update(data).digest("hex");
}

function verifyWithHmac(payload: Omit<WorkerToken, "signature">, signature: string): boolean {
  const expected = signWithHmac(payload);
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Create a worker registration token.
 * Phase 18P: Uses HMAC for bootstrap only (worker doesn't have Ed25519 key yet).
 * After first registration, the worker's Ed25519 key is used for all subsequent auth.
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
    signatureAlgorithm: "hmac", // Bootstrap: HMAC (worker has no Ed25519 key yet)
  };
  const token: WorkerToken = { ...payload, signature: signWithHmac(payload) };
  return `Bearer ${Buffer.from(JSON.stringify(token)).toString("base64")}`;
}

/**
 * Create a worker session token (issued by control plane after registration).
 * Phase 18P: Signed with control-plane Ed25519 private key.
 */
export function createWorkerSessionToken(workerId: string, capabilities: string[]): string {
  if (!controlPlanePrivateKeyPem) {
    throw new Error("Cannot create session token: control-plane private key not available");
  }
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
    signatureAlgorithm: "ed25519", // Asymmetric: control-plane private key
  };
  const token: WorkerToken = { ...payload, signature: signWithEd25519(payload) };
  return `Bearer ${Buffer.from(JSON.stringify(token)).toString("base64")}`;
}

/**
 * Create an execution-specific token (for heartbeat/complete/evidence with lease).
 * Phase 18P: Signed with control-plane Ed25519 private key.
 */
export function createExecutionToken(
  workerId: string,
  executionId: string,
  leaseId: string,
  projectId: string,
  capabilities: string[]
): string {
  if (!controlPlanePrivateKeyPem) {
    throw new Error("Cannot create execution token: control-plane private key not available");
  }
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
    signatureAlgorithm: "ed25519", // Asymmetric: control-plane private key
  };
  const token: WorkerToken = { ...payload, signature: signWithEd25519(payload) };
  return `Bearer ${Buffer.from(JSON.stringify(token)).toString("base64")}`;
}

/**
 * Verify a worker token from the Authorization header.
 *
 * Phase 18P: Supports both Ed25519 (asymmetric) and HMAC (legacy bootstrap).
 * - Ed25519 tokens are verified with the control-plane public key.
 * - HMAC tokens are accepted ONLY for REGISTRATION type (bootstrap).
 * - SESSION and EXECUTION tokens MUST be Ed25519 (not HMAC).
 */
export function verifyWorkerToken(
  authHeader: string | null,
  expectedTokenType?: TokenType
): WorkerToken | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;

  try {
    const tokenStr = authHeader.slice(7);
    const token = JSON.parse(Buffer.from(tokenStr, "base64").toString("utf-8")) as WorkerToken;

    if (!token.workerId || !token.signature || !token.iss || !token.aud || !token.exp || !token.nonce) {
      return null;
    }

    if (!token.tokenType || !["REGISTRATION", "SESSION", "EXECUTION"].includes(token.tokenType)) {
      return null;
    }

    if (expectedTokenType && token.tokenType !== expectedTokenType) {
      return null;
    }

    const constraints = TOKEN_TYPE_CONSTRAINTS[token.tokenType];
    if (token.iss !== constraints.iss || token.aud !== constraints.aud) {
      return null;
    }

    const validAudiences = VALID_PAIRS[token.iss];
    if (!validAudiences || !validAudiences.includes(token.aud)) {
      return null;
    }

    const now = Date.now();
    if (now > token.exp) return null;
    if (token.iat > now + 60000) return null;

    const isExecutionToken = token.tokenType === "EXECUTION";
    if (!isExecutionToken && usedNonces.has(token.nonce)) {
      return null;
    }

    // Phase 18P: Enforce signature algorithm by token type.
    // SESSION and EXECUTION MUST use Ed25519 (not HMAC).
    // REGISTRATION may use HMAC (bootstrap) or Ed25519.
    if (token.tokenType === "SESSION" || token.tokenType === "EXECUTION") {
      if (token.signatureAlgorithm !== "ed25519") {
        // Reject HMAC session/execution tokens — a worker with the shared
        // secret could forge these. Only Ed25519 is accepted.
        return null;
      }
    }

    // Verify signature based on algorithm.
    let signatureValid = false;
    if (token.signatureAlgorithm === "ed25519") {
      signatureValid = verifyWithEd25519(token, token.signature);
    } else if (token.signatureAlgorithm === "hmac") {
      // HMAC only for registration bootstrap.
      if (!WORKER_SECRET) return null;
      signatureValid = verifyWithHmac(token, token.signature);
    } else {
      return null; // Unknown algorithm.
    }

    if (!signatureValid) return null;

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

export function getWorkerToken(req: Request, expectedTokenType?: TokenType): WorkerToken | null {
  const authHeader = req.headers.get("authorization");
  return verifyWorkerToken(authHeader, expectedTokenType);
}

/**
 * Phase 18P: Get the control-plane public key (for distribution to workers).
 */
export function getControlPlanePublicKey(): string | null {
  return controlPlanePublicKeyPem;
}

/**
 * Phase 18X-B: Get the control-plane PRIVATE key (PEM).
 *
 * This is the SAME Ed25519 key used to sign session/execution tokens in
 * Phase 18P. Phase 18X-B uses it to sign ExecutionCapability objects that
 * the substrate supervisor verifies before running a workload.
 *
 * Returns null when the key is unavailable — i.e., when this process is in
 * verification-only mode (only FORGE_CONTROL_PLANE_PUBLIC_KEY was provisioned,
 * which is the configuration workers use). Callers MUST handle null and
 * fail-closed (do NOT sign capabilities without a key — an unsigned capability
 * is rejected by the supervisor).
 *
 * SECURITY: this key NEVER leaves the control-plane process. Do NOT expose
 * it via an HTTP endpoint, log it, or return it from any worker-facing API.
 * Only control-plane signing paths (token issuance, capability issuance) may
 * call this function.
 */
export function getControlPlanePrivateKey(): string | null {
  return controlPlanePrivateKeyPem;
}
