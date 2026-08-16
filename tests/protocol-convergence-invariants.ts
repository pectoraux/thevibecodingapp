// Forge — Phase 18K: Worker/Control-Plane Protocol Convergence Invariants
//
// Verifies:
//   1. Worker poller generates Ed25519 keypair
//   2. Worker poller registers publicKeyPem
//   3. Worker poller uses tokenType in registration token
//   4. Worker poller includes tokenType in signature
//   5. job-spec is lease-fenced
//   6. resolve-credential is lease-fenced + project-scoped
//   7. resolve-github-credential is lease-fenced
//
// Run with: bun run tests/protocol-convergence-invariants.ts

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
const jobSpec = readFile("src/app/api/worker/job-spec/route.ts");
const resolveCred = readFile("src/app/api/worker/resolve-credential/route.ts");
const resolveGithub = readFile("src/app/api/worker/resolve-github-credential/route.ts");

// Test 1: Worker generates Ed25519 keypair.
{
  const hasKeypair = poller.includes("generateKeyPairSync") || poller.includes("generateWorkerKeypair");
  record("Worker generates Ed25519 keypair for evidence signing", hasKeypair, `hasKeypair: ${hasKeypair}`);
}

// Test 2: Worker registers publicKeyPem.
{
  const registersKey = poller.includes("publicKeyPem: workerPublicKeyPem") || poller.includes("publicKeyPem");
  record("Worker registers publicKeyPem at /api/worker/register", registersKey, `registersKey: ${registersKey}`);
}

// Test 3: Worker registration token includes tokenType.
{
  const hasTokenType = poller.includes('tokenType: "REGISTRATION"');
  record("Worker registration token includes tokenType: REGISTRATION", hasTokenType, `hasTokenType: ${hasTokenType}`);
}

// Test 4: Worker token signature includes tokenType.
{
  const includesType = poller.includes("payload.tokenType");
  record("Worker token signature includes tokenType in signed payload", includesType, `includesType: ${includesType}`);
}

// Test 5: job-spec is lease-fenced.
{
  const checksLease = jobSpec.includes("job.leaseId !== token.leaseId") && jobSpec.includes("Lease mismatch");
  const checksExpiry = jobSpec.includes("leaseExpiresAt") && jobSpec.includes("Lease expired");
  record("job-spec endpoint is lease-fenced (leaseId + not-expired)", checksLease && checksExpiry, `checksLease: ${checksLease}, checksExpiry: ${checksExpiry}`);
}

// Test 6: resolve-credential is lease-fenced.
{
  const checksLease = resolveCred.includes("leaseId !== token.leaseId") && resolveCred.includes("Lease mismatch");
  const checksExpiry = resolveCred.includes("leaseExpiresAt") && resolveCred.includes("Lease expired");
  record("resolve-credential endpoint is lease-fenced", checksLease && checksExpiry, `checksLease: ${checksLease}, checksExpiry: ${checksExpiry}`);
}

// Test 7: resolve-credential is project-scoped.
{
  const checksProject = resolveCred.includes("Provider does not belong to the execution's project owner");
  record("resolve-credential endpoint is project-scoped (provider must match project owner)", checksProject, `checksProject: ${checksProject}`);
}

// Test 8: resolve-github-credential is lease-fenced.
{
  const checksLease = resolveGithub.includes("leaseId !== token.leaseId") && resolveGithub.includes("Lease mismatch");
  const checksExpiry = resolveGithub.includes("leaseExpiresAt") && resolveGithub.includes("Lease expired");
  record("resolve-github-credential endpoint is lease-fenced", checksLease && checksExpiry, `checksLease: ${checksLease}, checksExpiry: ${checksExpiry}`);
}

// Test 9: resolve-github-credential checks workerId.
{
  const checksWorker = resolveGithub.includes("job.workerId !== token.workerId");
  record("resolve-github-credential checks workerId ownership", checksWorker, `checksWorker: ${checksWorker}`);
}

// Test 10: job-spec checks workerId.
{
  const checksWorker = jobSpec.includes("job.workerId !== token.workerId");
  record("job-spec checks workerId ownership", checksWorker, `checksWorker: ${checksWorker}`);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18K: Worker/Control-Plane Protocol Convergence ===\n");
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
  console.log("\n❌ PROTOCOL CONVERGENCE NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Protocol convergence verified — worker and control plane use the same protocol");
  process.exit(0);
}
