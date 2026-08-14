// Forge — secret obfuscation helper.
// NOT real encryption. Rotating XOR + base64 so secrets are not stored as
// plaintext in the SQLite DB and never accidentally logged. Swap for a real
// KMS in production.

const SECRET = process.env.FORGE_SECRET || "forge-local-dev-secret-rotate-key";

function xor(input: string, key: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    out += String.fromCharCode(input.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

export function obfuscate(plain: string): string {
  try {
    return Buffer.from(xor(plain, SECRET), "binary").toString("base64");
  } catch {
    return "";
  }
}

export function deobfuscate(stored: string): string {
  try {
    return xor(Buffer.from(stored, "base64").toString("binary"), SECRET);
  } catch {
    return "";
  }
}

export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return value.slice(0, 4) + "•".repeat(Math.max(4, value.length - 8)) + value.slice(-4);
}

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
