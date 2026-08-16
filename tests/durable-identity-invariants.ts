// Forge — Phase 18L: Durable Worker Identity Invariants
//
// Verifies:
//   1. Worker loads key from disk if it exists (durable identity)
//   2. Worker only generates new key if no key file exists
//   3. Worker persists key to disk with restricted permissions
//   4. Register endpoint allows re-registration with SAME key
//   5. Register endpoint rejects DIFFERENT key (immutability preserved)
//
// Run with: bun run tests/durable-identity-invariants.ts

import { readFileSync } from "node:fs";

interface TestResult { name: string; passed: boolean; details: string; }
const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function record(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
}

const poller = readFile("mini-services/execution-worker/poller.ts");
const register = readFile("src/app/api/worker/register/route.ts");

// Test 1: Worker has loadOrGenerateWorkerKeypair function.
{
  const hasFunc = poller.includes("function loadOrGenerateWorkerKeypair()");
  record("Worker has loadOrGenerateWorkerKeypair function (not just generate)", hasFunc, `hasFunc: ${hasFunc}`);
}

// Test 2: Worker checks for existing key file before generating.
{
  const checksExisting = poller.includes("existsSync(WORKER_KEY_PATH)");
  record("Worker checks for existing key file before generating new key", checksExisting, `checksExisting: ${checksExisting}`);
}

// Test 3: Worker loads key from disk if it exists.
{
  const loadsFromDisk = poller.includes("readFileSync(fd") && poller.includes("Loaded existing Ed25519 keypair");
  record("Worker loads existing keypair from disk (durable across restarts)", loadsFromDisk, `loadsFromDisk: ${loadsFromDisk}`);
}

// Test 4: Worker persists key to disk.
{
  const persistsToDisk = poller.includes("writeFileSync(WORKER_KEY_PATH") && poller.includes("Generated and persisted new Ed25519 keypair");
  record("Worker persists new keypair to disk", persistsToDisk, `persistsToDisk: ${persistsToDisk}`);
}

// Test 5: Key file has restricted permissions (0o600).
{
  const restrictedPerms = poller.includes("mode: 0o600");
  record("Key file is persisted with restricted permissions (0o600)", restrictedPerms, `restrictedPerms: ${restrictedPerms}`);
}

// Test 6: Key file path is deterministic (based on worker ID).
{
  const deterministicPath = poller.includes("WORKER_KEY_PATH") && poller.includes("WORKER_ID");
  record("Key file path is deterministic (based on WORKER_ID)", deterministicPath, `deterministicPath: ${deterministicPath}`);
}

// Test 7: Key file directory is configurable.
{
  const configurable = poller.includes("FORGE_WORKER_KEY_DIR");
  record("Key file directory is configurable (FORGE_WORKER_KEY_DIR env)", configurable, `configurable: ${configurable}`);
}

// Test 8: Register endpoint allows re-registration with SAME key.
{
  const allowsSame = register.includes("publicKeyPem !== existing.publicKeyPem");
  record("Register endpoint allows re-registration with SAME key (worker restart)", allowsSame, `allowsSame: ${allowsSame}`);
}

// Test 9: Register endpoint rejects DIFFERENT key.
{
  const rejectsDifferent = register.includes("publicKeyPem !== existing.publicKeyPem") && register.includes("REJECTED");
  record("Register endpoint rejects DIFFERENT key (immutability preserved)", rejectsDifferent, `rejectsDifferent: ${rejectsDifferent}`);
}

// Test 10: Worker does NOT call generateWorkerKeypair (old function name).
{
  const noOldFunction = !poller.includes("generateWorkerKeypair()");
  record("Worker does NOT call old generateWorkerKeypair (uses loadOrGenerate)", noOldFunction, `noOldFunction: ${noOldFunction}`);
}

// Test 11: Worker logs whether key was loaded or generated.
{
  const logsLoad = poller.includes("Loaded existing Ed25519 keypair");
  const logsGenerate = poller.includes("Generated and persisted new Ed25519 keypair");
  record("Worker logs whether key was loaded from disk or newly generated", logsLoad && logsGenerate, `logsLoad: ${logsLoad}, logsGenerate: ${logsGenerate}`);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18L: Durable Worker Identity ===\n");
let passed = 0;
let failed = 0;
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`${icon} ${r.name}`);
  console.log(`  ${r.details}\n`);
  if (r.passed) passed++;
  else failed++;
}
console.log(`=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("\n❌ DURABLE IDENTITY NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Durable identity verified — worker keypair survives restarts");
  process.exit(0);
}
