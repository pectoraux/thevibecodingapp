// Forge — Phase 8 Worker Security Regression Tests
//
// Tests that ALL worker endpoints require authentication.
// No unauthenticated access is allowed.

const CONTROL_PLANE_URL = process.env.FORGE_CONTROL_PLANE_URL || "http://localhost:3000";

import { createHmac, randomUUID } from "node:crypto";

const WORKER_SECRET = process.env.FORGE_WORKER_SECRET || "forge-worker-shared-secret-phase4";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

function signToken(payload: any): string {
  const data = [
    payload.iss, payload.aud, payload.workerId,
    payload.executionId || "", payload.leaseId || "", payload.projectId || "",
    JSON.stringify(payload.capabilities), payload.iat, payload.exp, payload.nonce,
  ].join(".");
  return createHmac("sha256", WORKER_SECRET).update(data).digest("hex");
}

function createRegToken(workerId: string): string {
  const now = Date.now();
  const payload = {
    iss: "forge-worker", aud: "forge-control-plane", workerId,
    capabilities: ["node", "git", "test", "build"],
    iat: now, exp: now + 60000, nonce: randomUUID(),
  };
  return `Bearer ${Buffer.from(JSON.stringify({ ...payload, signature: signToken(payload) })).toString("base64")}`;
}

function createInvalidToken(): string {
  return `Bearer ${Buffer.from(JSON.stringify({
    iss: "forge-worker", aud: "forge-control-plane", workerId: "fake",
    capabilities: [], iat: Date.now(), exp: Date.now() + 60000,
    nonce: "fake", signature: "invalid",
  })).toString("base64")}`;
}

function createExpiredToken(workerId: string): string {
  const now = Date.now();
  const payload = {
    iss: "forge-worker", aud: "forge-control-plane", workerId,
    capabilities: ["node"], iat: now - 120000, exp: now - 60000, nonce: randomUUID(),
  };
  return `Bearer ${Buffer.from(JSON.stringify({ ...payload, signature: signToken(payload) })).toString("base64")}`;
}

async function testEndpoint(name: string, path: string, method: string, body: any): Promise<TestResult> {
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      name: `Unauthenticated ${name} → 401`,
      passed: res.status === 401,
      details: `Got ${res.status}`,
    };
  } catch (err: any) {
    return { name: `Unauthenticated ${name} → 401`, passed: false, details: err.message };
  }
}

async function testWithToken(name: string, path: string, method: string, body: any, token: string, expectedStatus: number): Promise<TestResult> {
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "Authorization": token },
      body: JSON.stringify(body),
    });
    return {
      name,
      passed: res.status === expectedStatus,
      details: `Got ${res.status} (expected ${expectedStatus})`,
    };
  } catch (err: any) {
    return { name, passed: false, details: err.message };
  }
}

async function main() {
  console.log("=== Forge Phase 8 Worker Security Tests ===\n");
  console.log(`Control plane: ${CONTROL_PLANE_URL}\n`);

  const results: TestResult[] = [];

  // Test 1: Unauthenticated register → 401
  results.push(await testEndpoint("register", "/api/worker/register", "POST", {
    workerVersion: "phase8", protocolVersion: "v1",
  }));

  // Test 2: Unauthenticated claim → 401
  results.push(await testEndpoint("claim", "/api/worker/claim", "POST", {}));

  // Test 3: Unauthenticated heartbeat → 401
  results.push(await testEndpoint("heartbeat", "/api/worker/heartbeat", "POST", { jobId: "fake" }));

  // Test 4: Unauthenticated complete → 401
  results.push(await testEndpoint("complete", "/api/worker/complete", "POST", { status: "SUCCEEDED" }));

  // Test 5: Unauthenticated job-spec → 401
  results.push(await testEndpoint("job-spec", "/api/worker/job-spec", "POST", { executionId: "fake" }));

  // Test 6: Unauthenticated submit-evidence → 401
  results.push(await testEndpoint("submit-evidence", "/api/worker/submit-evidence", "POST", {}));

  // Test 7: Invalid signature register → 401
  results.push(await testWithToken(
    "Invalid signature register → 401",
    "/api/worker/register", "POST",
    { workerVersion: "phase8", protocolVersion: "v1" },
    createInvalidToken(), 401
  ));

  // Test 8: Expired token register → 401
  results.push(await testWithToken(
    "Expired token register → 401",
    "/api/worker/register", "POST",
    { workerVersion: "phase8", protocolVersion: "v1" },
    createExpiredToken("test-worker"), 401
  ));

  // Test 9: Valid register → 200
  results.push(await testWithToken(
    "Valid token register → 200",
    "/api/worker/register", "POST",
    { workerVersion: "phase8", protocolVersion: "v1", capabilities: ["node"] },
    createRegToken("test-worker-p8"), 200
  ));

  // Test 10: execute-task endpoint deleted (404)
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/api/worker/execute-task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    results.push({
      name: "execute-task endpoint deleted (404)",
      passed: res.status === 404,
      details: `Got ${res.status} (execute-task should not exist)`,
    });
  } catch (err: any) {
    results.push({ name: "execute-task endpoint deleted (404)", passed: false, details: err.message });
  }

  // Summary
  console.log("--- Results ---\n");
  let passed = 0, failed = 0;
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`${icon} ${r.name}`);
    console.log(`  ${r.details}\n`);
    if (r.passed) passed++; else failed++;
  }

  console.log(`=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  else process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
