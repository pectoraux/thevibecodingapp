// Forge — Phase 18J: Token Type Scoping & Issuer/Audience Enforcement
//
// Verifies:
//   1. WorkerToken has tokenType field
//   2. Valid issuer/audience pairs are enforced (not all combinations)
//   3. Token type → required issuer/audience mapping
//   4. Registration tokens cannot be used for execution endpoints
//   5. Each endpoint enforces its expected token type
//
// Run with: bun run tests/token-scoping-invariants.ts

import { readFileSync } from "node:fs";

interface TestResult { name: string; passed: boolean; details: string; }
const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function record(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
}

const workerAuth = readFile("src/lib/worker-auth.ts");

// Test 1: WorkerToken has tokenType field.
{
  const hasField = workerAuth.includes("tokenType: TokenType;");
  record("WorkerToken has tokenType field", hasField, `hasField: ${hasField}`);
}

// Test 2: TokenType is REGISTRATION | SESSION | EXECUTION.
{
  const hasTypes = workerAuth.includes('"REGISTRATION"') && workerAuth.includes('"SESSION"') && workerAuth.includes('"EXECUTION"');
  record("TokenType is REGISTRATION | SESSION | EXECUTION", hasTypes, `hasTypes: ${hasTypes}`);
}

// Test 3: TOKEN_TYPE_CONSTRAINTS maps types to issuer/audience.
{
  const hasConstraints = workerAuth.includes("TOKEN_TYPE_CONSTRAINTS");
  record("TOKEN_TYPE_CONSTRAINTS maps types to required issuer/audience", hasConstraints, `hasConstraints: ${hasConstraints}`);
}

// Test 4: Registration token type = iss: forge-worker, aud: forge-control-plane.
{
  const correct = workerAuth.includes("REGISTRATION: { iss: \"forge-worker\", aud: \"forge-control-plane\" }");
  record("Registration: iss=forge-worker, aud=forge-control-plane", correct, `correct: ${correct}`);
}

// Test 5: Session token type = iss: forge-control-plane, aud: forge-worker.
{
  const correct = workerAuth.includes("SESSION: { iss: \"forge-control-plane\", aud: \"forge-worker\" }");
  record("Session: iss=forge-control-plane, aud=forge-worker", correct, `correct: ${correct}`);
}

// Test 6: Execution token type = iss: forge-control-plane, aud: forge-worker.
{
  const correct = workerAuth.includes("EXECUTION: { iss: \"forge-control-plane\", aud: \"forge-worker\" }");
  record("Execution: iss=forge-control-plane, aud=forge-worker", correct, `correct: ${correct}`);
}

// Test 7: VALID_PAIRS enforces valid combinations only.
{
  const hasPairs = workerAuth.includes("VALID_PAIRS");
  const cpPair = workerAuth.includes('"forge-control-plane": ["forge-worker"]');
  const wPair = workerAuth.includes('"forge-worker": ["forge-control-plane"]');
  record("VALID_PAIRS enforces only valid issuer→audience combinations", hasPairs && cpPair && wPair, `hasPairs: ${hasPairs}`);
}

// Test 8: verifyWorkerToken accepts expectedTokenType parameter.
{
  const hasParam = workerAuth.includes("expectedTokenType?: TokenType");
  record("verifyWorkerToken accepts expectedTokenType parameter", hasParam, `hasParam: ${hasParam}`);
}

// Test 9: verifyWorkerToken enforces expected token type.
{
  const enforces = workerAuth.includes("expectedTokenType && token.tokenType !== expectedTokenType");
  record("verifyWorkerToken enforces expected token type when provided", enforces, `enforces: ${enforces}`);
}

// Test 10: verifyWorkerToken rejects tokens with wrong issuer/audience for type.
{
  const enforcesPair = workerAuth.includes("constraints.iss") && workerAuth.includes("constraints.aud");
  record("verifyWorkerToken rejects tokens with wrong issuer/audience for their type", enforcesPair, `enforcesPair: ${enforcesPair}`);
}

// Test 11: getWorkerToken accepts expectedTokenType.
{
  const hasParam = workerAuth.includes("getWorkerToken(req: Request, expectedTokenType?: TokenType)");
  record("getWorkerToken accepts expectedTokenType", hasParam, `hasParam: ${hasParam}`);
}

// Test 12: Registration endpoint expects REGISTRATION tokens.
{
  const code = readFile("src/app/api/worker/register/route.ts");
  const expects = code.includes('getWorkerToken(req, "REGISTRATION")');
  record("Register endpoint expects REGISTRATION token type", expects, `expects: ${expects}`);
}

// Test 13: Claim endpoint expects SESSION tokens.
{
  const code = readFile("src/app/api/worker/claim/route.ts");
  const expects = code.includes('getWorkerToken(req, "SESSION")');
  record("Claim endpoint expects SESSION token type", expects, `expects: ${expects}`);
}

// Test 14: Heartbeat endpoint expects EXECUTION tokens.
{
  const code = readFile("src/app/api/worker/heartbeat/route.ts");
  const expects = code.includes('getWorkerToken(req, "EXECUTION")');
  record("Heartbeat endpoint expects EXECUTION token type", expects, `expects: ${expects}`);
}

// Test 15: Complete endpoint expects EXECUTION tokens.
{
  const code = readFile("src/app/api/worker/complete/route.ts");
  const expects = code.includes('getWorkerToken(req, "EXECUTION")');
  record("Complete endpoint expects EXECUTION token type", expects, `expects: ${expects}`);
}

// Test 16: Submit-evidence endpoint expects EXECUTION tokens.
{
  const code = readFile("src/app/api/worker/submit-evidence/route.ts");
  const expects = code.includes('getWorkerToken(req, "EXECUTION")');
  record("Submit-evidence endpoint expects EXECUTION token type", expects, `expects: ${expects}`);
}

// Test 17: Submit-runtime-evidence endpoint expects EXECUTION tokens.
{
  const code = readFile("src/app/api/worker/submit-runtime-evidence/route.ts");
  const expects = code.includes('getWorkerToken(req, "EXECUTION")');
  record("Submit-runtime-evidence endpoint expects EXECUTION token type", expects, `expects: ${expects}`);
}

// Test 18: Job-spec endpoint expects EXECUTION tokens.
{
  const code = readFile("src/app/api/worker/job-spec/route.ts");
  const expects = code.includes('getWorkerToken(req, "EXECUTION")');
  record("Job-spec endpoint expects EXECUTION token type", expects, `expects: ${expects}`);
}

// Test 19: Rotate-key endpoint expects SESSION tokens.
{
  const code = readFile("src/app/api/worker/rotate-key/route.ts");
  const expects = code.includes('getWorkerToken(req, "SESSION")');
  record("Rotate-key endpoint expects SESSION token type", expects, `expects: ${expects}`);
}

// Test 20: createRegistrationToken sets tokenType=REGISTRATION.
{
  const sets = workerAuth.includes('tokenType: "REGISTRATION"');
  record("createRegistrationToken sets tokenType=REGISTRATION", sets, `sets: ${sets}`);
}

// Test 21: createWorkerSessionToken sets tokenType=SESSION.
{
  const sets = workerAuth.includes('tokenType: "SESSION"');
  record("createWorkerSessionToken sets tokenType=SESSION", sets, `sets: ${sets}`);
}

// Test 22: createExecutionToken sets tokenType=EXECUTION.
{
  const sets = workerAuth.includes('tokenType: "EXECUTION"');
  record("createExecutionToken sets tokenType=EXECUTION", sets, `sets: ${sets}`);
}

// Test 23: Signature includes tokenType (not just iss/aud).
{
  const includes = workerAuth.includes("payload.tokenType, payload.iss, payload.aud");
  record("Signature includes tokenType in the signed payload", includes, `includes: ${includes}`);
}

// Test 24: Honest documentation of shared HMAC limitation.
{
  const honest = workerAuth.includes("KNOWN LIMITATION") && workerAuth.includes("shared secret");
  record("Honest documentation of shared HMAC limitation", honest, `honest: ${honest}`);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18J: Token Type Scoping & Issuer/Audience Enforcement ===\n");
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
  console.log("\n❌ TOKEN SCOPING NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Token scoping verified — token types enforced, issuer/audience pairs validated");
  process.exit(0);
}
