// Forge — Phase 17A: Canonical Repository Read Adapter.
//
// This is the ONE canonical reader for repository state used by:
//   - the Production Readiness Gate (src/lib/readiness.ts)
//   - the Repository UI (GET /api/projects/[id]/repository)
//
// CANONICAL SOURCE INVARIANT:
//   GITHUB_BACKED → reads the ACTUAL GitHub repository (integration branch).
//   LOCAL_ONLY    → derives a best-available view from TaskEvidence
//                   (there is no persistent repo — the worker's /tmp
//                   checkout is deleted after execution).
//
// PHASE 17A CORRECTNESS GUARANTEES:
//   1. COMPLETE CONTENT — downloads the GitHub tarball at the exact canonical
//      SHA. No arbitrary file-count cap. Every text file is scanned.
//   2. TREE TRUNCATION — if the GitHub Trees API is used (for the UI list
//      view without content), a `truncated: true` response makes the snapshot
//      UNVERIFIED. The tarball approach (used for readiness) is not subject
//      to tree truncation.
//   3. CANONICAL HEAD FRESHNESS — before readiness scanning, the reader
//      verifies that `project.canonicalHeadSha` equals the actual GitHub
//      integration branch HEAD. If they differ → CANONICAL_HEAD_STALE.
//   4. EXACT REVISION — the verified SHA is recorded in every snapshot and
//      propagated to readiness results for reproducibility.
//
// This module NEVER writes to RepoBranch/RepoCommit/RepoFile/PullRequest.
// Content scanning is delegated to src/lib/repository-scanner.ts.

import { db } from "@/lib/db";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, rmSync, statSync, lstatSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import * as tar from "tar";

// ---------------------------------------------------------------------------
// View types — match the frontend API contract (components/forge/lib/types.ts)
// ---------------------------------------------------------------------------

export interface RepoBranchView {
  id: string;
  name: string;
  headSha: string | null;
  isDefault?: boolean;
}

export interface RepoFileView {
  id: string;
  path: string;
  language: string | null;
  bytes: number;
  content: string | null;
  suspiciousPatterns: string[];
  branch: string | null;
  commitSha: string | null;
}

export interface RepoCommitView {
  id: string;
  sha: string;
  branch: string;
  message: string;
  author: string;
  createdAt: string;
  filesChanged: { path: string; action: string }[];
}

export interface RepoPullRequestView {
  id: string;
  number: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state: string;
  createdAt: string;
}

export interface UnreadableFile {
  path: string;
  operation: "readdir" | "stat" | "readFile";
  error: string;
}

export interface RepoSnapshot {
  mode: "GITHUB_BACKED" | "LOCAL_ONLY";
  /** The exact immutable SHA the snapshot was read from. Recorded for reproducibility. */
  head: string | null;
  /** True when the canonicalHeadSha was verified to equal the GitHub branch HEAD. */
  headVerified: boolean;
  /** When headVerified is false, explains why (STALE, UNREACHABLE, etc.). */
  headVerificationNote: string | null;
  branches: RepoBranchView[];
  files: RepoFileView[];
  commits: RepoCommitView[];
  pullRequests: RepoPullRequestView[];
  /** True when the canonical source was unreachable (GitHub API error, no PAT, etc.). */
  unreadable: boolean;
  unreadableReason: string | null;
  /**
   * Phase 17B: What source produced this snapshot.
   * - GITHUB_TARBALL: complete tarball at exact SHA (readiness path) — always complete.
   * - GITHUB_TREES_API: Trees API (UI list-only view) — may be truncated.
   * - LOCAL_EVIDENCE: TaskEvidence-derived (LOCAL_ONLY) — no canonical repo.
   */
  snapshotSource: "GITHUB_TARBALL" | "GITHUB_TREES_API" | "LOCAL_EVIDENCE";
  /**
   * Phase 17C: True when the snapshot represents the COMPLETE repository with
   * NO unreadable files, NO resource-limit violations, and a valid archive.
   * Any unreadable file or extraction error makes this false → readiness fails.
   */
  snapshotComplete: boolean;
  /** True when the Trees API (UI path) returned truncated. Kept for UI diagnostics. */
  truncated: boolean;
  /** Raw file contents (Buffer) from tarball extraction — used by the scanner. */
  rawFiles?: { path: string; content: Buffer }[];
  // --- Phase 17C: Extraction metadata + fail-closed completeness ---
  /** Bytes downloaded (compressed tarball). */
  downloadedBytes: number;
  /** Total bytes of all extracted files (uncompressed). */
  extractedBytes: number;
  /** Number of files extracted from the tarball. */
  extractedFileCount: number;
  /** Files that could not be read during extraction (readdir/stat/readFile failures). */
  unreadableFiles: UnreadableFile[];
  /** Non-null when the snapshot itself is unverified (extraction error, limits exceeded, invalid archive). */
  snapshotError: string | null;
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

export type ProjectMode = "LOCAL_ONLY" | "GITHUB_BACKED";

export function getProjectMode(project: {
  githubConnected: boolean;
  githubRepo: string | null;
}): ProjectMode {
  return project.githubConnected && project.githubRepo
    ? "GITHUB_BACKED"
    : "LOCAL_ONLY";
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function githubHeaders(): Record<string, string> | null {
  const pat = process.env.GITHUB_PAT;
  if (!pat) return null;
  return {
    Authorization: `token ${pat}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Forge-Control-Plane",
  };
}

function inferLanguage(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript",
    py: "python", go: "go", rs: "rust", rb: "ruby",
    java: "java", kt: "kotlin", swift: "swift",
    md: "markdown", json: "json", yml: "yaml", yaml: "yaml",
    toml: "toml", sql: "sql", sh: "shell",
    css: "css", html: "html", prisma: "prisma",
  };
  return ext ? map[ext] ?? null : null;
}

// ---------------------------------------------------------------------------
// Canonical HEAD freshness verification
// ---------------------------------------------------------------------------

/**
 * Verify that project.canonicalHeadSha equals the actual GitHub integration
 * branch HEAD. If they differ, the cached SHA is stale — readiness must block.
 *
 * Returns the verified HEAD SHA, or null if verification failed.
 */
async function verifyCanonicalHeadFreshness(
  owner: string,
  repo: string,
  branch: string,
  cachedHeadSha: string | null,
  headers: Record<string, string>
): Promise<{ sha: string | null; verified: boolean; note: string | null }> {
  try {
    const branchRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
      { headers, signal: AbortSignal.timeout(10000) }
    );

    if (!branchRes.ok) {
      if (branchRes.status === 404) {
        return { sha: null, verified: false, note: `GitHub branch '${branch}' not found` };
      }
      return { sha: null, verified: false, note: `GitHub API returned HTTP ${branchRes.status}` };
    }

    const branchData = await branchRes.json();
    const actualHead = branchData.commit?.sha ?? null;

    if (!actualHead) {
      return { sha: null, verified: false, note: "GitHub branch HEAD is null" };
    }

    if (cachedHeadSha && cachedHeadSha !== actualHead) {
      // CANONICAL_HEAD_STALE — the cached SHA doesn't match the real branch HEAD.
      return {
        sha: actualHead,
        verified: false,
        note: `CANONICAL_HEAD_STALE: cached ${cachedHeadSha.slice(0, 7)} != branch HEAD ${actualHead.slice(0, 7)}`,
      };
    }

    // Either no cached SHA (first time) or it matches.
    return { sha: actualHead, verified: true, note: null };
  } catch (err: any) {
    return { sha: null, verified: false, note: `GitHub API unreachable: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Tarball download + extraction — COMPLETE repository content
// ---------------------------------------------------------------------------

const TARBALL_TIMEOUT_MS = 120000; // 2 minutes
const MAX_TARBALL_SIZE = 200 * 1024 * 1024; // 200 MB compressed download limit
// Phase 17C: Bounded extraction limits (uncompressed content + file count).
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024; // 500 MB total extracted content
const MAX_EXTRACTED_FILES = 100_000; // 100k files max

/**
 * Download the GitHub repository tarball at the exact SHA and extract all
 * file contents. This gives COMPLETE repository coverage in one download —
 * no per-file API calls, no 50-file cap, no tree truncation.
 *
 * Phase 17C: Extraction is fail-closed. Unreadable files, resource-limit
 * violations, and invalid archives all produce a snapshotError and make
 * snapshotComplete = false.
 *
 * Returns extraction metadata + files.
 */
async function downloadAndExtractTarball(
  owner: string,
  repo: string,
  sha: string,
  headers: Record<string, string>
): Promise<{
  files: { path: string; content: Buffer }[];
  downloadedBytes: number;
  extractedBytes: number;
  extractedFileCount: number;
  unreadableFiles: UnreadableFile[];
  snapshotError: string | null;
}> {
  const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`;

  const tempDir = `/tmp/forge-tarball-${sha.slice(0, 12)}-${Date.now()}`;
  const tarballPath = join(tempDir, "repo.tar.gz");
  const extractDir = join(tempDir, "extracted");

  let downloadedBytes = 0;

  try {
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(extractDir, { recursive: true });

    // Download tarball.
    const response = await fetch(tarballUrl, {
      headers,
      signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`GitHub tarball download failed: HTTP ${response.status}`);
    }

    // Phase 17B: Hard streaming byte limit — enforce during download, not just
    // from Content-Length. Chunked responses or missing Content-Length must not
    // bypass the safety boundary.
    const writeStream = createWriteStream(tarballPath);
    const nodeStream = Readable.fromWeb(response.body as any);

    const sizeLimitError = new Error(
      `Tarball exceeded size limit: >${MAX_TARBALL_SIZE} bytes streamed (limit: ${MAX_TARBALL_SIZE})`
    );

    await new Promise<void>((resolve, reject) => {
      let rejected = false;
      const onChunk = (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        if (downloadedBytes > MAX_TARBALL_SIZE) {
          if (!rejected) {
            rejected = true;
            nodeStream.destroy(sizeLimitError);
            writeStream.destroy();
            reject(sizeLimitError);
          }
        }
      };
      nodeStream.on("data", onChunk);
      nodeStream.on("error", (err) => {
        if (!rejected) {
          rejected = true;
          reject(err);
        }
      });
      writeStream.on("error", (err) => {
        if (!rejected) {
          rejected = true;
          reject(err);
        }
      });
      writeStream.on("finish", () => {
        if (!rejected) resolve();
      });
      nodeStream.pipe(writeStream);
    });

    // Extract tarball.
    await tar.x({
      file: tarballPath,
      Cwd: extractDir,
      gzip: true,
    });

    // Phase 17C: Walk with fail-closed error tracking + resource limits.
    // Phase 17D: + repoRootRealpath for symlink containment.
    const ctx: WalkContext = {
      files: [],
      unreadableFiles: [],
      extractedBytes: 0,
      extractedFileCount: 0,
      limitExceeded: false,
      limitExceededReason: null,
      repoRootRealpath: null, // Set after topDir is validated below.
    };

    const extractedRoots = readdirSync(extractDir);

    // Phase 17D: Archive root validation.
    // GitHub tarballs extract to a SINGLE top-level directory like "owner-repo-sha/".
    // Validate that there is exactly one root directory and no unexpected top-level files.
    const rootDirs: string[] = [];
    const unexpectedTopLevelFiles: string[] = [];
    for (const d of extractedRoots) {
      try {
        const stat = statSync(join(extractDir, d));
        if (stat.isDirectory()) {
          rootDirs.push(d);
        } else {
          // Phase 17D: Unexpected top-level file (outside the repo root directory).
          unexpectedTopLevelFiles.push(d);
        }
      } catch (err: any) {
        ctx.unreadableFiles.push({
          path: d,
          operation: "stat",
          error: err.message ?? String(err),
        });
      }
    }

    if (unexpectedTopLevelFiles.length > 0) {
      // Phase 17D: Unexpected top-level files → invalid archive structure.
      return {
        files: [],
        downloadedBytes,
        extractedBytes: 0,
        extractedFileCount: 0,
        unreadableFiles: ctx.unreadableFiles,
        snapshotError: `INVALID_ARCHIVE_STRUCTURE: unexpected top-level file(s) outside repository root: ${unexpectedTopLevelFiles.join(", ")}`,
      };
    }

    if (rootDirs.length === 0) {
      // Phase 17C: No valid repository root → invalid archive.
      return {
        files: [],
        downloadedBytes,
        extractedBytes: 0,
        extractedFileCount: 0,
        unreadableFiles: ctx.unreadableFiles,
        snapshotError: "Invalid archive: no top-level repository directory found after extraction",
      };
    }

    if (rootDirs.length > 1) {
      // Phase 17D: Multiple root directories → invalid archive structure.
      return {
        files: [],
        downloadedBytes,
        extractedBytes: 0,
        extractedFileCount: 0,
        unreadableFiles: ctx.unreadableFiles,
        snapshotError: `INVALID_ARCHIVE_STRUCTURE: multiple top-level repository directories found: ${rootDirs.join(", ")}`,
      };
    }

    const topDir = rootDirs[0];
    const repoRoot = join(extractDir, topDir);

    // Phase 17D: Resolve the real path of the repository root for symlink containment.
    try {
      ctx.repoRootRealpath = realpathSync(repoRoot);
    } catch (err: any) {
      return {
        files: [],
        downloadedBytes,
        extractedBytes: 0,
        extractedFileCount: 0,
        unreadableFiles: ctx.unreadableFiles,
        snapshotError: `Failed to resolve repository root realpath: ${err.message ?? String(err)}`,
      };
    }

    walkDirectory(repoRoot, "", ctx);

    // Phase 17C: Determine snapshot error.
    let snapshotError: string | null = null;
    if (ctx.limitExceeded) {
      snapshotError = ctx.limitExceededReason;
    } else if (ctx.unreadableFiles.length > 0) {
      snapshotError = `${ctx.unreadableFiles.length} unreadable file(s) during extraction`;
    } else if (ctx.files.length === 0) {
      snapshotError = "Archive extracted but contained zero files";
    }

    return {
      files: ctx.files,
      downloadedBytes,
      extractedBytes: ctx.extractedBytes,
      extractedFileCount: ctx.extractedFileCount,
      unreadableFiles: ctx.unreadableFiles,
      snapshotError,
    };
  } finally {
    // Clean up temp directory.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

interface WalkContext {
  files: { path: string; content: Buffer }[];
  unreadableFiles: UnreadableFile[];
  extractedBytes: number;
  extractedFileCount: number;
  limitExceeded: boolean;
  limitExceededReason: string | null;
  /** Phase 17D: Resolved real path of the repository root for symlink containment. */
  repoRootRealpath: string | null;
}

/**
 * Phase 17D: Walk the extracted directory and read all files.
 *
 * FAIL-CLOSED: readdir/stat/readFile failures are recorded in ctx.unreadableFiles.
 * They are NOT silently skipped. Any unreadable file makes snapshotComplete = false.
 *
 * RESOURCE LIMITS: extracted bytes and file count are tracked. If either limit
 * is exceeded, walking stops and ctx.limitExceeded is set.
 *
 * Phase 17D HARDENING:
 *   1. PRE-READ SIZE CHECK — stat.size is checked BEFORE readFileSync. A file
 *      larger than the remaining aggregate budget is rejected without being
 *      loaded into memory.
 *   2. SYMLINK CONTAINMENT — lstatSync detects symlinks. realpathSync resolves
 *      the target. If the target escapes the repository root, the entry is
 *      recorded as untrusted and snapshotComplete = false. Symlinks are NEVER
 *      followed outside the extraction root.
 */
function walkDirectory(
  basePath: string,
  relativePath: string,
  ctx: WalkContext
): void {
  // Stop if a limit was already exceeded.
  if (ctx.limitExceeded) return;

  const fullPath = relativePath ? join(basePath, relativePath) : basePath;
  let entries: string[];
  try {
    entries = readdirSync(fullPath);
  } catch (err: any) {
    // Phase 17C: readdir failure is an unreadable file (directory).
    ctx.unreadableFiles.push({
      path: relativePath || ".",
      operation: "readdir",
      error: err.message ?? String(err),
    });
    return;
  }

  for (const entry of entries) {
    if (ctx.limitExceeded) return;

    const entryRelative = relativePath ? `${relativePath}/${entry}` : entry;
    const entryFull = join(fullPath, entry);

    // Skip .git directory — we don't scan git internals.
    if (entry === ".git") continue;

    // Phase 17D: Use lstatSync (not statSync) to detect symlinks without following.
    let lstat;
    try {
      lstat = lstatSync(entryFull);
    } catch (err: any) {
      ctx.unreadableFiles.push({
        path: entryRelative,
        operation: "stat",
        error: err.message ?? String(err),
      });
      continue;
    }

    // Phase 17D: Symlink containment check.
    if (lstat.isSymbolicLink()) {
      let resolvedTarget: string | null = null;
      try {
        resolvedTarget = realpathSync(entryFull);
      } catch (err: any) {
        ctx.unreadableFiles.push({
          path: entryRelative,
          operation: "stat",
          error: `Symlink resolution failed: ${err.message ?? String(err)}`,
        });
        continue;
      }

      // The repo root is ctx.repoRootRealpath (resolved once at the start).
      // If the symlink target is not inside the repo root, reject it.
      if (ctx.repoRootRealpath && !resolvedTarget.startsWith(ctx.repoRootRealpath + "/") && resolvedTarget !== ctx.repoRootRealpath) {
        ctx.unreadableFiles.push({
          path: entryRelative,
          operation: "stat",
          error: `SYMLINK_ESCAPE: symlink target ${resolvedTarget} is outside repository root ${ctx.repoRootRealpath}`,
        });
        // Symlink escape is a security violation — mark as snapshot error.
        ctx.limitExceeded = true;
        ctx.limitExceededReason = `SYMLINK_ESCAPE at ${entryRelative}: target outside repository root`;
        return;
      }

      // Symlink points inside the repo — follow it (statSync follows symlinks).
      // This is safe because we've verified the target is contained.
      try {
        const followedStat = statSync(entryFull);
        if (followedStat.isDirectory()) {
          walkDirectory(basePath, entryRelative, ctx);
        } else if (followedStat.isFile()) {
          readFileEntry(entryFull, entryRelative, followedStat, ctx);
        }
      } catch (err: any) {
        ctx.unreadableFiles.push({
          path: entryRelative,
          operation: "stat",
          error: `Symlink follow failed: ${err.message ?? String(err)}`,
        });
      }
      continue;
    }

    // Normal entry (not a symlink).
    if (lstat.isDirectory()) {
      walkDirectory(basePath, entryRelative, ctx);
    } else if (lstat.isFile()) {
      readFileEntry(entryFull, entryRelative, lstat, ctx);
    }
  }
}

/**
 * Phase 17D: Read a single file with pre-read size check.
 *
 * The file size (from stat) is checked BEFORE readFileSync. If the file would
 * exceed the remaining aggregate budget, it is rejected without being loaded
 * into memory. This prevents a single large file from causing an unbounded
 * memory allocation.
 */
function readFileEntry(
  entryFull: string,
  entryRelative: string,
  stat: { size: number },
  ctx: WalkContext
): void {
  // Phase 17C: Check file-count limit before reading.
  if (ctx.extractedFileCount >= MAX_EXTRACTED_FILES) {
    ctx.limitExceeded = true;
    ctx.limitExceededReason = `Exceeded MAX_EXTRACTED_FILES limit (${MAX_EXTRACTED_FILES}) at file: ${entryRelative}`;
    return;
  }

  // Phase 17D: PRE-READ SIZE CHECK.
  // Check stat.size BEFORE readFileSync to avoid loading a file larger than
  // the remaining aggregate budget into memory.
  if (ctx.extractedBytes + stat.size > MAX_EXTRACTED_BYTES) {
    ctx.limitExceeded = true;
    ctx.limitExceededReason = `File ${entryRelative} is ${stat.size} bytes; remaining budget ${MAX_EXTRACTED_BYTES - ctx.extractedBytes} bytes — would exceed MAX_EXTRACTED_BYTES limit (${MAX_EXTRACTED_BYTES})`;
    return;
  }

  try {
    const content = readFileSync(entryFull);
    // Double-check after read (stat.size may differ from actual content.length
    // in edge cases, e.g. file changed between stat and read).
    if (ctx.extractedBytes + content.length > MAX_EXTRACTED_BYTES) {
      ctx.limitExceeded = true;
      ctx.limitExceededReason = `File ${entryRelative} content is ${content.length} bytes — exceeded MAX_EXTRACTED_BYTES limit (${MAX_EXTRACTED_BYTES}) after read`;
      return;
    }
    ctx.files.push({ path: entryRelative, content });
    ctx.extractedBytes += content.length;
    ctx.extractedFileCount++;
  } catch (err: any) {
    // Phase 17C: readFile failure is an unreadable file.
    ctx.unreadableFiles.push({
      path: entryRelative,
      operation: "readFile",
      error: err.message ?? String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// GITHUB_BACKED reader — tarball-based COMPLETE content
// ---------------------------------------------------------------------------

async function readGitHubSnapshot(
  project: {
    id: string;
    githubRepo: string;
    githubDefaultBranch: string;
    canonicalHeadSha: string | null;
  },
  withContent: boolean,
  verifyFreshness: boolean
): Promise<RepoSnapshot> {
  const headers = githubHeaders();
  if (!headers) {
    return emptySnapshot("GITHUB_BACKED", true, "No GITHUB_PAT configured — cannot read GitHub repository");
  }

  const [owner, repo] = project.githubRepo.split("/");
  const branch = project.githubDefaultBranch || "main";

  // --- Canonical HEAD freshness verification (Phase 17A) ---
  let verifiedSha = project.canonicalHeadSha;
  let headVerified = true;
  let headVerificationNote: string | null = null;

  if (verifyFreshness) {
    const result = await verifyCanonicalHeadFreshness(
      owner, repo, branch, project.canonicalHeadSha, headers
    );
    verifiedSha = result.sha;
    headVerified = result.verified;
    headVerificationNote = result.note;

    if (!verifiedSha) {
      return {
        ...emptySnapshot("GITHUB_BACKED", true, headVerificationNote ?? "Canonical HEAD verification failed"),
        headVerified: false,
        headVerificationNote,
      };
    }

    if (!headVerified) {
      // CANONICAL_HEAD_STALE — return readable snapshot but mark as not verified.
      // Readiness will block on headVerified === false.
    }
  } else {
    // No freshness verification requested (UI list view).
    // Still need to resolve a SHA if canonicalHeadSha is null.
    if (!verifiedSha) {
      try {
        const branchRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
          { headers, signal: AbortSignal.timeout(10000) }
        );
        if (branchRes.ok) {
          const bd = await branchRes.json();
          verifiedSha = bd.commit?.sha ?? null;
        } else if (branchRes.status === 404) {
          return emptySnapshot("GITHUB_BACKED", true, `GitHub repository or branch not found: ${owner}/${repo}:${branch}`);
        }
      } catch {
        return emptySnapshot("GITHUB_BACKED", true, "GitHub API unreachable (branch lookup failed)");
      }
    }
  }

  const sha = verifiedSha!;

  if (withContent) {
    // --- COMPLETE content via tarball (Phase 17A) ---
    // No 50-file cap. Downloads the entire repo at the exact SHA.
    let tarballResult: {
      files: { path: string; content: Buffer }[];
      downloadedBytes: number;
      extractedBytes: number;
      extractedFileCount: number;
      unreadableFiles: UnreadableFile[];
      snapshotError: string | null;
    };
    try {
      tarballResult = await downloadAndExtractTarball(owner, repo, sha, headers);
    } catch (err: any) {
      return {
        ...emptySnapshot("GITHUB_BACKED", true, `Tarball download/extraction failed: ${err.message}`),
        headVerified,
        headVerificationNote,
        head: sha,
      };
    }

    // Build file views from raw tarball content.
    const files: RepoFileView[] = tarballResult.files.map((f) => ({
      id: f.path,
      path: f.path,
      language: inferLanguage(f.path),
      bytes: f.content.length,
      content: null, // Content is in rawFiles for the scanner; UI list doesn't need it here.
      suspiciousPatterns: [], // Computed by the scanner, not the reader.
      branch,
      commitSha: sha,
    }));

    // Fetch commits and PRs for UI display (non-fatal if they fail).
    const [commits, pullRequests] = await Promise.all([
      fetchCommits(owner, repo, branch, headers),
      fetchPullRequests(owner, repo, headers),
    ]);

    // Phase 17C: snapshotComplete is true ONLY when there are no unreadable files,
    // no snapshot error, and the archive was valid.
    const snapshotComplete =
      tarballResult.snapshotError === null &&
      tarballResult.unreadableFiles.length === 0;

    return {
      mode: "GITHUB_BACKED",
      head: sha,
      headVerified,
      headVerificationNote,
      branches: [{ id: branch, name: branch, headSha: sha, isDefault: true }],
      files,
      commits,
      pullRequests,
      unreadable: false,
      unreadableReason: null,
      snapshotSource: "GITHUB_TARBALL",
      snapshotComplete,
      truncated: false,
      rawFiles: tarballResult.files,
      downloadedBytes: tarballResult.downloadedBytes,
      extractedBytes: tarballResult.extractedBytes,
      extractedFileCount: tarballResult.extractedFileCount,
      unreadableFiles: tarballResult.unreadableFiles,
      snapshotError: tarballResult.snapshotError,
    };
  }

  // --- List-only view (no content) — uses Trees API with truncation detection ---
  let treeResult: { entries: { path: string; size?: number }[]; truncated: boolean };
  try {
    const treeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
      { headers, signal: AbortSignal.timeout(15000) }
    );
    if (treeRes.ok) {
      const treeData = await treeRes.json();
      treeResult = {
        entries: (treeData.tree || []).filter((e: any) => e.type === "blob").map((e: any) => ({ path: e.path, size: e.size })),
        truncated: treeData.truncated === true,
      };
    } else {
      treeResult = { entries: [], truncated: false };
    }
  } catch {
    treeResult = { entries: [], truncated: false };
  }

  const files: RepoFileView[] = treeResult.entries.map((e) => ({
    id: e.path,
    path: e.path,
    language: inferLanguage(e.path),
    bytes: e.size ?? 0,
    content: null,
    suspiciousPatterns: [],
    branch,
    commitSha: sha,
  }));

  const [commits, pullRequests] = await Promise.all([
    fetchCommits(owner, repo, branch, headers),
    fetchPullRequests(owner, repo, headers),
  ]);

  return {
    mode: "GITHUB_BACKED",
    head: sha,
    headVerified,
    headVerificationNote,
    branches: [{ id: branch, name: branch, headSha: sha, isDefault: true }],
    files,
    commits,
    pullRequests,
    unreadable: false,
    unreadableReason: null,
    // Phase 17B: Trees API path (UI list-only). May be truncated.
    snapshotSource: "GITHUB_TREES_API",
    snapshotComplete: !treeResult.truncated,
    truncated: treeResult.truncated,
    // Phase 17C: Trees API path doesn't extract content.
    downloadedBytes: 0,
    extractedBytes: 0,
    extractedFileCount: files.length,
    unreadableFiles: [],
    snapshotError: null,
  };
}

// ---------------------------------------------------------------------------
// GitHub commits + PRs fetch (shared, non-fatal)
// ---------------------------------------------------------------------------

async function fetchCommits(
  owner: string,
  repo: string,
  branch: string,
  headers: Record<string, string>
): Promise<RepoCommitView[]> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=50`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data as any[]).map((c) => ({
      id: c.sha,
      sha: c.sha,
      branch,
      message: c.commit?.message?.split("\n")[0] ?? "",
      author: c.commit?.author?.name ?? "unknown",
      createdAt: c.commit?.author?.date ?? new Date().toISOString(),
      filesChanged: [],
    }));
  } catch {
    return [];
  }
}

async function fetchPullRequests(
  owner: string,
  repo: string,
  headers: Record<string, string>
): Promise<RepoPullRequestView[]> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&per_page=30&sort=updated&direction=desc`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data as any[]).map((p) => ({
      id: String(p.number),
      number: p.number,
      title: p.title,
      sourceBranch: p.head?.ref ?? "",
      targetBranch: p.base?.ref ?? "",
      state: (p.merged_at ? "MERGED" : p.state?.toUpperCase()) ?? "OPEN",
      createdAt: p.created_at ?? new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// LOCAL_ONLY reader — derives a best-available view from TaskEvidence
// ---------------------------------------------------------------------------

async function readLocalSnapshot(projectId: string): Promise<RepoSnapshot> {
  // TaskEvidence is the authoritative observation ledger for local-only projects.
  // There is no persistent repository — the worker's /tmp checkout is deleted.
  const evidence = await db.taskEvidence.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    select: {
      commitSha: true,
      branchName: true,
      changedFiles: true,
      createdAt: true,
    },
  });

  const tasks = await db.task.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    select: { code: true, title: true, commitSha: true, filesChangedJson: true },
  });

  const commits: RepoCommitView[] = [];
  const fileMap = new Map<string, RepoFileView>();

  for (const ev of evidence) {
    if (!ev.commitSha) continue;
    const task = tasks.find((t) => t.commitSha === ev.commitSha);
    const changedFiles = JSON.parse(ev.changedFiles || "[]") as string[];
    commits.push({
      id: ev.commitSha,
      sha: ev.commitSha,
      branch: ev.branchName ?? "main",
      message: task ? `[${task.code}] ${task.title}` : "local commit",
      author: "forge-worker",
      createdAt: ev.createdAt.toISOString(),
      filesChanged: changedFiles.map((p) => ({ path: p, action: "update" })),
    });
    // Phase 17A: NEWEST evidence for a path wins (was: first occurrence).
    for (const path of changedFiles) {
      fileMap.set(path, {
        id: path,
        path,
        language: inferLanguage(path),
        bytes: 0,
        content: null, // LOCAL_ONLY: content not persisted
        suspiciousPatterns: [],
        branch: ev.branchName,
        commitSha: ev.commitSha,
      });
    }
  }

  const head = commits.length > 0 ? commits[commits.length - 1].sha : null;

  return {
    mode: "LOCAL_ONLY",
    head,
    headVerified: false, // No GitHub to verify against
    headVerificationNote: "LOCAL_ONLY — no canonical HEAD to verify",
    branches: head ? [{ id: "main", name: "main", headSha: head, isDefault: true }] : [],
    files: Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path)),
    commits: commits.reverse(), // newest first
    pullRequests: [],
    unreadable: false,
    unreadableReason: null,
    snapshotSource: "LOCAL_EVIDENCE",
    snapshotComplete: false, // No complete repository exists for LOCAL_ONLY
    truncated: false,
    // Phase 17C: LOCAL_ONLY has no tarball extraction.
    downloadedBytes: 0,
    extractedBytes: 0,
    extractedFileCount: fileMap.size,
    unreadableFiles: [],
    snapshotError: "LOCAL_ONLY — no canonical repository to extract",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function emptySnapshot(
  mode: ProjectMode,
  unreadable: boolean,
  reason: string | null
): RepoSnapshot {
  return {
    mode,
    head: null,
    headVerified: false,
    headVerificationNote: reason,
    branches: [],
    files: [],
    commits: [],
    pullRequests: [],
    unreadable,
    unreadableReason: reason,
    snapshotSource: mode === "GITHUB_BACKED" ? "GITHUB_TARBALL" : "LOCAL_EVIDENCE",
    snapshotComplete: false,
    truncated: false,
    // Phase 17C: empty snapshot metadata.
    downloadedBytes: 0,
    extractedBytes: 0,
    extractedFileCount: 0,
    unreadableFiles: [],
    snapshotError: reason,
  };
}

/**
 * Get the canonical repository snapshot.
 *
 * @param project The project.
 * @param withContent When true, downloads the COMPLETE repository tarball
 *                    (GITHUB_BACKED only). No file-count cap.
 * @param verifyFreshness When true, verifies canonicalHeadSha equals the
 *                        actual GitHub branch HEAD. Use true for readiness
 *                        (fail-closed on staleness), false for UI display.
 */
export async function getRepositorySnapshot(
  project: {
    id: string;
    githubConnected: boolean;
    githubRepo: string | null;
    githubDefaultBranch: string;
    canonicalHeadSha: string | null;
  },
  withContent = false,
  verifyFreshness = false
): Promise<RepoSnapshot> {
  const mode = getProjectMode(project);
  if (mode === "GITHUB_BACKED") {
    return readGitHubSnapshot(project, withContent, verifyFreshness);
  }
  return readLocalSnapshot(project.id);
}

/**
 * Get a single file's content from the canonical source.
 * Used by the file-detail UI route.
 */
export async function getFileContent(
  project: {
    id: string;
    githubConnected: boolean;
    githubRepo: string | null;
    githubDefaultBranch: string;
    canonicalHeadSha: string | null;
  },
  path: string
): Promise<RepoFileView | null> {
  const mode = getProjectMode(project);

  if (mode === "GITHUB_BACKED") {
    const headers = githubHeaders();
    if (!headers) return null;
    const [owner, repo] = project.githubRepo!.split("/");
    const ref = project.canonicalHeadSha || project.githubDefaultBranch || "main";
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`,
        { headers, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const content =
        data.encoding === "base64" && data.content
          ? Buffer.from(data.content, "base64").toString("utf-8")
          : null;
      return {
        id: path,
        path,
        language: inferLanguage(path),
        bytes: data.size ?? (content?.length ?? 0),
        content,
        suspiciousPatterns: [], // Computed by scanner, not reader
        branch: project.githubDefaultBranch,
        commitSha: ref,
      };
    } catch {
      return null;
    }
  }

  // LOCAL_ONLY: content not persisted — check evidence for the path.
  const ev = await db.taskEvidence.findFirst({
    where: { projectId: project.id, changedFiles: { contains: path } },
    orderBy: { createdAt: "desc" },
  });
  if (!ev) return null;
  return {
    id: path,
    path,
    language: inferLanguage(path),
    bytes: 0,
    content: null,
    suspiciousPatterns: [],
    branch: ev.branchName,
    commitSha: ev.commitSha,
  };
}
