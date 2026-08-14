// Forge — Real Secret Store (AES-256-GCM).
//
// Replaces the reversible XOR+base64 obfuscation in the old crypto.ts.
//
// Design:
// - Master key sourced from the FORGE_MASTER_KEY environment variable.
// - NO default key in production. If the env var is missing in production,
//   every encrypt/decrypt call throws. In development a derived dev key is
//   used with a loud warning so local workflows still work.
// - The master key is normalized to a 32-byte (256-bit) Buffer:
//     * 64-char hex string  -> 32 raw bytes
//     * 44-char base64 string (32 bytes) -> 32 raw bytes
//     * any other string -> scrypt(passphrase, fixed-salt, 32)
// - Encrypted envelope format: `v1:{nonce_b64}:{ciphertext_b64}:{authTag_b64}`
//   The `v1:` prefix allows future key rotation / versioned ciphertexts.
// - AES-256-GCM provides confidentiality + integrity (auth tag detects
//   tampering). Auth tag verification failure throws — never returns empty.
//
// Security invariants:
// - Plaintext secrets are NEVER logged.
// - Plaintext secrets are NEVER included in LLM prompts.
// - The master key itself is NEVER logged.

import nodeCrypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENV_KEY = "FORGE_MASTER_KEY";
const ENVELOPE_VERSION = "v1";
const NONCE_BYTES = 12; // 96-bit nonce — standard for GCM
const AUTH_TAG_BYTES = 16; // 128-bit auth tag — standard for GCM
const KEY_BYTES = 32; // 256-bit key for AES-256
const ALGO = "aes-256-gcm";
const DEV_KEY_WARNING =
  "[forge:secret-store] FORGE_MASTER_KEY not set — using derived dev key. " +
  "DO NOT use in production. Set FORGE_MASTER_KEY to a 32-byte hex/base64 " +
  "string or a strong passphrase.";
const DEV_PASSPHRASE = "forge-local-dev-master-key-insecure-do-not-use-in-prod";
const SCRYPT_SALT = "forge-master-key-scrypt-salt-v1";
const SCRYPT_N = 16384; // CPU/memory cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;

// ---------------------------------------------------------------------------
// Master key resolution (cached per-process)
// ---------------------------------------------------------------------------

let _cachedKey: Buffer | null = null;
let _cachedKeyProdError = false;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Normalize the FORGE_MASTER_KEY env var into a 32-byte Buffer.
 *
 * Accepts:
 *  - 64-char hex string (32 bytes)
 *  - 44-char base64 string (32 bytes with padding)
 *  - any other non-empty string (derived via scrypt)
 */
function deriveKey(input: string): Buffer {
  if (!input) {
    throw new Error("deriveKey: empty input");
  }
  // Hex form: 64 hex chars => 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return Buffer.from(input, "hex");
  }
  // Base64 form: try to decode; if it yields exactly 32 bytes, use it.
  // Base64 of 32 raw bytes is 44 chars with '=' padding (or 43 without).
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(input) && input.length >= 43 && input.length <= 44) {
    try {
      const buf = Buffer.from(input, "base64");
      if (buf.length === KEY_BYTES) return buf;
    } catch {
      // fall through to scrypt
    }
  }
  // Otherwise treat as a passphrase and derive via scrypt.
  return nodeCrypto.scryptSync(input, SCRYPT_SALT, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
}

/**
 * Resolve the master key. Throws in production if FORGE_MASTER_KEY is missing.
 * In non-production, falls back to a derived dev key with a warning.
 */
function getMasterKey(): Buffer {
  if (_cachedKey) return _cachedKey;
  if (_cachedKeyProdError) {
    // We already know production is misconfigured; throw the same error
    // immediately rather than re-evaluating env on every call.
    throw new Error(
      `[forge:secret-store] ${ENV_KEY} is required in production. ` +
        `Set it to a 32-byte hex/base64 string or a strong passphrase.`
    );
  }

  const raw = process.env[ENV_KEY];
  if (!raw) {
    if (isProduction()) {
      _cachedKeyProdError = true;
      throw new Error(
        `[forge:secret-store] ${ENV_KEY} is required in production. ` +
          `Set it to a 32-byte hex/base64 string or a strong passphrase.`
      );
    }
    // Dev fallback. Use console.warn (single emission per process is fine;
    // caching the key prevents repeated warnings on every call).
    if (process.env.FORGE_SUPPRESS_DEV_KEY_WARNING !== "1") {
      // eslint-disable-next-line no-console
      console.warn(DEV_KEY_WARNING);
    }
    _cachedKey = deriveKey(DEV_PASSPHRASE);
    return _cachedKey;
  }

  _cachedKey = deriveKey(raw);
  return _cachedKey;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if a master key can be resolved without throwing.
 * In production this is false unless FORGE_MASTER_KEY is set.
 */
export function isSecretConfigured(): boolean {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a plaintext secret with AES-256-GCM.
 *
 * Returns an envelope string of the form:
 *   `v1:{nonce_b64}:{ciphertext_b64}:{authTag_b64}`
 *
 * Throws if the master key is not available.
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new Error("encryptSecret: plaintext must be a string");
  }
  const key = getMasterKey();
  const nonce = nodeCrypto.randomBytes(NONCE_BYTES);
  const cipher = nodeCrypto.createCipheriv(ALGO, key, nonce);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    nonce.toString("base64"),
    ct.toString("base64"),
    authTag.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a `v1:` envelope produced by encryptSecret.
 *
 * Verifies the GCM auth tag — throws on tampering or wrong key.
 * Throws on unsupported envelope versions or malformed input.
 */
export function decryptSecret(encrypted: string): string {
  if (typeof encrypted !== "string" || encrypted.length === 0) {
    throw new Error("decryptSecret: empty input");
  }
  if (!encrypted.startsWith(`${ENVELOPE_VERSION}:`)) {
    throw new Error(
      `decryptSecret: unsupported envelope (expected '${ENVELOPE_VERSION}:' prefix). ` +
        `Legacy XOR-obfuscated values are not supported — re-store the secret.`
    );
  }
  const parts = encrypted.split(":");
  // ["v1", nonce, ct, authTag]
  if (parts.length !== 4) {
    throw new Error("decryptSecret: malformed envelope (expected 4 segments)");
  }
  const [, nonceB64, ctB64, authTagB64] = parts;
  if (!nonceB64 || !ctB64 || !authTagB64) {
    throw new Error("decryptSecret: malformed envelope (empty segment)");
  }

  const key = getMasterKey();
  let nonce: Buffer;
  let ct: Buffer;
  let authTag: Buffer;
  try {
    nonce = Buffer.from(nonceB64, "base64");
    ct = Buffer.from(ctB64, "base64");
    authTag = Buffer.from(authTagB64, "base64");
  } catch {
    throw new Error("decryptSecret: invalid base64 in envelope");
  }
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(
      `decryptSecret: invalid nonce length (${nonce.length}, expected ${NONCE_BYTES})`
    );
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(
      `decryptSecret: invalid auth tag length (${authTag.length}, expected ${AUTH_TAG_BYTES})`
    );
  }

  const decipher = nodeCrypto.createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(authTag);
  let pt: Buffer;
  try {
    pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err: any) {
    // Auth-tag mismatch = wrong key or tampered ciphertext.
    throw new Error(
      `decryptSecret: authentication failed (wrong key or tampered ciphertext): ${err?.message ?? String(err)}`
    );
  }
  return pt.toString("utf8");
}

/**
 * Mask a secret for display. Returns `first 4 + •••• + last 4`.
 * Short values (<=8 chars) are fully redacted.
 */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return value.slice(0, 4) + "••••" + value.slice(-4);
}

/**
 * Decrypt a secret, returning null on any failure. Useful for call sites
 * that prefer to treat undecryptable values as "missing" rather than throw.
 * The original error is swallowed deliberately — never logged at info level
 * because it could leak envelope metadata. Callers may inspect via callback
 * if they need the error.
 */
export function decryptSecretOrNull(
  encrypted: string | null | undefined,
  onError?: (err: Error) => void
): string | null {
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted);
  } catch (err: any) {
    if (onError) onError(err instanceof Error ? err : new Error(String(err)));
    return null;
  }
}
