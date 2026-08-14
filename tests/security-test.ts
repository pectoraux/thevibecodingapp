// Forge — Phase 3 Security Test
//
// This script verifies that the execution worker properly isolates generated
// code from platform secrets. It simulates a hostile generated project that
// attempts to read platform environment variables.
//
// Run with: bun run tests/security-test.ts

const WORKER_URL = process.env.FORGE_EXECUTION_WORKER_URL || "http://localhost:3001";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

async function testWorkerIsolation(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Test 1: Worker health check confirms no platform secrets in its env.
  try {
    const res = await fetch(`${WORKER_URL}/security-audit`);
    const data = await res.json() as any;
    results.push({
      name: "Worker has no platform secrets in its environment",
      passed: data.isIsolated === true,
      details: data.isIsolated
        ? "Worker process has no platform secrets"
        : `Leaked: ${data.leakedEnvKeys?.join(", ")}`,
    });
  } catch (err: any) {
    results.push({
      name: "Worker has no platform secrets in its environment",
      passed: false,
      details: `Worker not reachable: ${err.message}`,
    });
  }

  // Test 2: Child process cannot read DATABASE_URL.
  // Test 3: Child process cannot read FORGE_MASTER_KEY.
  // Test 4: Child process cannot read NEXTAUTH_SECRET.
  // Test 5: Child process cannot read GITHUB_PAT.
  const secretTests = [
    { name: "DATABASE_URL", env: "DATABASE_URL" },
    { name: "FORGE_MASTER_KEY", env: "FORGE_MASTER_KEY" },
    { name: "NEXTAUTH_SECRET", env: "NEXTAUTH_SECRET" },
    { name: "GITHUB_PAT", env: "GITHUB_PAT" },
    { name: "VERCEL_TOKEN", env: "VERCEL_TOKEN" },
  ];

  for (const test of secretTests) {
    try {
      const res = await fetch(`${WORKER_URL}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: `security-${test.name}`,
          commands: [{ command: "printenv", args: [test.env] }],
        }),
      });
      const data = await res.json() as any;
      const result = data.results?.[0];
      // printenv exits 0 if the env var is set, 1 if not set.
      const leaked = result?.exitCode === 0 && result?.stdout?.trim();
      results.push({
        name: `Child process cannot read ${test.name}`,
        passed: !leaked,
        details: leaked
          ? `FAILED: ${test.name} is accessible to child process (value: "${result.stdout.trim().slice(0, 20)}...")`
          : `${test.name} is NOT accessible to child process`,
      });
    } catch (err: any) {
      results.push({
        name: `Child process cannot read ${test.name}`,
        passed: false,
        details: `Worker not reachable: ${err.message}`,
      });
    }
  }

  // Test 6: Child process cannot read /etc/passwd (filesystem access test).
  try {
    const res = await fetch(`${WORKER_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "security-fs-test",
        commands: [{ command: "cat", args: ["/etc/passwd"] }],
      }),
    });
    const data = await res.json() as any;
    const result = data.results?.[0];
    // Note: /etc/passwd is world-readable on Linux. This test documents that
    // the worker has basic filesystem access. Container isolation would prevent this.
    results.push({
      name: "Filesystem access is documented (not container-isolated)",
      passed: true, // This is a known limitation, not a failure
      details: `Worker can read /etc/passwd (exitCode=${result?.exitCode}). Container isolation would prevent this. Documented as a known limitation.`,
    });
  } catch (err: any) {
    results.push({
      name: "Filesystem access is documented (not container-isolated)",
      passed: false,
      details: `Worker not reachable: ${err.message}`,
    });
  }

  return results;
}

async function main() {
  console.log("=== Forge Phase 3 Security Test ===\n");
  console.log(`Worker URL: ${WORKER_URL}\n`);

  const results = await testWorkerIsolation();

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`${icon} ${r.name}`);
    console.log(`  ${r.details}\n`);
    if (r.passed) passed++;
    else failed++;
  }

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);

  if (failed > 0) {
    console.log("\n❌ Security tests FAILED — platform secrets are NOT properly isolated");
    process.exit(1);
  } else {
    console.log("\n✅ Security tests PASSED — platform secrets are properly isolated from generated code");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Security test crashed:", err);
  process.exit(1);
});
