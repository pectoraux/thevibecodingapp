// Forge — Phase 17A: Repository Scanner.
//
// SEPARATION OF CONCERNS (Phase 17A):
//   repository-reader.ts = obtain canonical repository snapshot (download, extract)
//   repository-scanner.ts = inspect snapshot content (security, fake-impl, structure)
//
// The scanner operates on file content provided by the reader. It never fetches
// repository state itself. This separation allows the runtime-verification
// engine to later reuse the exact same scanner without another repository
// implementation.
//
// SCANNER COVERAGE POLICY:
//   The scanner scans ALL text files, not just files with recognized source
//   extensions. A secret in `config.txt` or `Dockerfile` is just as dangerous
//   as one in `src/app.ts`. Files are classified as binary or text by content
//   inspection (null-byte detection), not by extension alone.
//
// LARGE-FILE POLICY:
//   Files exceeding MAX_SCANNABLE_BYTES are marked UNVERIFIED — they are NOT
//   silently skipped. A readiness check that encounters an UNVERIFIED file
//   must fail (fail-closed), not pass.

import { SUSPICIOUS_PATTERNS } from "@/lib/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files larger than this are marked UNVERIFIED (too large to scan safely). */
export const MAX_SCANNABLE_BYTES = 1_000_000; // 1 MB

/** Bytes to inspect for null-byte detection (binary classification). */
const BINARY_CHECK_BYTES = 8192;

/** Known binary file extensions (fast-path skip — content check is the authority). */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "svgz",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "avi", "mov", "wmv", "flv", "webm", "wav", "ogg", "m4a",
  "zip", "gz", "tar", "bz2", "7z", "rar", "xz",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "exe", "dll", "so", "dylib", "bin", "class", "jar", "war",
  "pyc", "pyo", "o", "a", "lib",
  "db", "sqlite", "sqlite3",
  "lock", "map",
]);

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

export type FileClass = "text" | "binary" | "unverified_too_large";

export interface ScannedFile {
  path: string;
  bytes: number;
  fileClass: FileClass;
  /** Content for text files; null for binary/unverified. */
  content: string | null;
  suspiciousPatterns: string[];
  /** Secret patterns found (for security checks). */
  secretFindings: SecretFinding[];
  /** True when file is too large to scan — readiness must fail. */
  unverified: boolean;
  unverifiedReason: string | null;
}

export interface SecretFinding {
  path: string;
  pattern: string;
  /** 0-indexed line number where the match starts. */
  line: number;
  /** Snippet of the matching line (truncated, with the secret redacted). */
  snippet: string;
}

// ---------------------------------------------------------------------------
// Binary detection — by content, not extension
// ---------------------------------------------------------------------------

/**
 * Classify a file as binary or text by inspecting its content.
 * Uses null-byte detection in the first 8KB. Files with null bytes are binary.
 * This catches binaries even without recognized extensions.
 */
export function classifyFile(path: string, content: Buffer): FileClass {
  // Fast-path: known binary extension.
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (BINARY_EXTENSIONS.has(ext)) return "binary";

  // Content-based: check first 8KB for null bytes.
  const checkBytes = content.subarray(0, Math.min(content.length, BINARY_CHECK_BYTES));
  if (checkBytes.includes(0x00)) return "binary";

  return "text";
}

// ---------------------------------------------------------------------------
// Secret pattern scanning
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /sk_live_[A-Za-z0-9]{16,}/g, label: "Stripe live secret key" },
  { pattern: /sk_test_[A-Za-z0-9]{16,}/g, label: "Stripe test secret key" },
  { pattern: /rk_live_[A-Za-z0-9]{16,}/g, label: "Stripe restricted live key" },
  { pattern: /AKIA[0-9A-Z]{16}/g, label: "AWS access key ID" },
  { pattern: /aws_secret_access_key\s*=\s*["'][A-Za-z0-9/+=]{40}["']/gi, label: "AWS secret access key" },
  { pattern: /ghp_[A-Za-z0-9]{36,}/g, label: "GitHub personal access token" },
  { pattern: /gho_[A-Za-z0-9]{36,}/g, label: "GitHub OAuth token" },
  { pattern: /ghu_[A-Za-z0-9]{36,}/g, label: "GitHub user-to-server token" },
  { pattern: /ghs_[A-Za-z0-9]{36,}/g, label: "GitHub server-to-server token" },
  { pattern: /github_pat_[A-Za-z0-9_]{82,}/g, label: "GitHub fine-grained PAT" },
  { pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, label: "Private key material" },
  { pattern: /AIza[0-9A-Za-z\-_]{35}/g, label: "Google API key" },
  { pattern: /xox[baprs]-[A-Za-z0-9-]+/g, label: "Slack token" },
  { pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, label: "JWT token" },
];

function scanForSecrets(path: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split("\n");

  for (const { pattern, label } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      // Find the line number for this match.
      const beforeMatch = content.substring(0, match.index);
      const lineNum = beforeMatch.split("\n").length - 1;
      const line = lines[lineNum] ?? "";
      // Redact the secret in the snippet.
      const snippet = line.length > 120
        ? line.substring(0, 60) + "..." + line.substring(line.length - 30)
        : line;
      const redacted = snippet.replace(match[0], match[0].substring(0, 8) + "[REDACTED]");
      findings.push({ path, pattern: label, line: lineNum, snippet: redacted });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Suspicious-pattern scanning (fake-implementation detector)
// ---------------------------------------------------------------------------

export function scanSuspiciousPatterns(content: string): string[] {
  const found: string[] = [];
  const lower = content.toLowerCase();
  for (const p of SUSPICIOUS_PATTERNS) {
    if (lower.includes(p.pattern.toLowerCase())) {
      found.push(p.label);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// High-severity suspicious patterns (block readiness)
// ---------------------------------------------------------------------------

const HIGH_SEVERITY_LABELS = new Set([
  "mock (commented)",
  "stub (commented)",
  "fake (commented)",
  "dummy (commented)",
  "not implemented",
  "not implemented throw",
  "hardcoded response",
  "coming soon",
]);

export function getHighSeverityPatterns(labels: string[]): string[] {
  return labels.filter((l) => HIGH_SEVERITY_LABELS.has(l));
}

// ---------------------------------------------------------------------------
// Error-handling pattern detection
// ---------------------------------------------------------------------------

export function hasErrorHandling(content: string): boolean {
  return /try\s*\{|except\s+\w+|catch\s*\(|\.catch\(/i.test(content);
}

// ---------------------------------------------------------------------------
// Full file scan — the core scanner function
// ---------------------------------------------------------------------------

/**
 * Scan a single file's content for security and quality issues.
 * Returns a ScannedFile with classification and all findings.
 *
 * Phase 17B CLASSIFICATION ORDER:
 *   1. Classify binary first (by content/extension).
 *      - Binary → recognized binary, skipped from text scan (NOT UNVERIFIED).
 *   2. If text and exceeds MAX_SCANNABLE_BYTES → UNVERIFIED (fail-closed).
 *   3. Otherwise scan as text.
 *
 * This avoids blocking on large known binaries (PNG, PDF, etc.) while still
 * blocking large unknown/text files that could contain secrets.
 *
 * @param path File path (for reporting).
 * @param rawContent Raw file content as a Buffer (from tarball extraction).
 */
export function scanFile(path: string, rawContent: Buffer): ScannedFile {
  const bytes = rawContent.length;

  // Phase 17B: classify binary BEFORE size check.
  // Large binaries are recognized binaries, not UNVERIFIED.
  const fileClass = classifyFile(path, rawContent);

  if (fileClass === "binary") {
    return {
      path,
      bytes,
      fileClass: "binary",
      content: null,
      suspiciousPatterns: [],
      secretFindings: [],
      unverified: false,
      unverifiedReason: null,
    };
  }

  // Text file: enforce size limit (fail-closed for large text/source/config).
  if (bytes > MAX_SCANNABLE_BYTES) {
    return {
      path,
      bytes,
      fileClass: "unverified_too_large",
      content: null,
      suspiciousPatterns: [],
      secretFindings: [],
      unverified: true,
      unverifiedReason: `Text file is ${bytes} bytes (exceeds ${MAX_SCANNABLE_BYTES} byte scan limit)`,
    };
  }

  // Text file within scan limit: decode and scan.
  const content = rawContent.toString("utf-8");
  const suspiciousPatterns = scanSuspiciousPatterns(content);
  const secretFindings = scanForSecrets(path, content);

  return {
    path,
    bytes,
    fileClass: "text",
    content,
    suspiciousPatterns,
    secretFindings,
    unverified: false,
    unverifiedReason: null,
  };
}

/**
 * Scan all files in a repository snapshot.
 * Returns the complete set of scanned files.
 *
 * @param files Array of { path, content: Buffer } — typically from tarball extraction.
 */
export function scanRepository(
  files: { path: string; content: Buffer }[]
): ScannedFile[] {
  return files.map((f) => scanFile(f.path, f.content));
}

// ---------------------------------------------------------------------------
// Aggregate scan results — for readiness checks
// ---------------------------------------------------------------------------

export interface ScanSummary {
  totalFiles: number;
  textFiles: number;
  binaryFiles: number;
  unverifiedFiles: number;
  filesWithSecrets: string[];
  filesWithHighSeverityPatterns: { path: string; patterns: string[] }[];
  filesWithSecretFindings: SecretFinding[];
  unverifiedFileDetails: { path: string; reason: string }[];
}

export function summarizeScan(scanned: ScannedFile[]): ScanSummary {
  const filesWithSecrets: string[] = [];
  const filesWithHighSeverityPatterns: { path: string; patterns: string[] }[] = [];
  const filesWithSecretFindings: SecretFinding[] = [];
  const unverifiedFileDetails: { path: string; reason: string }[] = [];

  let textFiles = 0;
  let binaryFiles = 0;
  let unverifiedFiles = 0;

  for (const f of scanned) {
    if (f.fileClass === "text") textFiles++;
    else if (f.fileClass === "binary") binaryFiles++;
    else if (f.fileClass === "unverified_too_large") {
      unverifiedFiles++;
      unverifiedFileDetails.push({ path: f.path, reason: f.unverifiedReason ?? "unknown" });
    }

    if (f.secretFindings.length > 0) {
      filesWithSecrets.push(f.path);
      filesWithSecretFindings.push(...f.secretFindings);
    }

    const high = getHighSeverityPatterns(f.suspiciousPatterns);
    if (high.length > 0) {
      filesWithHighSeverityPatterns.push({ path: f.path, patterns: high });
    }
  }

  return {
    totalFiles: scanned.length,
    textFiles,
    binaryFiles,
    unverifiedFiles,
    filesWithSecrets,
    filesWithHighSeverityPatterns,
    filesWithSecretFindings,
    unverifiedFileDetails,
  };
}
