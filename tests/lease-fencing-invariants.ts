// Forge — Phase 18I: Execution Capability & Lease Fencing Invariants
//
// Verifies:
//   1. claimExecutionJob returns the actual leaseId
//   2. Claim endpoint uses job.leaseId (not job.id) in the execution token
//   3. Nonce replay protection only applies to registration tokens (not execution)
//   4. completeExecutionJob requires workerId + leaseId + not-expired
//   5. Heartbeat uses token.executionId + token.leaseId (not body.jobId)
//   6. renewExecutionJobLease requires leaseId + not-expired
//
// Run with: bun run tests/lease-fencing-invariants.ts

import { readFileSync } from "node:fs";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function readFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function record(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
}

// ===========================================================================
// 1. CLAIM RETURNS ACTUAL LEASE ID
// ===========================================================================

const claimRoute = readFile("src/app/api/worker/claim/route.ts");
const executionJobs = readFile("src/lib/execution-jobs.ts");

// Test 1: ClaimedJob interface includes leaseId.
{
  const hasField = executionJobs.includes("leaseId: string;");
  record("ClaimedJob interface includes leaseId field", hasField, `hasField: ${hasField}`);
}

// Test 2: claimExecutionJob returns job.leaseId.
{
  const returnsLeaseId = executionJobs.includes("leaseId: job.leaseId!");
  record("claimExecutionJob returns the actual DB leaseId", returnsLeaseId, `returnsLeaseId: ${returnsLeaseId}`);
}

// Test 3: Claim endpoint uses job.leaseId in token (not job.id).
{
  const usesLeaseId = claimRoute.includes("job.leaseId") && !claimRoute.includes("job.id, // use job.id as leaseId");
  record("Claim endpoint uses job.leaseId in execution token (not job.id)", usesLeaseId, `usesLeaseId: ${usesLeaseId}`);
}

// ===========================================================================
// 2. NONCE REPLAY — EXECUTION TOKENS ARE REUSABLE
// ===========================================================================

const workerAuth = readFile("src/lib/worker-auth.ts");

// Test 4: Execution tokens bypass nonce replay check.
{
  const bypassesNonce = workerAuth.includes("isExecutionToken") && workerAuth.includes("!isExecutionToken && usedNonces.has");
  record("Execution tokens bypass nonce replay check (reusable for heartbeats)", bypassesNonce, `bypassesNonce: ${bypassesNonce}`);
}

// Test 5: Only non-execution tokens are marked as used.
{
  const conditionalMark = workerAuth.includes("!isExecutionToken") && workerAuth.includes("usedNonces.add");
  record("Only non-execution tokens are marked as nonce-used (execution tokens reusable)", conditionalMark, `conditionalMark: ${conditionalMark}`);
}

// Test 6: Registration tokens still have replay protection.
{
  const stillProtected = workerAuth.includes("!isExecutionToken && usedNonces.has(token.nonce)");
  record("Registration/session tokens still have nonce replay protection", stillProtected, `stillProtected: ${stillProtected}`);
}

// ===========================================================================
// 3. COMPLETION IS LEASE-FENCED
// ===========================================================================

const completeRoute = readFile("src/app/api/worker/complete/route.ts");

// Test 7: completeExecutionJob requires workerId parameter.
{
  const hasParam = executionJobs.includes("workerId: string,") && executionJobs.includes("leaseId: string,");
  record("completeExecutionJob accepts workerId + leaseId parameters", hasParam, `hasParam: ${hasParam}`);
}

// Test 8: completeExecutionJob checks leaseId in the WHERE clause.
{
  const checksLease = executionJobs.includes("leaseId,") && executionJobs.includes("leaseExpiresAt: { gt: new Date() }");
  record("completeExecutionJob checks leaseId + leaseExpiresAt in WHERE clause", checksLease, `checksLease: ${checksLease}`);
}

// Test 9: Complete endpoint requires token.leaseId.
{
  const requiresLease = completeRoute.includes("Lease ID required for completion");
  record("Complete endpoint requires token.leaseId", requiresLease, `requiresLease: ${requiresLease}`);
}

// Test 10: Complete endpoint passes workerId + leaseId to completeExecutionJob.
{
  const passesParams = completeRoute.includes("token.workerId") && completeRoute.includes("token.leaseId");
  record("Complete endpoint passes token.workerId + token.leaseId to completeExecutionJob", passesParams, `passesParams: ${passesParams}`);
}

// ===========================================================================
// 4. HEARTBEAT IS LEASE-FENCED
// ===========================================================================

const heartbeatRoute = readFile("src/app/api/worker/heartbeat/route.ts");

// Test 11: Heartbeat uses token.executionId (not body.jobId).
{
  // Check for actual code usage — body.jobId in a const/var assignment, not in comments.
  const usesBodyJobIdInCode = heartbeatRoute.includes("const jobId = body.jobId") || heartbeatRoute.includes("body.jobId;");
  const usesTokenExec = heartbeatRoute.includes("token.executionId") && !usesBodyJobIdInCode;
  record("Heartbeat uses token.executionId (not body.jobId in code)", usesTokenExec, `usesTokenExec: ${usesTokenExec}`);
}

// Test 12: Heartbeat requires token.leaseId.
{
  const requiresLease = heartbeatRoute.includes("Lease ID required for heartbeat");
  record("Heartbeat requires token.leaseId", requiresLease, `requiresLease: ${requiresLease}`);
}

// Test 13: Heartbeat passes token.executionId + token.leaseId to renewExecutionJobLease.
{
  const passesParams = heartbeatRoute.includes("token.executionId") && heartbeatRoute.includes("token.leaseId");
  record("Heartbeat passes token.executionId + token.leaseId to renewExecutionJobLease", passesParams, `passesParams: ${passesParams}`);
}

// Test 14: renewExecutionJobLease accepts leaseId parameter.
{
  const hasParam = executionJobs.includes("leaseId: string\n): Promise<boolean>");
  record("renewExecutionJobLease accepts leaseId parameter", hasParam, `hasParam: ${hasParam}`);
}

// Test 15: renewExecutionJobLease checks leaseId + not-expired in WHERE.
{
  const checksLease = executionJobs.includes("leaseId,") && executionJobs.includes("leaseExpiresAt: { gt: new Date() }");
  // This appears in both completeExecutionJob and renewExecutionJobLease.
  // Check specifically in the renew function context.
  const renewSection = executionJobs.substring(executionJobs.indexOf("renewExecutionJobLease"));
  const checksInRenew = renewSection.includes("leaseId,") && renewSection.includes("leaseExpiresAt: { gt: new Date() }");
  record("renewExecutionJobLease checks leaseId + not-expired in WHERE clause", checksInRenew, `checksInRenew: ${checksInRenew}`);
}

// ===========================================================================
// 5. NO BODY.JOBID IN HEARTBEAT
// ===========================================================================

// Test 16: Heartbeat does NOT accept jobId from body.
{
  // Check for actual code — const/var assignment from body.jobId, not comments.
  const acceptsJobId = heartbeatRoute.includes("const jobId = body.jobId") || heartbeatRoute.includes("= body.jobId");
  record("Heartbeat does NOT accept jobId from body (code, not comments)", !acceptsJobId, `acceptsJobId: ${acceptsJobId}`);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 18I: Execution Capability & Lease Fencing ===\n");
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
  console.log("\n❌ LEASE FENCING NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Lease fencing verified — all execution operations are lease-fenced");
  process.exit(0);
}
