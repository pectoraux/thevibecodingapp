// Forge — Phase 4 Hostile Security Test Suite
//
// This is an ADVERSARIAL test suite, not merely a confirmation of expected
// env vars. It attempts real attacks against the execution worker and
// verifies they are blocked.
//
// Run with: bun run tests/hostile-security-test.ts

const WORKER_URL = process.env.FORGE_EXECUTION_WORKER_URL || "http://localhost:3001";
const WORKER_SECRET = process.env.FORGE_WORKER_SECRET || "forge-worker-shared-secret-phase4";

import { createHmac, randomUUID } from "node:crypto";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

// --- Token helpers ---

function signToken(payload: any): string {
  const data = `${payload.jobId}.${payload.projectId}.${payload.attempt}.${payload.issuedAt}.${payload.expiresAt}.${payload.nonce}`;
  return createHmac("sha256", WORKER_SECRET).update(data).digest("hex");
}

function createToken(jobId: string, projectId: string, attempt: number, expiresAt?: number): string {
  const now = Date.now();
  const payload = {
    jobId, projectId, attempt,
    issuedAt: now,
    expiresAt: expiresAt || now + 300000,
    nonce: randomUUID(),
  };
  const token = { ...payload, signature: signToken(payload) };
  return `Bearer ${Buffer.from(JSON.stringify(token)).toString("base64")}`;
}

function createInvalidToken(): string {
  return `Bearer ${Buffer.from(JSON.stringify({
    jobId: "fake", projectId: "fake", attempt: 0,
    issuedAt: Date.now(), expiresAt: Date.now() + 300000,
    nonce: "fake", signature: "invalidsignature",
  })).toString("base64")}`;
}

function createExpiredToken(): string {
  const now = Date.now();
  const payload = {
    jobId: "expired", projectId: "test-project", attempt: 0,
    issuedAt: now - 600000,
    expiresAt: now - 300000, // expired 5 minutes ago
    nonce: randomUUID(),
  };
  const token = { ...payload, signature: signToken(payload) };
  return `Bearer ${Buffer.from(JSON.stringify(token)).toString("base64")}`;
}

// --- Test helpers ---

async function fetchAuth(path: string, token: string, body?: any, method = "POST"): Promise<{ status: number; body: any }> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// --- Tests ---

async function testUnauthenticatedAccess(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Test: /execute without auth → 401
  try {
    const res = await fetch(`${WORKER_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: [{ command: "echo", args: ["test"] }] }),
    });
    results.push({
      name: "Unauthenticated /execute → 401",
      passed: res.status === 401,
      details: `Got status ${res.status}`,
    });
  } catch (err: any) {
    results.push({ name: "Unauthenticated /execute → 401", passed: false, details: err.message });
  }

  // Test: /execute with invalid signature → 403
  try {
    const res = await fetchAuth("/execute", createInvalidToken(), {
      sandboxId: "test",
      commands: [{ command: "echo", args: ["test"] }],
    });
    results.push({
      name: "Invalid signature → 403",
      passed: res.status === 403,
      details: `Got status ${res.status}: ${typeof res.body === 'object' ? res.body.error : res.body}`,
    });
  } catch (err: any) {
    results.push({ name: "Invalid signature → 403", passed: false, details: err.message });
  }

  // Test: /execute with expired token → 403
  try {
    const res = await fetchAuth("/execute", createExpiredToken(), {
      sandboxId: "test",
      commands: [{ command: "echo", args: ["test"] }],
    });
    results.push({
      name: "Expired token → 403",
      passed: res.status === 403,
      details: `Got status ${res.status}: ${typeof res.body === 'object' ? res.body.error : res.body}`,
    });
  } catch (err: any) {
    results.push({ name: "Expired token → 403", passed: false, details: err.message });
  }

  // Test: /security-audit without auth → 401 (was public in Phase 3)
  try {
    const res = await fetch(`${WORKER_URL}/security-audit`);
    results.push({
      name: "Unauthenticated /security-audit → 401",
      passed: res.status === 401,
      details: `Got status ${res.status}`,
    });
  } catch (err: any) {
    results.push({ name: "Unauthenticated /security-audit → 401", passed: false, details: err.message });
  }

  return results;
}

async function testPathContainment(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const projectId = "path-test-project";
  const token = createToken("path-test", projectId, 0);

  // Create a sandbox first.
  let sandboxId: string = "";
  try {
    const res = await fetchAuth("/sandbox", token, { projectId });
    if (res.status === 200) sandboxId = res.body.sandboxId;
  } catch {}

  if (!sandboxId) {
    results.push({ name: "Path containment tests", passed: false, details: "Could not create sandbox" });
    return results;
  }

  // Test: path traversal in file write → 400
  try {
    const res = await fetchAuth("/execute", token, {
      sandboxId,
      files: [{ path: "../../etc/passwd", content: "hacked" }],
      commands: [],
    });
    results.push({
      name: "Path traversal (../../etc/passwd) rejected",
      passed: res.status === 400,
      details: `Got status ${res.status}: ${typeof res.body === 'object' ? res.body.error : res.body}`,
    });
  } catch (err: any) {
    results.push({ name: "Path traversal rejected", passed: false, details: err.message });
  }

  // Test: absolute path in file write → 400
  try {
    const res = await fetchAuth("/execute", token, {
      sandboxId,
      files: [{ path: "/etc/passwd", content: "hacked" }],
      commands: [],
    });
    results.push({
      name: "Absolute path (/etc/passwd) rejected",
      passed: res.status === 400,
      details: `Got status ${res.status}: ${typeof res.body === 'object' ? res.body.error : res.body}`,
    });
  } catch (err: any) {
    results.push({ name: "Absolute path rejected", passed: false, details: err.message });
  }

  // Test: null byte in path → 400
  try {
    const res = await fetchAuth("/execute", token, {
      sandboxId,
      files: [{ path: "safe\0../../etc/passwd", content: "hacked" }],
      commands: [],
    });
    results.push({
      name: "Null byte in path rejected",
      passed: res.status === 400,
      details: `Got status ${res.status}: ${typeof res.body === 'object' ? res.body.error : res.body}`,
    });
  } catch (err: any) {
    results.push({ name: "Null byte rejected", passed: false, details: err.message });
  }

  // Cleanup
  await fetch(`${WORKER_URL}/sandbox/${sandboxId}`, { method: "DELETE", headers: { Authorization: token } });

  return results;
}

async function testCommandPolicy(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const projectId = "cmd-test-project";
  const token = createToken("cmd-test", projectId, 0);

  // Create a sandbox.
  let sandboxId: string = "";
  try {
    const res = await fetchAuth("/sandbox", token, { projectId });
    if (res.status === 200) sandboxId = res.body.sandboxId;
  } catch {}

  if (!sandboxId) {
    results.push({ name: "Command policy tests", passed: false, details: "Could not create sandbox" });
    return results;
  }

  // Test: blocked command (shutdown) → command blocked
  try {
    const res = await fetchAuth("/execute", token, {
      sandboxId,
      commands: [{ command: "shutdown", args: ["-h", "now"] }],
    });
    const blocked = res.body?.results?.[0]?.stderr?.includes("blocked") || res.body?.results?.[0]?.success === false;
    results.push({
      name: "Blocked command (shutdown) rejected",
      passed: res.status === 200 && blocked,
      details: `Got status ${res.status}, blocked: ${blocked}`,
    });
  } catch (err: any) {
    results.push({ name: "Blocked command rejected", passed: false, details: err.message });
  }

  // Test: fork bomb pattern in args → command blocked
  // We test the pattern detection without actually executing a fork bomb.
  // The pattern ":(){:|:&};:" should be detected by FORBIDDEN_ARG_PATTERNS.
  try {
    const res = await fetchAuth("/execute", token, {
      sandboxId,
      commands: [{ command: "bash", args: ["-c", ":(){ :|:& };:"] }],
    });
    const blocked = res.body?.results?.[0]?.stderr?.includes("blocked") || res.body?.results?.[0]?.success === false;
    results.push({
      name: "Fork bomb pattern rejected",
      passed: res.status === 200 && blocked,
      details: `Got status ${res.status}, blocked: ${blocked}`,
    });
  } catch (err: any) {
    results.push({ name: "Fork bomb rejected", passed: false, details: err.message });
  }

  // Cleanup
  await fetch(`${WORKER_URL}/sandbox/${sandboxId}`, { method: "DELETE", headers: { Authorization: token } });

  return results;
}

async function testCrossTenantIsolation(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Tenant A creates a sandbox.
  const tokenA = createToken("tenant-a-job", "tenant-a-project", 0);
  let sandboxIdA = "";
  try {
    const res = await fetchAuth("/sandbox", tokenA, { projectId: "tenant-a-project" });
    if (res.status === 200) sandboxIdA = res.body.sandboxId;
  } catch {}

  // Tenant B tries to access tenant A's sandbox.
  const tokenB = createToken("tenant-b-job", "tenant-b-project", 0);
  try {
    const res = await fetchAuth("/execute", tokenB, {
      sandboxId: sandboxIdA,
      commands: [{ command: "echo", args: ["intrusion"] }],
    });
    results.push({
      name: "Cross-tenant sandbox access rejected",
      passed: res.status === 403,
      details: `Got status ${res.status}: ${typeof res.body === 'object' ? res.body.error : res.body}`,
    });
  } catch (err: any) {
    results.push({ name: "Cross-tenant sandbox access rejected", passed: false, details: err.message });
  }

  // Cleanup
  if (sandboxIdA) {
    await fetch(`${WORKER_URL}/sandbox/${sandboxIdA}`, { method: "DELETE", headers: { Authorization: tokenA } });
  }

  return results;
}

async function testEnvironmentIsolation(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const projectId = "env-test-project";
  const token = createToken("env-test", projectId, 0);

  // Create a sandbox.
  let sandboxId: string = "";
  try {
    const res = await fetchAuth("/sandbox", token, { projectId });
    if (res.status === 200) sandboxId = res.body.sandboxId;
  } catch {}

  if (!sandboxId) {
    results.push({ name: "Environment isolation tests", passed: false, details: "Could not create sandbox" });
    return results;
  }

  // Test: child process cannot read platform secrets.
  const secrets = ["DATABASE_URL", "FORGE_MASTER_KEY", "NEXTAUTH_SECRET", "GITHUB_PAT", "VERCEL_TOKEN", "FORGE_WORKER_SECRET"];
  for (const secret of secrets) {
    try {
      const res = await fetchAuth("/execute", token, {
        sandboxId,
        commands: [{ command: "printenv", args: [secret] }],
      });
      const result = res.body?.results?.[0];
      const leaked = result?.exitCode === 0 && result?.stdout?.trim();
      results.push({
        name: `Child cannot read ${secret}`,
        passed: !leaked,
        details: leaked ? `LEAKED: ${result.stdout.trim().slice(0, 30)}` : `${secret} not accessible`,
      });
    } catch (err: any) {
      results.push({ name: `Child cannot read ${secret}`, passed: false, details: err.message });
    }
  }

  // Cleanup
  await fetch(`${WORKER_URL}/sandbox/${sandboxId}`, { method: "DELETE", headers: { Authorization: token } });

  return results;
}

async function testServerControlledWorkspaces(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Test: /execute without sandboxId → 400
  const token = createToken("workspace-test", "ws-project", 0);
  try {
    const res = await fetchAuth("/execute", token, {
      commands: [{ command: "echo", args: ["test"] }],
    });
    results.push({
      name: "Execute without sandboxId → 400",
      passed: res.status === 400,
      details: `Got status ${res.status}: ${typeof res.body === 'object' ? res.body.error : res.body}`,
    });
  } catch (err: any) {
    results.push({ name: "Execute without sandboxId → 400", passed: false, details: err.message });
  }

  return results;
}

async function testNoCors(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Test: no Access-Control-Allow-Origin header
  try {
    const res = await fetch(`${WORKER_URL}/health`);
    const corsHeader = res.headers.get("access-control-allow-origin");
    results.push({
      name: "No CORS wildcard header",
      passed: corsHeader === null,
      details: corsHeader ? `Found CORS header: ${corsHeader}` : "No CORS header (correct)",
    });
  } catch (err: any) {
    results.push({ name: "No CORS wildcard header", passed: false, details: err.message });
  }

  return results;
}

// --- Main ---

async function main() {
  console.log("=== Forge Phase 4 Hostile Security Test Suite ===\n");
  console.log(`Worker URL: ${WORKER_URL}\n`);

  const allResults: TestResult[] = [];

  console.log("--- Authentication Tests ---");
  allResults.push(...await testUnauthenticatedAccess());

  console.log("--- Server-Controlled Workspace Tests ---");
  allResults.push(...await testServerControlledWorkspaces());

  console.log("--- Path Containment Tests ---");
  allResults.push(...await testPathContainment());

  console.log("--- Command Policy Tests ---");
  allResults.push(...await testCommandPolicy());

  console.log("--- Cross-Tenant Isolation Tests ---");
  allResults.push(...await testCrossTenantIsolation());

  console.log("--- Environment Isolation Tests ---");
  allResults.push(...await testEnvironmentIsolation());

  console.log("--- CORS Tests ---");
  allResults.push(...await testNoCors());

  console.log("\n=== Results ===\n");
  let passed = 0, failed = 0;
  for (const r of allResults) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`${icon} ${r.name}`);
    console.log(`  ${r.details}\n`);
    if (r.passed) passed++; else failed++;
  }

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);

  if (failed > 0) {
    console.log("\n❌ Security tests FAILED");
    process.exit(1);
  } else {
    console.log("\n✅ All hostile security tests PASSED");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Security test crashed:", err);
  process.exit(1);
});
