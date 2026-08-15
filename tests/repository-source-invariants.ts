// Forge — Phase 16D-RECONCILE: Repository Source & Scheduler Invariants
//
// This test mechanically proves the canonical repository has been reconciled
// to the reported architecture. It fails if:
//
//   SCHEDULER
//   - scheduler.ts does NOT import the canonical integration-state helpers
//   - scheduler.ts contains any inline integration-state predicate
//     (e.g. `integrationState === "INTEGRATED"`)
//   - scheduler.ts contains any inline execution-status predicate equivalent
//     to the canonical helpers (task.status === "COMPLETED" used for the same
//     decisions the helpers cover)
//
//   REPOSITORY
//   - repo.ts exports ANY mutation function (ensureBranch, writeFileToRepo,
//     createCommit, createPullRequest, mergePullRequest, initRepository,
//     scanSuspiciousPatterns)
//   - any active production code imports a mutation function from @/lib/repo
//   - any active production code writes to the RepoBranch / RepoCommit /
//     RepoFile / PullRequest Prisma models (create/update/delete/upsert)
//
//   CANONICAL SOURCE
//   - the real Git worker module is the sole repository executor
//
// Run with: bun run tests/repository-source-invariants.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

// Recursively collect .ts/.tsx files under a directory (excluding node_modules / .next).
function findTsFiles(dir: string): string[] {
  const files: string[] = [];
  function walk(d: string) {
    try {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (
            !entry.startsWith(".") &&
            entry !== "node_modules" &&
            entry !== ".next"
          ) {
            walk(full);
          }
        } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
          files.push(full);
        }
      }
    } catch {}
  }
  walk(dir);
  return files;
}

const srcFiles = findTsFiles("src");

// ---------------------------------------------------------------------------
// SCHEDULER INVARIANTS
// ---------------------------------------------------------------------------

const scheduler = readFile("src/lib/scheduler.ts");

// S1: scheduler imports the canonical integration-state helpers.
{
  const importsHelper = scheduler.includes('from "@/lib/integration-state"');
  const importsIsTaskIntegrated = scheduler.includes("isTaskIntegrated");
  const importsAreAllTasksReady = scheduler.includes("areAllTasksReady");
  const importsIsTaskCompleted = scheduler.includes("isTaskCompleted");
  results.push({
    name: "scheduler.ts imports canonical integration-state helpers",
    passed:
      importsHelper &&
      importsIsTaskIntegrated &&
      importsAreAllTasksReady &&
      importsIsTaskCompleted,
    details: `import line: ${importsHelper}, isTaskIntegrated: ${importsIsTaskIntegrated}, areAllTasksReady: ${importsAreAllTasksReady}, isTaskCompleted: ${importsIsTaskCompleted}`,
  });
}

// S2: scheduler has ZERO inline integration-state predicates.
// Matches: integrationState === "INTEGRATED" / 'INTEGRATED' / !== "INTEGRATED" etc.
{
  const inlineIntegrationPredicates: string[] = [];
  const patterns = [
    /integrationState\s*===\s*["']INTEGRATED["']/g,
    /integrationState\s*!==\s*["']INTEGRATED["']/g,
    /["']INTEGRATED["']\s*===\s*integrationState/g,
    /["']INTEGRATED["']\s*!==\s*integrationState/g,
  ];
  for (const re of patterns) {
    const m = scheduler.match(re);
    if (m) inlineIntegrationPredicates.push(...m);
  }
  results.push({
    name: "scheduler.ts has zero inline integrationState === INTEGRATED predicates",
    passed: inlineIntegrationPredicates.length === 0,
    details:
      inlineIntegrationPredicates.length === 0
        ? "Clean — all integration checks routed through canonical helper"
        : `FOUND ${inlineIntegrationPredicates.length} inline predicate(s): ${inlineIntegrationPredicates.join(", ")}`,
  });
}

// S3: scheduler has zero inline integration-blocking predicates.
// (e.g. direct checks against INTEGRATION_PENDING / MERGING / etc. used for
// the same decisions isIntegrationBlocking() covers.)
{
  const blockingStates = [
    "INTEGRATION_PENDING",
    "MERGING",
    "INTEGRATION_FAILED",
    "CANONICAL_HEAD_UNVERIFIED",
  ];
  const found: string[] = [];
  for (const s of blockingStates) {
    const re = new RegExp(`integrationState\\s*===\\s*["']${s}["']`, "g");
    const m = scheduler.match(re);
    if (m) found.push(...m);
  }
  results.push({
    name: "scheduler.ts has zero inline integration-blocking-state predicates",
    passed: found.length === 0,
    details:
      found.length === 0
        ? "Clean — no inline integration-state comparisons in scheduler"
        : `FOUND: ${found.join(", ")}`,
  });
}

// S4: scheduler uses the canonical helpers for dependency readiness + build completion.
{
  const usesIsTaskIntegratedForDeps = /isTaskIntegrated\s*\(\s*dep/.test(scheduler);
  const usesAreAllTasksReady = /areAllTasksReady\s*\(/.test(scheduler);
  results.push({
    name: "scheduler.ts uses isTaskIntegrated() for deps and areAllTasksReady() for build completion",
    passed: usesIsTaskIntegratedForDeps && usesAreAllTasksReady,
    details: `isTaskIntegrated(dep): ${usesIsTaskIntegratedForDeps}, areAllTasksReady(): ${usesAreAllTasksReady}`,
  });
}

// ---------------------------------------------------------------------------
// REPOSITORY INVARIANTS
// ---------------------------------------------------------------------------

const repo = readFile("src/lib/repo.ts");

// R1: repo.ts does NOT export any mutation function.
{
  const forbiddenExports = [
    "ensureBranch",
    "writeFileToRepo",
    "createCommit",
    "createPullRequest",
    "mergePullRequest",
    "initRepository",
    "scanSuspiciousPatterns",
  ];
  const found: string[] = [];
  for (const fn of forbiddenExports) {
    const re = new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\s*\\(`);
    if (re.test(repo)) found.push(fn);
  }
  results.push({
    name: "repo.ts exports no mutation functions",
    passed: found.length === 0,
    details:
      found.length === 0
        ? "Clean — repo.ts is read-only"
        : `FORBIDDEN exports still present: ${found.join(", ")}`,
  });
}

// R2: repo.ts only exports the allowed read functions.
{
  const allowedExports = ["listFiles", "getFile", "listCommits", "listPullRequests"];
  const exportRegex = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;
  const exported: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = exportRegex.exec(repo)) !== null) exported.push(m[1]);
  const disallowed = exported.filter((e) => !allowedExports.includes(e));
  results.push({
    name: "repo.ts exports only read functions (listFiles, getFile, listCommits, listPullRequests)",
    passed: disallowed.length === 0,
    details:
      disallowed.length === 0
        ? `Exports: ${exported.join(", ")}`
        : `Disallowed exports: ${disallowed.join(", ")}`,
  });
}

// R3: repo.ts header declares itself read-only (canonical-source invariant documented).
{
  const declaresReadOnly =
    repo.includes("READ-ONLY") && repo.includes("NO mutation operations");
  results.push({
    name: "repo.ts documents the read-only canonical-source invariant",
    passed: declaresReadOnly,
    details: declaresReadOnly
      ? "Read-only invariant documented in module header"
      : "Missing read-only declaration in header",
  });
}

// R4: no active production code imports a mutation function from @/lib/repo.
{
  const forbiddenNames = [
    "ensureBranch",
    "writeFileToRepo",
    "createCommit",
    "createPullRequest",
    "mergePullRequest",
    "initRepository",
    "scanSuspiciousPatterns",
  ];
  const violations: string[] = [];
  for (const file of srcFiles) {
    if (file.endsWith("lib/repo.ts")) continue; // repo.ts itself
    const content = readFile(file);
    if (!content.includes("@/lib/repo")) continue;
    for (const name of forbiddenNames) {
      // Match the name appearing in an import binding from @/lib/repo.
      const importRegex = new RegExp(
        `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']@/lib/repo["']`
      );
      if (importRegex.test(content)) {
        violations.push(`${file}: imports ${name} from @/lib/repo`);
      }
    }
  }
  results.push({
    name: "no active production code imports mutation functions from @/lib/repo",
    passed: violations.length === 0,
    details:
      violations.length === 0
        ? "Clean — only read functions imported"
        : `VIOLATIONS:\n${violations.join("\n")}`,
  });
}

// R5: no active production code writes to Repo*/PullRequest Prisma models.
// Matches: db.repoBranch.create / .update / .delete / .upsert (and Many variants).
{
  const writeRegex =
    /\.(repoBranch|repoCommit|repoFile|pullRequest)\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/g;
  const violations: string[] = [];
  for (const file of srcFiles) {
    const content = readFile(file);
    let m: RegExpExecArray | null;
    writeRegex.lastIndex = 0;
    while ((m = writeRegex.exec(content)) !== null) {
      violations.push(`${file}: ${m[0]}`);
    }
  }
  results.push({
    name: "no active production code writes to RepoBranch/RepoCommit/RepoFile/PullRequest models",
    passed: violations.length === 0,
    details:
      violations.length === 0
        ? "Clean — Repo* models are read-only metadata/evidence; real Git is canonical"
        : `WRITE VIOLATIONS (${violations.length}):\n${violations.join("\n")}`,
  });
}

// R6: the real Git worker module exists and is the sole repository executor.
{
  const gitWorker = readFile(
    "mini-services/execution-worker/git/repository.ts"
  );
  const hasClone = /export\s+(async\s+)?function\s+gitClone/.test(gitWorker);
  const hasPush = /export\s+(async\s+)?function\s+gitPush/.test(gitWorker);
  const hasCommit = /export\s+(async\s+)?function\s+gitAddAndCommit/.test(
    gitWorker
  );
  results.push({
    name: "real Git worker module (git/repository.ts) is the sole repository executor",
    passed: hasClone && hasPush && hasCommit,
    details: `gitClone: ${hasClone}, gitPush: ${hasPush}, gitAddAndCommit: ${hasCommit}`,
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("=== Forge Phase 16D-RECONCILE: Repository Source & Scheduler Invariants ===\n");
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
  console.log(
    "\n❌ RECONCILIATION NOT SATISFIED — canonical repository does not match reported architecture"
  );
  process.exit(1);
} else {
  console.log(
    "\n✅ Reconciliation verified — real Git/GitHub is the sole canonical repository source; scheduler uses canonical helpers only"
  );
  process.exit(0);
}
