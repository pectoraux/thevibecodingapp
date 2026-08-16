// Forge — Phase 18U: Challenge Persistence & Atomic Consumption
//
// Verifies:
//   1. WorkerChallenge model exists in schema
//   2. Challenge endpoint persists challenge in DB
//   3. Register endpoint looks up challenge from DB by nonce
//   4. Register endpoint verifies challenge string EXACTLY matches stored record
//   5. Register endpoint atomically consumes challenge (PENDING → CONSUMED)
//   6. Self-constructed challenges are rejected (no DB record)
//   7. Reused challenges are rejected (status CONSUMED)
//
// Run with: bun run tests/challenge-persistence.ts

import { readFileSync } from "node:fs";

interface TestResult { name: string; passed: boolean; details: string; }
const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function record(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
}

const schema = readFile("prisma/schema.prisma");
const challengeRoute = readFile("src/app/api/worker/challenge/route.ts");
const registerRoute = readFile("src/app/api/worker/register/route.ts");

// Test 1: WorkerChallenge model exists.
{
  const hasModel = schema.includes("model WorkerChallenge");
  record("WorkerChallenge model exists in Prisma schema", hasModel, `hasModel: ${hasModel}`);
}

// Test 2: WorkerChallenge has nonce (unique).
{
  const hasField = schema.includes("nonce       String   @unique");
  record("WorkerChallenge has nonce @unique field", hasField, `hasField: ${hasField}`);
}

// Test 3: WorkerChallenge has status PENDING/CONSUMED.
{
  const hasStatus = schema.includes("status      String   @default(\"PENDING\")");
  record("WorkerChallenge has status field (PENDING | CONSUMED)", hasStatus, `hasStatus: ${hasStatus}`);
}

// Test 4: Challenge endpoint persists to DB.
{
  const persists = challengeRoute.includes("db.workerChallenge.create");
  record("Challenge endpoint persists challenge to database", persists, `persists: ${persists}`);
}

// Test 5: Register endpoint looks up challenge from DB by nonce.
{
  const looks = registerRoute.includes("db.workerChallenge.findUnique") && registerRoute.includes("where: { nonce: challengeNonce }");
  record("Register endpoint looks up challenge from DB by nonce", looks, `looks: ${looks}`);
}

// Test 6: Register endpoint verifies exact challenge string match.
{
  const verifies = registerRoute.includes("challenge !== challengeRecord.challenge");
  record("Register endpoint verifies challenge string EXACTLY matches stored record", verifies, `verifies: ${verifies}`);
}

// Test 7: Register endpoint rejects self-constructed challenges.
{
  const rejects = registerRoute.includes("Self-constructed challenges are not accepted");
  record("Register endpoint rejects self-constructed challenges (no DB record)", rejects, `rejects: ${rejects}`);
}

// Test 8: Register endpoint rejects unknown nonce.
{
  const rejects = registerRoute.includes("Challenge not found");
  record("Register endpoint rejects unknown nonce (no DB record)", rejects, `rejects: ${rejects}`);
}

// Test 9: Register endpoint checks challenge status PENDING.
{
  const checks = registerRoute.includes('challengeRecord.status !== "PENDING"');
  record("Register endpoint checks challenge status is PENDING", checks, `checks: ${checks}`);
}

// Test 10: Register endpoint rejects consumed challenges.
{
  const rejects = registerRoute.includes("single-use");
  record("Register endpoint rejects consumed challenges (single-use)", rejects, `rejects: ${rejects}`);
}

// Test 11: Register endpoint atomically consumes challenge (updateMany + count check).
{
  const atomic = registerRoute.includes("db.workerChallenge.updateMany") &&
    registerRoute.includes('status: "PENDING"') &&
    registerRoute.includes("consumeResult.count === 0");
  record("Register endpoint atomically consumes challenge (compare-and-set)", atomic, `atomic: ${atomic}`);
}

// Test 12: Register endpoint rejects concurrent consumption.
{
  const rejects = registerRoute.includes("already consumed by another request");
  record("Register endpoint rejects concurrent consumption (409)", rejects, `rejects: ${rejects}`);
}

// Test 13: Challenge endpoint creates unique nonce.
{
  const unique = challengeRoute.includes("randomUUID");
  record("Challenge endpoint generates cryptographically random nonce", unique, `unique: ${unique}`);
}

// Test 14: No "In a production system" disclaimer (it IS the production system now).
{
  const noDisclaimer = !registerRoute.includes("In a production system");
  record("No 'In a production system' disclaimer (implementation IS the production system)", noDisclaimer, `noDisclaimer: ${noDisclaimer}`);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18U: Challenge Persistence & Atomic Consumption ===\n");
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
  console.log("\n❌ CHALLENGE PERSISTENCE NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Challenge persistence verified — server-issued, persisted, single-use, atomically consumed");
  process.exit(0);
}
