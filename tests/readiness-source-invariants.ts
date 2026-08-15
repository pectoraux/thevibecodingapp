// Forge — Phase 17: Readiness Source Invariants
//
// This test mechanically proves that the Production Readiness Gate and the
// Repository UI read from the CANONICAL repository adapter
// (src/lib/repository-reader.ts), NOT from the legacy DB-backed
// RepoFile/RepoCommit/PullRequest models.
//
// It fails if:
//   - readiness.ts imports or uses db.repoFile / db.repoCommit / db.pullRequest
//   - readiness.ts does NOT import from @/lib/repository-reader
//   - the repository UI route imports from @/lib/repo (legacy) instead of
//     @/lib/repository-reader
//   - the repository files route imports from @/lib/repo instead of
//     @/lib/repository-reader
//   - repository-reader.ts writes to any Repo*/PullRequest Prisma model
//   - repository-reader.ts imports from @/lib/repo (legacy DB adapter)
//
// Run with: bun run tests/readiness-source-invariants.ts

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

function findTsFiles(dir: string): string[] {
  const files: string[] = [];
  function walk(d: string) {
    try {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (!entry.startsWith(".") && entry !== "node_modules" && entry !== ".next") {
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

// ---------------------------------------------------------------------------
// READINESS GATE INVARIANTS
// ---------------------------------------------------------------------------

const readiness = readFile("src/lib/readiness.ts");

// R1: readiness.ts imports from @/lib/repository-reader.
{
  const importsReader = readiness.includes('from "@/lib/repository-reader"');
  const usesGetRepositorySnapshot = readiness.includes("getRepositorySnapshot");
  results.push({
    name: "readiness.ts imports canonical repository-reader",
    passed: importsReader && usesGetRepositorySnapshot,
    details: `import: ${importsReader}, getRepositorySnapshot used: ${usesGetRepositorySnapshot}`,
  });
}

// R2: readiness.ts does NOT use db.repoFile / db.repoCommit / db.pullRequest.
{
  const forbidden = [
    /db\.repoFile\b/,
    /db\.repoCommit\b/,
    /db\.repoBranch\b/,
    /db\.pullRequest\b/,
  ];
  const found: string[] = [];
  for (const re of forbidden) {
    const m = readiness.match(re);
    if (m) found.push(m[0]);
  }
  results.push({
    name: "readiness.ts does NOT use db.repoFile/repoCommit/repoBranch/pullRequest",
    passed: found.length === 0,
    details:
      found.length === 0
        ? "Clean — readiness reads from canonical repository-reader only"
        : `FOUND legacy DB model reads: ${found.join(", ")}`,
  });
}

// R3: readiness.ts does NOT import from @/lib/repo (legacy DB adapter).
{
  const importsLegacyRepo = readiness.includes('from "@/lib/repo"');
  results.push({
    name: "readiness.ts does NOT import from legacy @/lib/repo",
    passed: !importsLegacyRepo,
    details: importsLegacyRepo ? "FOUND legacy import" : "Clean",
  });
}

// ---------------------------------------------------------------------------
// REPOSITORY UI ROUTE INVARIANTS
// ---------------------------------------------------------------------------

const repoRoute = readFile("src/app/api/projects/[id]/repository/route.ts");
const repoFilesRoute = readFile("src/app/api/projects/[id]/repository/files/route.ts");

// R4: repository route uses repository-reader, not @/lib/repo.
{
  const importsReader = repoRoute.includes('from "@/lib/repository-reader"');
  const importsLegacy = repoRoute.includes('from "@/lib/repo"');
  results.push({
    name: "repository route imports @/lib/repository-reader (not @/lib/repo)",
    passed: importsReader && !importsLegacy,
    details: `reader: ${importsReader}, legacy: ${importsLegacy}`,
  });
}

// R5: repository files route uses repository-reader, not @/lib/repo.
{
  const importsReader = repoFilesRoute.includes('from "@/lib/repository-reader"');
  const importsLegacy = repoFilesRoute.includes('from "@/lib/repo"');
  results.push({
    name: "repository files route imports @/lib/repository-reader (not @/lib/repo)",
    passed: importsReader && !importsLegacy,
    details: `reader: ${importsReader}, legacy: ${importsLegacy}`,
  });
}

// R6: neither repository route reads from db.repoFile/repoCommit/repoBranch.
{
  const routes = repoRoute + "\n" + repoFilesRoute;
  const forbidden = [/db\.repoFile\b/, /db\.repoCommit\b/, /db\.repoBranch\b/, /db\.pullRequest\b/];
  const found: string[] = [];
  for (const re of forbidden) {
    const m = routes.match(re);
    if (m) found.push(m[0]);
  }
  results.push({
    name: "repository routes do NOT read db.repoFile/repoCommit/repoBranch/pullRequest",
    passed: found.length === 0,
    details:
      found.length === 0
        ? "Clean — routes read from canonical repository-reader"
        : `FOUND legacy DB reads: ${found.join(", ")}`,
  });
}

// ---------------------------------------------------------------------------
// REPOSITORY-READER INVARIANTS
// ---------------------------------------------------------------------------

const reader = readFile("src/lib/repository-reader.ts");

// R7: repository-reader.ts does NOT write to Repo*/PullRequest models.
{
  const writeRegex =
    /\.(repoBranch|repoCommit|repoFile|pullRequest)\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  writeRegex.lastIndex = 0;
  while ((m = writeRegex.exec(reader)) !== null) {
    found.push(m[0]);
  }
  results.push({
    name: "repository-reader.ts does NOT write to Repo*/PullRequest models",
    passed: found.length === 0,
    details:
      found.length === 0
        ? "Clean — reader is strictly read-only"
        : `WRITE VIOLATIONS: ${found.join(", ")}`,
  });
}

// R8: repository-reader.ts does NOT import from @/lib/repo (no legacy coupling).
{
  const importsLegacy = reader.includes('from "@/lib/repo"');
  results.push({
    name: "repository-reader.ts does NOT import from legacy @/lib/repo",
    passed: !importsLegacy,
    details: importsLegacy ? "FOUND legacy import" : "Clean — self-contained",
  });
}

// R9: repository-reader.ts exports the canonical interface.
// Phase 17A: scanSuspiciousPatterns moved to repository-scanner.ts (separation of concerns).
{
  const exportsGetSnapshot = reader.includes("export async function getRepositorySnapshot");
  const exportsGetFile = reader.includes("export async function getFileContent");
  const doesNotExportScanPatterns = !reader.includes("export function scanSuspiciousPatterns");
  results.push({
    name: "repository-reader.ts exports getRepositorySnapshot, getFileContent (scanner separated to repository-scanner.ts)",
    passed: exportsGetSnapshot && exportsGetFile && doesNotExportScanPatterns,
    details: `getRepositorySnapshot: ${exportsGetSnapshot}, getFileContent: ${exportsGetFile}, scanSuspiciousPatterns NOT in reader: ${doesNotExportScanPatterns}`,
  });
}

// R10: repository-reader.ts documents the canonical-source invariant.
{
  const documentsInvariant =
    reader.includes("CANONICAL SOURCE INVARIANT") &&
    reader.includes("GITHUB_BACKED") &&
    reader.includes("LOCAL_ONLY");
  results.push({
    name: "repository-reader.ts documents the canonical-source invariant",
    passed: documentsInvariant,
    details: documentsInvariant ? "Invariant documented in header" : "Missing documentation",
  });
}

// ---------------------------------------------------------------------------
// GLOBAL: no active production code writes to Repo*/PullRequest
// (re-verify the Phase 16D invariant still holds after Phase 17 changes)
// ---------------------------------------------------------------------------

{
  const srcFiles = findTsFiles("src");
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
    name: "no active production code writes to Repo*/PullRequest models (Phase 16D invariant preserved)",
    passed: violations.length === 0,
    details:
      violations.length === 0
        ? "Clean — Repo* models are read-only; real Git/GitHub is sole canonical source"
        : `WRITE VIOLATIONS (${violations.length}):\n${violations.join("\n")}`,
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("=== Forge Phase 17: Readiness Source Invariants ===\n");
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
    "\n❌ READINESS SOURCE NOT RECONCILED — readiness/UI still reads legacy DB repository models"
  );
  process.exit(1);
} else {
  console.log(
    "\n✅ Readiness source verified — gate and UI read canonical repository (real Git/GitHub), not legacy DB shadow"
  );
  process.exit(0);
}
