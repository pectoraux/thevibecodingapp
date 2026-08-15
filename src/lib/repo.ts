// Forge — Repository Metadata Adapter (READ-ONLY).
//
// CANONICAL REPOSITORY INVARIANT (Phase 16D-RECONCILE):
// The ONE canonical source of project code is REAL GIT / GITHUB, operated by
// the execution worker (mini-services/execution-worker/git/repository.ts) and
// the real GitHub merge endpoint (src/app/api/projects/[id]/tasks/[taskId]/merge).
//
// This module is a STRICTLY READ-ONLY presentation/evidence layer. It exposes
// NO mutation operations. It must not:
//   - create branches / commits / files / pull requests
//   - simulate repository state
//   - advance any HEAD
//
// The RepoBranch / RepoCommit / RepoFile / PullRequest Prisma models may hold
// historical metadata/evidence for UI display, but they are NEVER written to by
// active production code. The static invariant test
// (tests/repository-source-invariants.ts) mechanically proves this.
//
// Allowed exports here: listFiles, getFile, listCommits, listPullRequests.
// Forbidden: ensureBranch, writeFileToRepo, createCommit, createPullRequest,
//            mergePullRequest, initRepository, scanSuspiciousPatterns.

import { db } from "@/lib/db";
import type { RepoFile } from "@prisma/client";

// ---------------------------------------------------------------------------
// File reads
// ---------------------------------------------------------------------------

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
// Commit reads
// ---------------------------------------------------------------------------

export async function listCommits(projectId: string, branchName?: string, limit = 50) {
  return db.repoCommit.findMany({
    where: { projectId, ...(branchName ? { branchName } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// ---------------------------------------------------------------------------
// Pull request reads
// ---------------------------------------------------------------------------

export async function listPullRequests(projectId: string) {
  return db.pullRequest.findMany({
    where: { projectId },
    orderBy: { number: "desc" },
  });
}
