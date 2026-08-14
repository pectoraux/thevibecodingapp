// Forge — virtual repository (DB-backed GitHub simulation).
//
// The platform treats GitHub as the canonical source of project code. In this
// sandbox we cannot make real GitHub API calls, so we simulate a fully
// functional repository inside SQLite: branches, commits, files, PRs.
//
// The GitProvider interface is the seam where a real GitHub adapter would
// plug in. Every meaningful agent change is recorded as a commit.

import { db } from "@/lib/db";
import { shortSha } from "@/lib/crypto";
import { SUSPICIOUS_PATTERNS } from "@/lib/types";
import type { RepoFile, RepoCommit, PullRequest } from "@prisma/client";

// ---------------------------------------------------------------------------
// Suspicious-pattern scanner (Fake Implementation Detector)
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
// Branch operations
// ---------------------------------------------------------------------------

export async function ensureBranch(projectId: string, name: string, fromBranch?: string) {
  const existing = await db.repoBranch.findUnique({
    where: { projectId_name: { projectId, name } },
  });
  if (existing) return existing;
  return db.repoBranch.create({
    data: { projectId, name, fromBranch },
  });
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

export interface WriteFileInput {
  projectId: string;
  path: string;
  content: string;
  language?: string;
  taskId?: string;
  commitSha?: string;
}

export async function writeFileToRepo(input: WriteFileInput) {
  const suspicious = scanSuspiciousPatterns(input.content);
  const existing = await db.repoFile.findUnique({
    where: { projectId_path: { projectId: input.projectId, path: input.path } },
  });
  if (existing) {
    return db.repoFile.update({
      where: { id: existing.id },
      data: {
        content: input.content,
        language: input.language ?? existing.language,
        bytes: Buffer.byteLength(input.content, "utf-8"),
        createdInCommit: input.commitSha ?? existing.createdInCommit,
        taskId: input.taskId ?? existing.taskId,
        suspiciousPatterns: JSON.stringify(suspicious),
        updatedAt: new Date(),
      },
    });
  }
  return db.repoFile.create({
    data: {
      projectId: input.projectId,
      path: input.path,
      content: input.content,
      language: input.language,
      bytes: Buffer.byteLength(input.content, "utf-8"),
      createdInCommit: input.commitSha,
      taskId: input.taskId,
      suspiciousPatterns: JSON.stringify(suspicious),
    },
  });
}

export async function listFiles(projectId: string): Promise<RepoFile[]> {
  return db.repoFile.findMany({
    where: { projectId },
    orderBy: { path: "asc" },
  });
}

export async function getFile(projectId: string, path: string) {
  return db.repoFile.findUnique({
    where: { projectId_path: { projectId, path } },
  });
}

// ---------------------------------------------------------------------------
// Commit operations
// ---------------------------------------------------------------------------

export interface CommitInput {
  projectId: string;
  branchName: string;
  message: string;
  files: { path: string; action: "create" | "update" | "delete"; content?: string; language?: string }[];
  taskId?: string;
  authorName?: string;
}

export async function createCommit(input: CommitInput): Promise<{ commit: RepoCommit; sha: string }> {
  const parent = await db.repoCommit.findFirst({
    where: { projectId: input.projectId, branchName: input.branchName },
    orderBy: { createdAt: "desc" },
  });
  const sha = shortSha(
    `${input.projectId}:${input.branchName}:${input.message}:${Date.now()}:${Math.random()}`
  );

  // Write all files first (so the commit references them).
  for (const f of input.files) {
    if (f.action === "delete") {
      await db.repoFile.deleteMany({
        where: { projectId: input.projectId, path: f.path },
      });
      continue;
    }
    if (f.content !== undefined) {
      await writeFileToRepo({
        projectId: input.projectId,
        path: f.path,
        content: f.content,
        language: f.language,
        taskId: input.taskId,
        commitSha: sha,
      });
    }
  }

  const commit = await db.repoCommit.create({
    data: {
      projectId: input.projectId,
      sha,
      branchName: input.branchName,
      parentSha: parent?.sha ?? null,
      message: input.message,
      authorName: input.authorName ?? "forge-bot",
      authorEmail: "forge@local",
      filesChangedJson: JSON.stringify(input.files.map((f) => ({ path: f.path, action: f.action }))),
      taskId: input.taskId,
    },
  });

  await db.repoBranch.update({
    where: { projectId_name: { projectId: input.projectId, name: input.branchName } },
    data: { headSha: sha },
  });

  return { commit, sha };
}

export async function listCommits(projectId: string, branchName?: string, limit = 50) {
  return db.repoCommit.findMany({
    where: { projectId, ...(branchName ? { branchName } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// ---------------------------------------------------------------------------
// Pull request operations
// ---------------------------------------------------------------------------

export async function createPullRequest(input: {
  projectId: string;
  title: string;
  branchName: string;
  baseBranch?: string;
  body?: string;
  taskId?: string;
}): Promise<PullRequest> {
  const last = await db.pullRequest.findFirst({
    where: { projectId: input.projectId },
    orderBy: { number: "desc" },
  });
  const number = (last?.number ?? 0) + 1;
  const commits = await db.repoCommit.findMany({
    where: { projectId: input.projectId, branchName: input.branchName },
    orderBy: { createdAt: "asc" },
  });
  const files = await db.repoFile.findMany({
    where: { projectId: input.projectId, createdInCommit: { in: commits.map((c) => c.sha) } },
  });
  return db.pullRequest.create({
    data: {
      projectId: input.projectId,
      number,
      title: input.title,
      branchName: input.branchName,
      baseBranch: input.baseBranch ?? "main",
      body: input.body,
      taskId: input.taskId,
      commitsJson: JSON.stringify(commits.map((c) => c.sha)),
      filesJson: JSON.stringify(files.map((f) => f.path)),
    },
  });
}

export async function mergePullRequest(projectId: string, number: number) {
  const pr = await db.pullRequest.findUnique({
    where: { projectId_number: { projectId, number } },
  });
  if (!pr) throw new Error("PR not found");
  // Copy files from branch into main (simulated merge).
  const branchCommits = await db.repoCommit.findMany({
    where: { projectId, branchName: pr.branchName },
    orderBy: { createdAt: "asc" },
  });
  const fileShas = new Set<string>();
  for (const c of branchCommits) {
    const changed = JSON.parse(c.filesChangedJson || "[]") as { path: string }[];
    changed.forEach((f) => fileShas.add(f.path));
  }
  // mark merged
  return db.pullRequest.update({
    where: { id: pr.id },
    data: { state: "MERGED", mergedAt: new Date() },
  });
}

export async function listPullRequests(projectId: string) {
  return db.pullRequest.findMany({
    where: { projectId },
    orderBy: { number: "desc" },
  });
}

// ---------------------------------------------------------------------------
// Repo initialization
// ---------------------------------------------------------------------------

export async function initRepository(projectId: string, repoName: string) {
  await ensureBranch(projectId, "main");
  // Seed a README + .gitignore so the repo is not empty.
  await createCommit({
    projectId,
    branchName: "main",
    message: "chore: initialize repository",
    files: [
      {
        path: "README.md",
        action: "create",
        language: "markdown",
        content: `# ${repoName}\n\nGenerated by Forge — autonomous multi-agent software factory.\n`,
      },
      {
        path: ".gitignore",
        action: "create",
        language: "text",
        content: `node_modules/\n.env\n.env.local\ndist/\nbuild/\n*.log\n.DS_Store\n`,
      },
    ],
    authorName: "forge-bot",
  });
}
