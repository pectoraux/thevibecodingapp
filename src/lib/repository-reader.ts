// Forge — Phase 17: Canonical Repository Read Adapter.
//
// This is the ONE canonical reader for repository state used by:
//   - the Production Readiness Gate (src/lib/readiness.ts)
//   - the Repository UI (GET /api/projects/[id]/repository)
//
// CANONICAL SOURCE INVARIANT:
//   GITHUB_BACKED → reads the ACTUAL GitHub repository (integration branch).
//   LOCAL_ONLY    → derives a best-available view from TaskEvidence
//                   (there is no persistent local repo — the worker's /tmp
//                   checkout is deleted after execution).
//
// This module NEVER writes to RepoBranch/RepoCommit/RepoFile/PullRequest.
// Those DB models are legacy metadata only (see prisma/schema.prisma).
//
// Evidence vs Repository distinction:
//   TaskEvidence = what Forge observed (immutable ledger)
//   GitHub       = what the repository actually contains
// For GITHUB_BACKED, repository truth comes from GitHub. For LOCAL_ONLY,
// there is no persistent repository, so evidence is the best-available source.

import { db } from "@/lib/db";
import { SUSPICIOUS_PATTERNS } from "@/lib/types";

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
  content: string | null; // null when unavailable (LOCAL_ONLY, binary, or too large)
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
  head: string | null;
  branches: RepoBranchView[];
  files: RepoFileView[];
  commits: RepoCommitView[];
  pullRequests: RepoPullRequestView[];
  /** True when the canonical source was unreachable (GitHub API error, no PAT, etc.). */
  unreadable: boolean;
  unreadableReason: string | null;
}

// ---------------------------------------------------------------------------
// Suspicious-pattern scanner (pure utility — operates on content)
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
// GitHub API helpers (consistent with submit-evidence / merge route pattern)
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
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    go: "go",
    rs: "rust",
    rb: "ruby",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    md: "markdown",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sql: "sql",
    sh: "shell",
    css: "css",
    html: "html",
    prisma: "prisma",
  };
  return ext ? map[ext] ?? null : null;
}

const SOURCE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "go",
  "rs",
  "rb",
  "java",
  "kt",
  "swift",
  "sh",
  "css",
  "html",
  "sql",
  "prisma",
  "md",
  "json",
  "yml",
  "yaml",
  "toml",
]);

function isSourceFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? SOURCE_EXTENSIONS.has(ext) : false;
}

// Max files to fetch individual content for (avoids rate-limit exhaustion).
const MAX_CONTENT_FETCHES = 50;

// ---------------------------------------------------------------------------
// GITHUB_BACKED reader — reads the ACTUAL GitHub repository
// ---------------------------------------------------------------------------

async function readGitHubSnapshot(
  project: {
    id: string;
    githubRepo: string;
    githubDefaultBranch: string;
    canonicalHeadSha: string | null;
  },
  withContent: boolean
): Promise<RepoSnapshot> {
  const headers = githubHeaders();
  if (!headers) {
    return emptySnapshot("GITHUB_BACKED", true, "No GITHUB_PAT configured — cannot read GitHub repository");
  }

  const [owner, repo] = project.githubRepo.split("/");
  const branch = project.githubDefaultBranch || "main";
  const ref = project.canonicalHeadSha || branch;

  // 1. Determine HEAD SHA.
  let headSha = project.canonicalHeadSha;
  if (!headSha) {
    try {
      const branchRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
        { headers, signal: AbortSignal.timeout(10000) }
      );
      if (branchRes.ok) {
        const bd = await branchRes.json();
        headSha = bd.commit?.sha ?? null;
      } else if (branchRes.status === 404) {
        return emptySnapshot("GITHUB_BACKED", true, `GitHub repository or branch not found: ${owner}/${repo}:${branch}`);
      }
    } catch {
      return emptySnapshot("GITHUB_BACKED", true, `GitHub API unreachable (branch lookup failed)`);
    }
  }

  // 2. Fetch tree (file paths + sizes) — one API call.
  let treeEntries: { path: string; type: string; size?: number; sha?: string }[] = [];
  if (headSha) {
    try {
      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${headSha}?recursive=1`,
        { headers, signal: AbortSignal.timeout(15000) }
      );
      if (treeRes.ok) {
        const treeData = await treeRes.json();
        treeEntries = (treeData.tree || []).filter((e: any) => e.type === "blob");
      }
    } catch {
      // Non-fatal — files will be empty but head/commits may still work.
    }
  }

  // 3. Fetch file contents for source files (capped) if requested.
  const files: RepoFileView[] = [];
  const sourceEntries = withContent
    ? treeEntries.filter((e) => isSourceFile(e.path)).slice(0, MAX_CONTENT_FETCHES)
    : [];

  // Build file views: all tree entries get path/size; source entries get content.
  const contentMap = new Map<string, string>();
  if (withContent) {
    for (const entry of sourceEntries) {
      try {
        const contentRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(entry.path)}?ref=${headSha}`,
          { headers, signal: AbortSignal.timeout(10000) }
        );
        if (contentRes.ok) {
          const contentData = await contentRes.json();
          if (contentData.encoding === "base64" && contentData.content) {
            contentMap.set(entry.path, Buffer.from(contentData.content, "base64").toString("utf-8"));
          }
        }
      } catch {
        // Non-fatal per-file — skip.
      }
    }
  }

  for (const entry of treeEntries) {
    const content = contentMap.get(entry.path) ?? null;
    files.push({
      id: entry.path,
      path: entry.path,
      language: inferLanguage(entry.path),
      bytes: entry.size ?? 0,
      content,
      suspiciousPatterns: content ? scanSuspiciousPatterns(content) : [],
      branch,
      commitSha: headSha,
    });
  }

  // 4. Fetch commits (capped at 50).
  let commits: RepoCommitView[] = [];
  try {
    const commitsRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=50`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (commitsRes.ok) {
      const commitsData = await commitsRes.json();
      commits = (commitsData as any[]).map((c) => ({
        id: c.sha,
        sha: c.sha,
        branch,
        message: c.commit?.message?.split("\n")[0] ?? "",
        author: c.commit?.author?.name ?? "unknown",
        createdAt: c.commit?.author?.date ?? new Date().toISOString(),
        filesChanged: [],
      }));
    }
  } catch {
    // Non-fatal.
  }

  // 5. Fetch pull requests (open + recently merged).
  let pullRequests: RepoPullRequestView[] = [];
  try {
    const prsRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&per_page=30&sort=updated&direction=desc`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (prsRes.ok) {
      const prsData = await prsRes.json();
      pullRequests = (prsData as any[]).map((p) => ({
        id: String(p.number),
        number: p.number,
        title: p.title,
        sourceBranch: p.head?.ref ?? "",
        targetBranch: p.base?.ref ?? "",
        state: (p.merged_at ? "MERGED" : p.state?.toUpperCase()) ?? "OPEN",
        createdAt: p.created_at ?? new Date().toISOString(),
      }));
    }
  } catch {
    // Non-fatal.
  }

  // 6. Branches — just the default + any forge/* branches from PRs.
  const branches: RepoBranchView[] = [
    { id: branch, name: branch, headSha, isDefault: true },
  ];

  return {
    mode: "GITHUB_BACKED",
    head: headSha,
    branches,
    files,
    commits,
    pullRequests,
    unreadable: false,
    unreadableReason: null,
  };
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

  // Also pull task-level metadata for richer commit messages.
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
    for (const path of changedFiles) {
      if (!fileMap.has(path)) {
        fileMap.set(path, {
          id: path,
          path,
          language: inferLanguage(path),
          bytes: 0, // unknown — content not persisted
          content: null, // LOCAL_ONLY: content not available
          suspiciousPatterns: [], // cannot scan without content
          branch: ev.branchName,
          commitSha: ev.commitSha,
        });
      }
    }
  }

  const head = commits.length > 0 ? commits[commits.length - 1].sha : null;

  return {
    mode: "LOCAL_ONLY",
    head,
    branches: head ? [{ id: "main", name: "main", headSha: head, isDefault: true }] : [],
    files: Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path)),
    commits: commits.reverse(), // newest first
    pullRequests: [], // no PRs for local-only
    unreadable: false,
    unreadableReason: null,
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
    branches: [],
    files: [],
    commits: [],
    pullRequests: [],
    unreadable,
    unreadableReason: reason,
  };
}

/**
 * Get the canonical repository snapshot.
 *
 * @param project The project (must include githubConnected, githubRepo, etc.)
 * @param withContent When true, fetches file contents for source files
 *                    (GITHUB_BACKED only; capped at 50 files). Use false for
 *                    list views, true for content-based readiness checks.
 */
export async function getRepositorySnapshot(
  project: {
    id: string;
    githubConnected: boolean;
    githubRepo: string | null;
    githubDefaultBranch: string;
    canonicalHeadSha: string | null;
  },
  withContent = false
): Promise<RepoSnapshot> {
  const mode = getProjectMode(project);
  if (mode === "GITHUB_BACKED") {
    return readGitHubSnapshot(project, withContent);
  }
  return readLocalSnapshot(project.id);
}

/**
 * Get a single file's content from the canonical source.
 * Used by the file-detail UI route and content-based readiness checks.
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
        suspiciousPatterns: content ? scanSuspiciousPatterns(content) : [],
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
    content: null, // LOCAL_ONLY: content not available
    suspiciousPatterns: [],
    branch: ev.branchName,
    commitSha: ev.commitSha,
  };
}
