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
import { createWriteStream, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
  /** True when the tree was truncated (incomplete file list). Readiness must fail. */
  truncated: boolean;
  /** Raw file contents (Buffer) from tarball extraction — used by the scanner. */
  rawFiles?: { path: string; content: Buffer }[];
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
const MAX_TARBALL_SIZE = 200 * 1024 * 1024; // 200 MB safety limit

/**
 * Download the GitHub repository tarball at the exact SHA and extract all
 * file contents. This gives COMPLETE repository coverage in one download —
 * no per-file API calls, no 50-file cap, no tree truncation.
 *
 * Returns an array of { path, content: Buffer } for every file in the repo.
 */
async function downloadAndExtractTarball(
  owner: string,
  repo: string,
  sha: string,
  headers: Record<string, string>
): Promise<{ files: { path: string; content: Buffer }[]; truncated: boolean }> {
  const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`;

  const tempDir = `/tmp/forge-tarball-${sha.slice(0, 12)}-${Date.now()}`;
  const tarballPath = join(tempDir, "repo.tar.gz");
  const extractDir = join(tempDir, "extracted");

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

    const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_TARBALL_SIZE) {
      throw new Error(`Tarball too large: ${contentLength} bytes (limit: ${MAX_TARBALL_SIZE})`);
    }

    // Write tarball to disk (streaming).
    const writeStream = createWriteStream(tarballPath);
    const nodeStream = Readable.fromWeb(response.body as any);
    await new Promise<void>((resolve, reject) => {
      nodeStream.pipe(writeStream);
      nodeStream.on("error", reject);
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);
    });

    // Extract tarball.
    await tar.x({
      file: tarballPath,
      Cwd: extractDir,
      gzip: true,
    });

    // Walk extracted directory and read all files.
    const files: { path: string; content: Buffer }[] = [];
    const extractedRoots = readdirSync(extractDir);

    // GitHub tarballs extract to a single top-level directory like
    // "owner-repo-sha/". We need to strip that prefix.
    const topDir = extractedRoots.find((d) => {
      const stat = statSync(join(extractDir, d));
      return stat.isDirectory();
    });

    if (!topDir) {
      return { files: [], truncated: false };
    }

    const repoRoot = join(extractDir, topDir);
    walkDirectory(repoRoot, "", files);

    return { files, truncated: false };
  } finally {
    // Clean up temp directory.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

function walkDirectory(
  basePath: string,
  relativePath: string,
  files: { path: string; content: Buffer }[]
): void {
  const fullPath = relativePath ? join(basePath, relativePath) : basePath;
  let entries: string[];
  try {
    entries = readdirSync(fullPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryRelative = relativePath ? `${relativePath}/${entry}` : entry;
    const entryFull = join(fullPath, entry);

    // Skip .git directory — we don't scan git internals.
    if (entry === ".git") continue;

    let stat;
    try {
      stat = statSync(entryFull);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      walkDirectory(basePath, entryRelative, files);
    } else if (stat.isFile()) {
      try {
        const content = readFileSync(entryFull);
        files.push({ path: entryRelative, content });
      } catch {
        // Skip unreadable files.
      }
    }
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
    let tarballResult: { files: { path: string; content: Buffer }[]; truncated: boolean };
    try {
      tarballResult = await downloadAndExtractTarball(owner, repo, sha, headers);
    } catch (err: any) {
      return {
        ...emptySnapshot("GITHUB_BACKED", true, `Tarball download/extraction failed: ${err.message}`),
        headVerified,
        headVerificationNote,
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
      truncated: tarballResult.truncated,
      rawFiles: tarballResult.files,
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
    truncated: treeResult.truncated,
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
    truncated: false,
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
    truncated: false,
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
