// Forge — Phase 17A: Repository Scanner & Readiness Completeness Invariants
//
// This test verifies:
//   1. The scanner detects secrets in ALL text files, not just the first 50.
//   2. The scanner detects secrets in non-source files (Dockerfile, config.txt).
//   3. The scanner detects binary files by content (null bytes), not just extension.
//   4. The scanner marks large files as UNVERIFIED (not silently skipped).
//   5. The reader exports freshness verification fields.
//   6. The readiness gate has the Phase 17A structural checks.
//   7. production-enforcement blocks LOCAL_ONLY.
//   8. repository-reader does NOT have MAX_CONTENT_FETCHES.
//   9. repository-scanner is the sole location of scanSuspiciousPatterns.
//
// Run with: bun run tests/repository-scanner-invariants.ts

import { readFileSync } from "node:fs";
import {
  scanFile,
  scanRepository,
  summarizeScan,
  scanSuspiciousPatterns,
  hasErrorHandling,
  getHighSeverityPatterns,
  classifyFile,
  MAX_SCANNABLE_BYTES,
  type ScannedFile,
} from "../src/lib/repository-scanner";

// ---------------------------------------------------------------------------
// Fake secret construction — built at runtime to avoid GitHub push protection
// flagging literal secret strings in the test source.
// The scanner detects the constructed values at runtime; the literals never
// appear in the file.
// ---------------------------------------------------------------------------
const FAKE_STRIPE_LIVE = ["sk_live_", "a".repeat(24)].join("");
const FAKE_GHP_TOKEN = ["ghp_", "b".repeat(36)].join("");
const PEM_BEGIN = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
const PEM_END = ["-----END RSA ", "PRIVATE KEY-----"].join("");

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

function record(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
}

// ===========================================================================
// SCANNER: Complete content coverage (no 50-file cap)
// ===========================================================================

// Test 1: Scanner detects secrets in file #51+ (beyond the old 50-file cap).
{
  const files: { path: string; content: Buffer }[] = [];
  for (let i = 0; i < 60; i++) {
    files.push({
      path: `src/file${i}.ts`,
      content: Buffer.from(`// file ${i}\nexport const x = ${i};\n`),
    });
  }
  // Secret in file #55 (0-indexed) — constructed at runtime.
  files[55].content = Buffer.from(
    `const stripeKey = "${FAKE_STRIPE_LIVE}";\n`
  );

  const scanned = scanRepository(files);
  const summary = summarizeScan(scanned);
  const secretFile = scanned.find((s) => s.path === "src/file55.ts");

  record(
    "Scanner detects secret in file #55 (beyond old 50-file cap)",
    secretFile !== undefined && secretFile.secretFindings.length > 0,
    `secretFindings: ${secretFile?.secretFindings.length ?? 0}, filesWithSecrets: ${summary.filesWithSecrets.length}`
  );
}

// Test 2: Scanner detects secret in Dockerfile (non-source extension).
{
  const files = [
    {
      path: "Dockerfile",
      content: Buffer.from(
        `FROM node:20\nENV STRIPE_KEY="${FAKE_STRIPE_LIVE}"\nCMD ["npm", "start"]\n`
      ),
    },
  ];
  const scanned = scanRepository(files);
  const summary = summarizeScan(scanned);

  record(
    "Scanner detects secret in Dockerfile (non-source file)",
    summary.filesWithSecrets.includes("Dockerfile"),
    `filesWithSecrets: ${JSON.stringify(summary.filesWithSecrets)}`
  );
}

// Test 3: Scanner detects secret in config.txt (plain text file).
{
  const files = [
    {
      path: "config.txt",
      content: Buffer.from(
        `database_url=postgres://localhost\ngithub_token=${FAKE_GHP_TOKEN}\n`
      ),
    },
  ];
  const scanned = scanRepository(files);
  const summary = summarizeScan(scanned);

  record(
    "Scanner detects secret in config.txt (plain text file)",
    summary.filesWithSecrets.includes("config.txt"),
    `filesWithSecrets: ${JSON.stringify(summary.filesWithSecrets)}`
  );
}

// Test 4: Scanner detects private key material.
{
  const files = [
    {
      path: "keys/prod.pem",
      content: Buffer.from(
        `${PEM_BEGIN}\nMIIEowIBAAKCAQEA...\n${PEM_END}\n`
      ),
    },
  ];
  const scanned = scanRepository(files);
  const summary = summarizeScan(scanned);

  record(
    "Scanner detects private key material",
    summary.filesWithSecrets.includes("keys/prod.pem"),
    `filesWithSecrets: ${JSON.stringify(summary.filesWithSecrets)}`
  );
}

// ===========================================================================
// SCANNER: Binary detection by content (not just extension)
// ===========================================================================

// Test 5: Binary file detected by null-byte content (no recognized extension).
{
  const binaryContent = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]); // ZIP header
  const fileClass = classifyFile("data.dat", binaryContent);

  record(
    "Binary file detected by content (null bytes) without recognized extension",
    fileClass === "binary",
    `fileClass: ${fileClass}`
  );
}

// Test 6: Text file with no extension is classified as text.
{
  const textContent = Buffer.from("Hello, world!\nThis is a text file.\n");
  const fileClass = classifyFile("README", textContent);

  record(
    "Text file without extension classified as text",
    fileClass === "text",
    `fileClass: ${fileClass}`
  );
}

// Test 7: Known binary extension fast-path works.
{
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fileClass = classifyFile("logo.png", pngHeader);

  record(
    "Binary file detected by known extension (fast-path)",
    fileClass === "binary",
    `fileClass: ${fileClass}`
  );
}

// ===========================================================================
// SCANNER: Large-file policy (Phase 17B — binary classified before size check)
// ===========================================================================

// Test 8: Large TEXT file (>1MB) marked UNVERIFIED.
{
  const largeContent = Buffer.alloc(MAX_SCANNABLE_BYTES + 1, 0x41); // 'A' — no null bytes = text
  const scanned = scanFile("large.ts", largeContent);

  record(
    "Large TEXT file (>1MB) marked UNVERIFIED (not silently skipped)",
    scanned.unverified === true && scanned.fileClass === "unverified_too_large",
    `unverified: ${scanned.unverified}, fileClass: ${scanned.fileClass}, reason: ${scanned.unverifiedReason}`
  );
}

// Test 8b: Large BINARY file (>1MB) classified as binary, NOT UNVERIFIED.
{
  // PNG header + padding to exceed 1MB. Binary by content (null bytes).
  const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const largeBinary = Buffer.alloc(MAX_SCANNABLE_BYTES + 100, 0x00);
  Buffer.from(pngHeader).copy(largeBinary);
  const scanned = scanFile("assets/large.png", largeBinary);

  record(
    "Large BINARY file (>1MB) classified as binary (NOT UNVERIFIED)",
    scanned.fileClass === "binary" && scanned.unverified === false,
    `fileClass: ${scanned.fileClass}, unverified: ${scanned.unverified}`
  );
}

// Test 8c: Large file with binary content but no recognized extension → binary.
{
  // ZIP header (PK) + null bytes, no extension.
  const zipHeader = [0x50, 0x4b, 0x03, 0x04];
  const largeBinary = Buffer.alloc(MAX_SCANNABLE_BYTES + 50, 0x00);
  Buffer.from(zipHeader).copy(largeBinary);
  const scanned = scanFile("data-blob", largeBinary);

  record(
    "Large binary-content file without extension → binary (NOT UNVERIFIED)",
    scanned.fileClass === "binary" && scanned.unverified === false,
    `fileClass: ${scanned.fileClass}, unverified: ${scanned.unverified}`
  );
}

// Test 9: Large text file in repository scan is counted in summary.
{
  const files = [
    { path: "normal.ts", content: Buffer.from("export const x = 1;\n") },
    { path: "huge.ts", content: Buffer.alloc(MAX_SCANNABLE_BYTES + 100, 0x42) }, // 'B' = text
    { path: "big.png", content: Buffer.alloc(MAX_SCANNABLE_BYTES + 100, 0x00) }, // binary
  ];
  const scanned = scanRepository(files);
  const summary = summarizeScan(scanned);

  record(
    "Large text file counted as UNVERIFIED; large binary counted as binary (not UNVERIFIED)",
    summary.unverifiedFiles === 1 && summary.binaryFiles === 1,
    `unverifiedFiles: ${summary.unverifiedFiles}, binaryFiles: ${summary.binaryFiles}`
  );
}

// ===========================================================================
// SCANNER: Suspicious patterns and error handling
// ===========================================================================

// Test 10: Suspicious pattern detection (mock/stub/placeholder).
{
  const content = `function getUser() {\n  // mock: returns fake data\n  return { id: 1, name: "test" };\n}\n`;
  const patterns = scanSuspiciousPatterns(content);

  record(
    "Suspicious pattern detection finds 'mock (commented)'",
    patterns.includes("mock (commented)"),
    `patterns: ${JSON.stringify(patterns)}`
  );
}

// Test 11: High-severity pattern filtering.
{
  const patterns = ["mock (commented)", "TODO", "FIXME"];
  const high = getHighSeverityPatterns(patterns);

  record(
    "High-severity filter returns only high-severity patterns",
    high.length === 1 && high[0] === "mock (commented)",
    `high: ${JSON.stringify(high)}`
  );
}

// Test 12: Error handling detection.
{
  const withErrorHandling = `try {\n  doSomething();\n} catch (e) {\n  console.error(e);\n}\n`;
  const withoutErrorHandling = `function foo() {\n  return 42;\n}\n`;

  record(
    "Error handling detection works (try/catch)",
    hasErrorHandling(withErrorHandling) === true && hasErrorHandling(withoutErrorHandling) === false,
    `with: ${hasErrorHandling(withErrorHandling)}, without: ${hasErrorHandling(withoutErrorHandling)}`
  );
}

// ===========================================================================
// READER: No MAX_CONTENT_FETCHES, tarball-based approach
// ===========================================================================

const reader = readFile("src/lib/repository-reader.ts");

// Test 13: Reader does NOT have MAX_CONTENT_FETCHES.
{
  const hasCap = reader.includes("MAX_CONTENT_FETCHES");
  record(
    "repository-reader.ts does NOT have MAX_CONTENT_FETCHES (no 50-file cap)",
    !hasCap,
    hasCap ? "FOUND old cap" : "Clean — no arbitrary file cap"
  );
}

// Test 14: Reader uses tarball download for complete content.
{
  const usesTarball = reader.includes("downloadAndExtractTarball") && reader.includes("tarball");
  record(
    "repository-reader.ts uses tarball download for complete content",
    usesTarball,
    `usesTarball: ${usesTarball}`
  );
}

// Test 15: Reader checks tree truncation.
{
  const checksTruncation = reader.includes("truncated") && reader.includes("treeData.truncated");
  record(
    "repository-reader.ts checks tree truncation flag",
    checksTruncation,
    `checksTruncation: ${checksTruncation}`
  );
}

// Test 16: Reader verifies canonical HEAD freshness.
{
  const hasFreshnessCheck = reader.includes("verifyCanonicalHeadFreshness") && reader.includes("CANONICAL_HEAD_STALE");
  record(
    "repository-reader.ts verifies canonical HEAD freshness (CANONICAL_HEAD_STALE detection)",
    hasFreshnessCheck,
    `hasFreshnessCheck: ${hasFreshnessCheck}`
  );
}

// Test 17: Reader records exact SHA.
{
  const recordsSha = reader.includes("headVerified") && reader.includes("headVerificationNote");
  record(
    "repository-reader.ts records head SHA + verification status",
    recordsSha,
    `recordsSha: ${recordsSha}`
  );
}

// Test 18: Reader LOCAL_ONLY uses newest-evidence-wins (not first).
{
  const newestWins = reader.includes("NEWEST evidence for a path wins");
  record(
    "repository-reader.ts LOCAL_ONLY: newest evidence wins (not first occurrence)",
    newestWins,
    `newestWins: ${newestWins}`
  );
}

// ===========================================================================
// READINESS: Phase 17A structural checks
// ===========================================================================

const readiness = readFile("src/lib/readiness.ts");

// Test 19: Readiness has LOCAL_ONLY block check.
{
  const hasLocalOnlyBlock = readiness.includes("Repository is GitHub-backed (not LOCAL_ONLY)");
  record(
    "readiness.ts has explicit LOCAL_ONLY → PRODUCTION_READY block check",
    hasLocalOnlyBlock,
    `hasLocalOnlyBlock: ${hasLocalOnlyBlock}`
  );
}

// Test 20: Readiness has canonical HEAD freshness check.
{
  const hasFreshnessCheck = readiness.includes("Canonical HEAD is fresh");
  record(
    "readiness.ts has canonical HEAD freshness check",
    hasFreshnessCheck,
    `hasFreshnessCheck: ${hasFreshnessCheck}`
  );
}

// Test 21: Readiness has snapshot completeness check (Phase 17B reframed).
{
  const hasCompletenessCheck = readiness.includes("Repository snapshot is complete and verified");
  record(
    "readiness.ts has 'Repository snapshot is complete and verified' check (Phase 17B)",
    hasCompletenessCheck,
    `hasCompletenessCheck: ${hasCompletenessCheck}`
  );
}

// Test 22: Readiness has unverified-files check.
{
  const hasUnverifiedCheck = readiness.includes("No unscannable files");
  record(
    "readiness.ts has unscannable-files (too large) check",
    hasUnverifiedCheck,
    `hasUnverifiedCheck: ${hasUnverifiedCheck}`
  );
}

// Test 23: Readiness records exact SHA in results.
{
  const recordsSha = readiness.includes("repositoryHeadSha") && readiness.includes("repositoryHeadSha: repo.head");
  record(
    "readiness.ts records exact repositoryHeadSha in results",
    recordsSha,
    `recordsSha: ${recordsSha}`
  );
}

// Test 24: Readiness uses the scanner (not inline scanning).
{
  const usesScanner = readiness.includes("from \"@/lib/repository-scanner\"") && readiness.includes("scanRepository");
  record(
    "readiness.ts uses repository-scanner (not inline scanning)",
    usesScanner,
    `usesScanner: ${usesScanner}`
  );
}

// Test 25: Readiness does NOT use db.repoFile/repoCommit.
{
  const forbidden = [/db\.repoFile\b/, /db\.repoCommit\b/, /db\.repoBranch\b/, /db\.pullRequest\b/];
  const found: string[] = [];
  for (const re of forbidden) {
    const m = readiness.match(re);
    if (m) found.push(m[0]);
  }
  record(
    "readiness.ts does NOT use db.repoFile/repoCommit/repoBranch/pullRequest",
    found.length === 0,
    found.length === 0 ? "Clean" : `FOUND: ${found.join(", ")}`
  );
}

// ===========================================================================
// PRODUCTION ENFORCEMENT: LOCAL_ONLY policy
// ===========================================================================

const enforcement = readFile("src/lib/production-enforcement.ts");

// Test 26: canReachProductionReady blocks LOCAL_ONLY.
{
  const blocksLocalOnly = enforcement.includes('projectMode === "LOCAL_ONLY"') && enforcement.includes("return false");
  record(
    "production-enforcement.ts canReachProductionReady blocks LOCAL_ONLY",
    blocksLocalOnly,
    `blocksLocalOnly: ${blocksLocalOnly}`
  );
}

// Test 27: production-enforcement has getLocalOnlyPolicyReason.
{
  const hasPolicyReason = enforcement.includes("getLocalOnlyPolicyReason");
  record(
    "production-enforcement.ts has getLocalOnlyPolicyReason() function",
    hasPolicyReason,
    `hasPolicyReason: ${hasPolicyReason}`
  );
}

// ===========================================================================
// SCANNER SEPARATION: scanSuspiciousPatterns is ONLY in scanner
// ===========================================================================

const readerForCheck = readFile("src/lib/repository-reader.ts");
const scannerModule = readFile("src/lib/repository-scanner.ts");

// Test 28: scanSuspiciousPatterns is defined in scanner, not reader.
{
  const scannerHasIt = scannerModule.includes("export function scanSuspiciousPatterns");
  const readerHasIt = readerForCheck.includes("export function scanSuspiciousPatterns");
  record(
    "scanSuspiciousPatterns defined in repository-scanner.ts (not repository-reader.ts)",
    scannerHasIt && !readerHasIt,
    `scanner: ${scannerHasIt}, reader: ${readerHasIt}`
  );
}

// Test 29: Reader does NOT import scanner (separation — reader provides raw data).
{
  const readerImportsScanner = readerForCheck.includes('from "@/lib/repository-scanner"');
  record(
    "repository-reader.ts does NOT import repository-scanner (clean separation)",
    !readerImportsScanner,
    `readerImportsScanner: ${readerImportsScanner}`
  );
}

// ===========================================================================
// PHASE 17B: Streaming byte accounting + snapshot completeness semantics
// ===========================================================================

// Test 30: Reader enforces streaming byte limit (not just Content-Length).
{
  const hasStreamingLimit = reader.includes("bytesDownloaded") && reader.includes("MAX_TARBALL_SIZE");
  const hasContentLengthCheck = reader.includes("content-length");
  // Phase 17B: streaming byte counter is the authority. Content-Length check is removed.
  record(
    "repository-reader.ts enforces streaming byte limit (bytesDownloaded counter, not Content-Length)",
    hasStreamingLimit && !hasContentLengthCheck,
    `streaming: ${hasStreamingLimit}, contentLengthCheckRemoved: ${!hasContentLengthCheck}`
  );
}

// Test 31: Reader destroys streams when limit exceeded.
{
  const hasDestroy = reader.includes("nodeStream.destroy") && reader.includes("writeStream.destroy");
  record(
    "repository-reader.ts destroys both streams when byte limit exceeded",
    hasDestroy,
    `hasDestroy: ${hasDestroy}`
  );
}

// Test 32: RepoSnapshot has snapshotSource field.
{
  const hasSnapshotSource = reader.includes("snapshotSource:") && reader.includes("GITHUB_TARBALL") && reader.includes("GITHUB_TREES_API") && reader.includes("LOCAL_EVIDENCE");
  record(
    "RepoSnapshot has snapshotSource field (GITHUB_TARBALL | GITHUB_TREES_API | LOCAL_EVIDENCE)",
    hasSnapshotSource,
    `hasSnapshotSource: ${hasSnapshotSource}`
  );
}

// Test 33: RepoSnapshot has snapshotComplete field.
{
  const hasSnapshotComplete = reader.includes("snapshotComplete:") && reader.includes("snapshotComplete: true");
  record(
    "RepoSnapshot has snapshotComplete field (true for tarball path)",
    hasSnapshotComplete,
    `hasSnapshotComplete: ${hasSnapshotComplete}`
  );
}

// Test 34: Readiness check uses snapshotComplete (not just truncated).
{
  const usesSnapshotComplete = readiness.includes("repo.snapshotComplete") && readiness.includes("snapshotSource");
  record(
    "readiness.ts checks snapshotComplete + snapshotSource in evidence",
    usesSnapshotComplete,
    `usesSnapshotComplete: ${usesSnapshotComplete}`
  );
}

// Test 35: Scanner classifies binary before size check (Phase 17B order).
{
  const scannerContent = readFile("src/lib/repository-scanner.ts");
  // The classifyFile call should come before the MAX_SCANNABLE_BYTES check.
  const classifyIndex = scannerContent.indexOf("classifyFile(path, rawContent)");
  const sizeCheckIndex = scannerContent.indexOf("bytes > MAX_SCANNABLE_BYTES");
  record(
    "scanner: classifyFile() called BEFORE size check (binary recognized before UNVERIFIED)",
    classifyIndex > 0 && sizeCheckIndex > 0 && classifyIndex < sizeCheckIndex,
    `classifyIndex: ${classifyIndex}, sizeCheckIndex: ${sizeCheckIndex}, classifyFirst: ${classifyIndex < sizeCheckIndex}`
  );
}

// Test 36: Scanner unverified reason mentions 'Text file' (not generic 'File').
{
  const scannerContent = readFile("src/lib/repository-scanner.ts");
  const hasTextFileReason = scannerContent.includes("Text file is") && scannerContent.includes("exceeds");
  record(
    "scanner: UNVERIFIED reason specifies 'Text file' (binary files are not UNVERIFIED)",
    hasTextFileReason,
    `hasTextFileReason: ${hasTextFileReason}`
  );
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 17B: Repository Snapshot Limits & Completeness Invariants ===\n");
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
  console.log("\n❌ SCANNER/READINESS CORRECTNESS NOT SATISFIED");
  process.exit(1);
} else {
  console.log("\n✅ Repository scanner is complete, fail-closed, and correctly separated from the reader");
  process.exit(0);
}
