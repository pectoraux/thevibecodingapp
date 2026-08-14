// Forge — content hashing helpers.
//
// The reversible XOR obfuscation that used to live here has been replaced by
// the real AES-256-GCM secret store in `./secret-store.ts`. This module now
// only contains:
//   - sha256 / shortSha   — content fingerprinting (NOT cryptographic; used
//                            for architecture version hashes)
//   - re-exports of encryptSecret / decryptSecret / maskSecret /
//     isSecretConfigured / decryptSecretOrNull for backward compatibility
//     with callers that import from "@/lib/crypto".
//
// All real secret storage MUST go through `encryptSecret` / `decryptSecret`.

export {
  encryptSecret,
  decryptSecret,
  decryptSecretOrNull,
  maskSecret,
  isSecretConfigured,
} from "@/lib/secret-store";

// ---------------------------------------------------------------------------
// Content fingerprinting (NOT cryptographic — used for architecture versions)
// ---------------------------------------------------------------------------

export function sha256(input: string): string {
  // Lightweight FNV-1a + djb2 hybrid hash for content fingerprinting.
  // Not cryptographic, but stable and collision-resistant enough for
  // architecture version hashes in this demo.
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  // mix
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
  h2 = Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35);
  const hex = (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  return hex + hex; // 32 chars
}

export function shortSha(input: string): string {
  return sha256(input).slice(0, 7);
}
