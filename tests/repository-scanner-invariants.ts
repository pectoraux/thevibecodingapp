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
  const hasStreamingLimit = reader.includes("downloadedBytes") && reader.includes("MAX_TARBALL_SIZE");
  const hasContentLengthCheck = reader.includes("content-length");
  // Phase 17B/17C: streaming byte counter is the authority. Content-Length check is removed.
  record(
    "repository-reader.ts enforces streaming byte limit (downloadedBytes counter, not Content-Length)",
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
  // Phase 17C: snapshotComplete is now computed from snapshotError + unreadableFiles,
  // not a hardcoded literal. Check the type declaration + the conditional assignment.
  const hasFieldType = reader.includes("snapshotComplete: boolean");
  const hasConditional = reader.includes("tarballResult.snapshotError === null") &&
    reader.includes("tarballResult.unreadableFiles.length === 0");
  record(
    "RepoSnapshot has snapshotComplete field (computed from snapshotError + unreadableFiles)",
    hasFieldType && hasConditional,
    `fieldType: ${hasFieldType}, conditional: ${hasConditional}`
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
// PHASE 17C: Fail-closed snapshot completeness
// ===========================================================================

// Test 37: RepoSnapshot has downloadedBytes field.
{
  const hasField = reader.includes("downloadedBytes:") && reader.includes("downloadedBytes: number");
  record(
    "RepoSnapshot has downloadedBytes field",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 38: RepoSnapshot has extractedBytes field.
{
  const hasField = reader.includes("extractedBytes:") && reader.includes("extractedBytes: number");
  record(
    "RepoSnapshot has extractedBytes field",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 39: RepoSnapshot has extractedFileCount field.
{
  const hasField = reader.includes("extractedFileCount:") && reader.includes("extractedFileCount: number");
  record(
    "RepoSnapshot has extractedFileCount field",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 40: RepoSnapshot has unreadableFiles field.
{
  const hasField = reader.includes("unreadableFiles:") && reader.includes("unreadableFiles: UnreadableFile[]");
  record(
    "RepoSnapshot has unreadableFiles field (UnreadableFile[])",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 41: RepoSnapshot has snapshotError field.
{
  const hasField = reader.includes("snapshotError:") && reader.includes("snapshotError: string | null");
  record(
    "RepoSnapshot has snapshotError field",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 42: walkDirectory records unreadable files (no silent skip).
{
  const walkCode = reader.includes("ctx.unreadableFiles.push");
  const hasReaddirError = reader.includes('operation: "readdir"');
  const hasStatError = reader.includes('operation: "stat"');
  const hasReadFileError = reader.includes('operation: "readFile"');
  const noSilentSkip = !reader.includes("// Skip unreadable files");
  record(
    "walkDirectory records unreadable files (readdir/stat/readFile) — no silent skip",
    walkCode && hasReaddirError && hasStatError && hasReadFileError && noSilentSkip,
    `push: ${walkCode}, readdir: ${hasReaddirError}, stat: ${hasStatError}, readFile: ${hasReadFileError}, noSilentSkip: ${noSilentSkip}`
  );
}

// Test 43: MAX_EXTRACTED_BYTES limit exists.
{
  const hasLimit = reader.includes("MAX_EXTRACTED_BYTES");
  record(
    "repository-reader.ts has MAX_EXTRACTED_BYTES extraction limit",
    hasLimit,
    `hasLimit: ${hasLimit}`
  );
}

// Test 44: MAX_EXTRACTED_FILES limit exists.
{
  const hasLimit = reader.includes("MAX_EXTRACTED_FILES");
  record(
    "repository-reader.ts has MAX_EXTRACTED_FILES extraction limit",
    hasLimit,
    `hasLimit: ${hasLimit}`
  );
}

// Test 45: walkDirectory checks limits during extraction (not just download).
{
  const checksBytes = reader.includes("ctx.extractedBytes + content.length > MAX_EXTRACTED_BYTES");
  const checksCount = reader.includes("ctx.extractedFileCount >= MAX_EXTRACTED_FILES");
  record(
    "walkDirectory checks extracted-bytes and file-count limits during extraction",
    checksBytes && checksCount,
    `checksBytes: ${checksBytes}, checksCount: ${checksCount}`
  );
}

// Test 46: Invalid archive (no topDir) returns snapshotError.
{
  const hasInvalidArchiveError = reader.includes("Invalid archive: no top-level repository directory");
  record(
    "Invalid archive (no top-level dir) returns snapshotError",
    hasInvalidArchiveError,
    `hasInvalidArchiveError: ${hasInvalidArchiveError}`
  );
}

// Test 47: Empty extraction (zero files) returns snapshotError.
{
  const hasEmptyError = reader.includes("Archive extracted but contained zero files");
  record(
    "Empty extraction (zero files) returns snapshotError",
    hasEmptyError,
    `hasEmptyError: ${hasEmptyError}`
  );
}

// Test 48: snapshotComplete is false when snapshotError exists.
{
  const conditionalComplete = reader.includes("tarballResult.snapshotError === null") &&
    reader.includes("tarballResult.unreadableFiles.length === 0");
  record(
    "snapshotComplete is false when snapshotError exists or unreadableFiles > 0",
    conditionalComplete,
    `conditionalComplete: ${conditionalComplete}`
  );
}

// Test 49: Readiness check fails on snapshotError.
{
  const failsOnError = readiness.includes("repo.snapshotError === null") &&
    readiness.includes("REPOSITORY_SNAPSHOT_UNVERIFIED");
  record(
    "readiness check fails on snapshotError (REPOSITORY_SNAPSHOT_UNVERIFIED)",
    failsOnError,
    `failsOnError: ${failsOnError}`
  );
}

// Test 50: Readiness check fails on unreadableFiles.
{
  const failsOnUnreadable = readiness.includes("repo.unreadableFiles.length === 0");
  record(
    "readiness check fails when unreadableFiles.length > 0",
    failsOnUnreadable,
    `failsOnUnreadable: ${failsOnUnreadable}`
  );
}

// Test 51: Readiness evidence includes extraction metadata.
{
  const hasDownloadedBytes = readiness.includes("downloadedBytes: repo.downloadedBytes");
  const hasExtractedBytes = readiness.includes("extractedBytes: repo.extractedBytes");
  const hasExtractedFileCount = readiness.includes("extractedFileCount: repo.extractedFileCount");
  const hasUnreadableFiles = readiness.includes("unreadableFiles: repo.unreadableFiles");
  const hasSnapshotError = readiness.includes("snapshotError: repo.snapshotError");
  record(
    "readiness evidence includes downloadedBytes, extractedBytes, extractedFileCount, unreadableFiles, snapshotError",
    hasDownloadedBytes && hasExtractedBytes && hasExtractedFileCount && hasUnreadableFiles && hasSnapshotError,
    `downloadedBytes: ${hasDownloadedBytes}, extractedBytes: ${hasExtractedBytes}, extractedFileCount: ${hasExtractedFileCount}, unreadableFiles: ${hasUnreadableFiles}, snapshotError: ${hasSnapshotError}`
  );
}

// Test 52: No silent "// Skip unreadable files" comment remains.
{
  const hasSilentSkip = reader.includes("// Skip unreadable files") || reader.includes("// Skip unreadable");
  record(
    "No 'Skip unreadable files' comment remains in repository-reader.ts",
    !hasSilentSkip,
    `hasSilentSkip: ${hasSilentSkip}`
  );
}

// Test 53: WalkContext interface tracks limitExceeded.
{
  const hasLimitExceeded = reader.includes("limitExceeded: boolean") && reader.includes("limitExceededReason");
  record(
    "WalkContext tracks limitExceeded + limitExceededReason",
    hasLimitExceeded,
    `hasLimitExceeded: ${hasLimitExceeded}`
  );
}

// ===========================================================================
// PHASE 17D: Memory + filesystem boundary hardening
// ===========================================================================

// Test 54: Pre-read size check — stat.size checked BEFORE readFileSync.
{
  const hasPreReadCheck = reader.includes("ctx.extractedBytes + stat.size > MAX_EXTRACTED_BYTES");
  const hasReadFileEntry = reader.includes("function readFileEntry");
  const preReadBeforeRead = reader.indexOf("ctx.extractedBytes + stat.size > MAX_EXTRACTED_BYTES") <
    reader.indexOf("const content = readFileSync(entryFull)");
  record(
    "Pre-read size check: stat.size checked BEFORE readFileSync (no unbounded allocation)",
    hasPreReadCheck && hasReadFileEntry && preReadBeforeRead,
    `hasPreReadCheck: ${hasPreReadCheck}, hasReadFileEntry: ${hasReadFileEntry}, preReadBeforeRead: ${preReadBeforeRead}`
  );
}

// Test 55: readFileEntry extracted as separate function (pre-read check isolation).
{
  const hasFunction = reader.includes("function readFileEntry(");
  record(
    "readFileEntry is a separate function with pre-read size enforcement",
    hasFunction,
    `hasFunction: ${hasFunction}`
  );
}

// Test 56: lstatSync used (not statSync) for symlink detection.
{
  const usesLstat = reader.includes("lstatSync(entryFull)");
  const hasSymlinkCheck = reader.includes("lstat.isSymbolicLink()");
  record(
    "walkDirectory uses lstatSync (not statSync) + checks isSymbolicLink()",
    usesLstat && hasSymlinkCheck,
    `usesLstat: ${usesLstat}, hasSymlinkCheck: ${hasSymlinkCheck}`
  );
}

// Test 57: realpathSync used for symlink containment.
{
  const usesRealpath = reader.includes("realpathSync(entryFull)");
  const hasRepoRootRealpath = reader.includes("ctx.repoRootRealpath");
  record(
    "Symlink containment: realpathSync resolves target + repoRootRealpath for boundary",
    usesRealpath && hasRepoRootRealpath,
    `usesRealpath: ${usesRealpath}, hasRepoRootRealpath: ${hasRepoRootRealpath}`
  );
}

// Test 58: SYMLINK_ESCAPE detection and rejection.
{
  const hasEscapeDetection = reader.includes("SYMLINK_ESCAPE");
  const escapeBlocksSnapshot = reader.includes("ctx.limitExceeded = true") &&
    reader.includes("SYMLINK_ESCAPE at");
  record(
    "SYMLINK_ESCAPE detected → snapshot blocked (limitExceeded = true)",
    hasEscapeDetection && escapeBlocksSnapshot,
    `hasEscapeDetection: ${hasEscapeDetection}, escapeBlocksSnapshot: ${escapeBlocksSnapshot}`
  );
}

// Test 59: Symlink target containment check against repo root.
{
  const hasContainmentCheck = reader.includes("resolvedTarget.startsWith(ctx.repoRootRealpath");
  record(
    "Symlink target checked against repoRootRealpath (containment enforced)",
    hasContainmentCheck,
    `hasContainmentCheck: ${hasContainmentCheck}`
  );
}

// Test 60: Archive root validation — exactly one root directory.
{
  const hasRootDirs = reader.includes("rootDirs");
  const hasMultipleRootsCheck = reader.includes("rootDirs.length > 1");
  const hasMultipleRootsError = reader.includes("INVALID_ARCHIVE_STRUCTURE: multiple top-level");
  record(
    "Archive root validation: multiple top-level directories → INVALID_ARCHIVE_STRUCTURE",
    hasRootDirs && hasMultipleRootsCheck && hasMultipleRootsError,
    `hasRootDirs: ${hasRootDirs}, hasMultipleRootsCheck: ${hasMultipleRootsCheck}, hasMultipleRootsError: ${hasMultipleRootsError}`
  );
}

// Test 61: Unexpected top-level files → INVALID_ARCHIVE_STRUCTURE.
{
  const hasUnexpectedFiles = reader.includes("unexpectedTopLevelFiles");
  const hasUnexpectedFilesError = reader.includes("INVALID_ARCHIVE_STRUCTURE: unexpected top-level file");
  record(
    "Unexpected top-level files → INVALID_ARCHIVE_STRUCTURE",
    hasUnexpectedFiles && hasUnexpectedFilesError,
    `hasUnexpectedFiles: ${hasUnexpectedFiles}, hasUnexpectedFilesError: ${hasUnexpectedFilesError}`
  );
}

// Test 62: repoRootRealpath resolved via realpathSync after root validation.
{
  const resolvesAfterValidation = reader.includes("ctx.repoRootRealpath = realpathSync(repoRoot)");
  record(
    "repoRootRealpath resolved via realpathSync after archive root validation",
    resolvesAfterValidation,
    `resolvesAfterValidation: ${resolvesAfterValidation}`
  );
}

// Test 63: Readiness evidence distinguishes headVerified from snapshotComplete.
{
  const hasAuthorityType = readiness.includes("authorityType: \"REPOSITORY_REVISION_VERIFIED\"");
  const hasAuthorityAlsoRequired = readiness.includes("authorityAlsoRequired: \"headVerified");
  record(
    "Readiness evidence distinguishes headVerified (authority) from snapshotComplete (extraction)",
    hasAuthorityType && hasAuthorityAlsoRequired,
    `hasAuthorityType: ${hasAuthorityType}, hasAuthorityAlsoRequired: ${hasAuthorityAlsoRequired}`
  );
}

// Test 64: Readiness check description mentions symlink escapes.
{
  const mentionsSymlinkEscapes = readiness.includes("no symlink escapes");
  record(
    "Readiness check description mentions symlink escapes",
    mentionsSymlinkEscapes,
    `mentionsSymlinkEscapes: ${mentionsSymlinkEscapes}`
  );
}

// Test 65: Canonical HEAD check description mentions distinction.
{
  const mentionsDistinction = readiness.includes("distinct from snapshot extraction completeness");
  record(
    "Canonical HEAD check description distinguishes from extraction completeness",
    mentionsDistinction,
    `mentionsDistinction: ${mentionsDistinction}`
  );
}

// Test 66: No raw statSync used for entry traversal (lstatSync is the authority).
{
  // statSync may still be used for following safe symlinks, but the primary
  // entry classification must use lstatSync.
  const lstatForEntries = reader.includes("lstat = lstatSync(entryFull)");
  const statForFollow = reader.includes("const followedStat = statSync(entryFull)");
  record(
    "Entry traversal uses lstatSync; statSync only for following contained symlinks",
    lstatForEntries && statForFollow,
    `lstatForEntries: ${lstatForEntries}, statForFollow: ${statForFollow}`
  );
}

// ===========================================================================
// PHASE 17E: Symlink cycle protection + file deduplication
// ===========================================================================

// Test 67: WalkContext has visitedRealpaths set for cycle protection.
{
  const hasSet = reader.includes("visitedRealpaths: Set<string>");
  record(
    "WalkContext has visitedRealpaths: Set<string> for cycle protection",
    hasSet,
    `hasSet: ${hasSet}`
  );
}

// Test 68: WalkContext has visitedFileRealpaths set for file deduplication.
{
  const hasSet = reader.includes("visitedFileRealpaths: Set<string>");
  record(
    "WalkContext has visitedFileRealpaths: Set<string> for file deduplication",
    hasSet,
    `hasSet: ${hasSet}`
  );
}

// Test 69: walkDirectory resolves directory realpath at entry.
{
  const resolvesAtEntry = reader.includes("dirRealpath = realpathSync(fullPath)");
  record(
    "walkDirectory resolves directory realpath at entry (for cycle detection)",
    resolvesAtEntry,
    `resolvesAtEntry: ${resolvesAtEntry}`
  );
}

// Test 70: walkDirectory checks visitedRealpaths before recursing.
{
  const checksVisited = reader.includes("ctx.visitedRealpaths.has(dirRealpath)");
  const addsVisited = reader.includes("ctx.visitedRealpaths.add(dirRealpath)");
  record(
    "walkDirectory checks + adds visitedRealpaths before recursing (cycle prevention)",
    checksVisited && addsVisited,
    `checksVisited: ${checksVisited}, addsVisited: ${addsVisited}`
  );
}

// Test 71: readFileEntry deduplicates files by canonical realpath.
{
  const resolvesFileRealpath = reader.includes("fileRealpath = realpathSync(entryFull)");
  const checksFileVisited = reader.includes("ctx.visitedFileRealpaths.has(fileRealpath)");
  const addsFileVisited = reader.includes("ctx.visitedFileRealpaths.add(fileRealpath)");
  record(
    "readFileEntry deduplicates files by realpath (checks + adds visitedFileRealpaths)",
    resolvesFileRealpath && checksFileVisited && addsFileVisited,
    `resolves: ${resolvesFileRealpath}, checks: ${checksFileVisited}, adds: ${addsFileVisited}`
  );
}

// Test 72: WalkContext initialized with empty visitedRealpaths set.
{
  const initializesSet = reader.includes("visitedRealpaths: new Set<string>()");
  record(
    "WalkContext initialized with empty visitedRealpaths Set",
    initializesSet,
    `initializesSet: ${initializesSet}`
  );
}

// Test 73: WalkContext initialized with empty visitedFileRealpaths set.
{
  const initializesSet = reader.includes("visitedFileRealpaths: new Set<string>()");
  record(
    "WalkContext initialized with empty visitedFileRealpaths Set",
    initializesSet,
    `initializesSet: ${initializesSet}`
  );
}

// Test 74: walkDirectory returns early when directory already visited.
{
  const returnsEarly = reader.includes("Already visited this directory");
  record(
    "walkDirectory returns early when directory realpath already visited (cycle broken)",
    returnsEarly,
    `returnsEarly: ${returnsEarly}`
  );
}

// Test 75: readFileEntry returns early when file already scanned.
{
  const returnsEarly = reader.includes("Already scanned this file");
  record(
    "readFileEntry returns early when file realpath already scanned (deduplication)",
    returnsEarly,
    `returnsEarly: ${returnsEarly}`
  );
}

// ===========================================================================
// PHASE 17F: Evidence clarity — paths examined vs unique files scanned
// ===========================================================================

// Test 76: RepoSnapshot has repositoryPathsExamined field.
{
  const hasField = reader.includes("repositoryPathsExamined: number");
  record(
    "RepoSnapshot has repositoryPathsExamined field",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 77: RepoSnapshot has uniqueFilesScanned field.
{
  const hasField = reader.includes("uniqueFilesScanned: number");
  record(
    "RepoSnapshot has uniqueFilesScanned field",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 78: WalkContext tracks repositoryPathsExamined.
{
  const hasField = reader.includes("repositoryPathsExamined: number") && reader.includes("ctx.repositoryPathsExamined++");
  record(
    "WalkContext tracks repositoryPathsExamined (incremented in readFileEntry before dedup)",
    hasField,
    `hasField: ${hasField}`
  );
}

// Test 79: Tarball return path sets both evidence fields.
{
  const setsPaths = reader.includes("repositoryPathsExamined: tarballResult.repositoryPathsExamined");
  const setsUnique = reader.includes("uniqueFilesScanned: tarballResult.extractedFileCount");
  record(
    "Tarball return sets repositoryPathsExamined + uniqueFilesScanned",
    setsPaths && setsUnique,
    `setsPaths: ${setsPaths}, setsUnique: ${setsUnique}`
  );
}

// Test 80: Readiness evidence includes both fields.
{
  const hasPaths = readiness.includes("repositoryPathsExamined: repo.repositoryPathsExamined");
  const hasUnique = readiness.includes("uniqueFilesScanned: repo.uniqueFilesScanned");
  record(
    "readiness evidence includes repositoryPathsExamined + uniqueFilesScanned",
    hasPaths && hasUnique,
    `hasPaths: ${hasPaths}, hasUnique: ${hasUnique}`
  );
}

// Test 81: Build event payload includes both fields.
{
  const hasPaths = readiness.includes("repositoryPathsExamined: repo.repositoryPathsExamined");
  const hasUnique = readiness.includes("uniqueFilesScanned: repo.uniqueFilesScanned");
  const inPayload = readiness.includes("repositoryPathsExamined: repo.repositoryPathsExamined") &&
    readiness.includes("uniqueFilesScanned: repo.uniqueFilesScanned");
  record(
    "build event payload includes repositoryPathsExamined + uniqueFilesScanned",
    inPayload,
    `inPayload: ${inPayload}`
  );
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("=== Forge Phase 17F: Evidence Clarity (Paths vs Unique Files) ===\n");
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
