// Forge — Real Git/Worktree Engine (Phase 2 P0-1).
//
// Replaces the DB-backed repository simulation (`repo.ts`) with REAL git
// operations against the local filesystem. Each project gets a real local
// repository (cloned from GitHub or initialised locally) under
// `/tmp/forge-repos/{projectId}/`. Task branches are materialised as real git
// worktrees under `/tmp/forge-repos/{projectId}/worktrees/{branchName}/`.
//
// All git operations run via `child_process.execFile` (asynchronously) against
// the system `git` binary at `/usr/bin/git` (v2.47.3+).
//
// SERVER-SIDE ONLY. This module imports `node:child_process`, `node:fs`,
// `node:path`, `node:util` — none of which are usable in the browser. Import
// this module only from API routes, server actions, the orchestrator, or other
// server-only lib files.

import { execFile as execFileCb } from "node:child_process";
import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIT_BIN = process.env.GIT_BIN || "/usr/bin/git";

/** Root directory for all Forge-managed repositories. Ephemeral. */
const FORGE_REPOS_DIR = process.env.FORGE_REPOS_DIR || "/tmp/forge-repos";

/** Default commit author identity (used when not configured globally). */
const DEFAULT_AUTHOR_NAME = "Forge Bot";
const DEFAULT_AUTHOR_EMAIL = "forge-bot@local";

/** execFile buffer cap: 10MB per command (large diffs). */
const MAX_BUFFER = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Error type — structured, named, never an unhandled exception.
// ---------------------------------------------------------------------------

export class GitEngineError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(opts: {
    message: string;
    command?: string;
    args?: string[];
    cwd?: string;
    exitCode?: number | null;
    stderr?: string;
  }) {
    super(opts.message);
    this.name = "GitEngineError";
    this.command = opts.command ?? "git";
    this.args = opts.args ?? [];
    this.cwd = opts.cwd ?? "";
    this.exitCode = opts.exitCode ?? null;
    this.stderr = opts.stderr ?? "";
  }
}

// ---------------------------------------------------------------------------
// Low-level git runner
// ---------------------------------------------------------------------------

const execFile = promisify(execFileCb);

interface GitRunOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Suppress non-zero-exit throws and return the raw result instead. */
  allowFailure?: boolean;
}

/**
 * Run a git command and return {stdout, stderr}. Throws `GitEngineError` on
 * non-zero exit unless `allowFailure` is set.
 *
 * Critical env hardening:
 *   - `GIT_TERMINAL_PROMPT=0`  — never block on interactive prompts (would
 *     hang the orchestrator on a missing-credential prompt).
 *   - `GIT_ASKPASS=/bin/true`  — refuse credential prompts entirely.
 *   - `GCM_INTERACTIVE=never`  — Git Credential Manager: never interactive.
 */
async function git(
  args: string[],
  opts: GitRunOptions,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: Record<string, string> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
    GCM_INTERACTIVE: "never",
    ...(opts.env ?? {}),
  };

  try {
    const { stdout, stderr } = await execFile(GIT_BIN, args, {
      cwd: opts.cwd,
      env,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return { stdout, stderr, code: 0 };
  } catch (err: unknown) {
    // execFile rejects on non-zero exit with an object that carries stdout,
    // stderr, code, signal. Re-shape into a structured error.
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      signal?: string;
      message?: string;
    };
    const stdout = e.stdout ?? "";
    const stderr = e.stderr ?? "";
    const code = typeof e.code === "number" ? e.code : null;

    if (opts.allowFailure) {
      return { stdout, stderr, code };
    }

    throw new GitEngineError({
      message: `git ${args.join(" ")} failed${code !== null ? ` (exit ${code})` : ""}: ${truncateForLog(e.message ?? stderr)}`,
      command: GIT_BIN,
      args,
      cwd: opts.cwd,
      exitCode: code,
      stderr: truncateForLog(stderr, 4000),
    });
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Canonical repository directory for a project. */
export function getRepoPath(projectId: string): string {
  return path.join(FORGE_REPOS_DIR, projectId);
}

/** Canonical worktree directory for a task branch. */
export function getWorktreePath(projectId: string, branchName: string): string {
  return path.join(getRepoPath(projectId), "worktrees", sanitizeBranchSlug(branchName));
}

/** Convert a branch name into a filesystem-safe slug for the worktree dir. */
function sanitizeBranchSlug(branchName: string): string {
  // Replace path separators and other unsafe chars with '-'.
  return branchName.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * Inject the GitHub PAT into a clone URL. Accepts either
 * `https://github.com/owner/repo(.git)` or
 * `git@github.com:owner/repo(.git)` style URLs.
 *
 * Returns `https://x-access-token:{PAT}@github.com/owner/repo.git`.
 * NEVER logs the PAT.
 */
function injectPat(githubUrl: string): string {
  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    throw new GitEngineError({
      message:
        "GITHUB_PAT environment variable is not set; cannot authenticate to GitHub. Set GITHUB_PAT to clone private repositories.",
    });
  }

  // Strip trailing .git for normalisation.
  let url = githubUrl.trim();
  if (url.endsWith(".git")) url = url.slice(0, -4);

  // SSH form: git@github.com:owner/repo
  const sshMatch = url.match(/^git@github\.com:(.+)$/);
  if (sshMatch) {
    const repoPath = sshMatch[1];
    return `https://x-access-token:${pat}@github.com/${repoPath}.git`;
  }

  // HTTPS form: https://github.com/owner/repo
  const httpsMatch = url.match(/^https?:\/\/github\.com\/(.+)$/);
  if (httpsMatch) {
    const repoPath = httpsMatch[1];
    return `https://x-access-token:${pat}@github.com/${repoPath}.git`;
  }

  // Already includes credentials? Pass through (still never log).
  if (url.includes("@")) return url.endsWith(".git") ? url : `${url}.git`;

  throw new GitEngineError({
    message: `Unrecognised GitHub URL format: ${redactUrl(githubUrl)}`,
  });
}

/** Redact any embedded credentials from a URL for safe logging. */
function redactUrl(url: string): string {
  return url.replace(/(https?:\/\/)[^@]+@/g, "$1***@");
}

function truncateForLog(s: string, max = 2000): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…<truncated ${trimmed.length - max} chars>`;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Repository lifecycle
// ---------------------------------------------------------------------------

/**
 * Clone a GitHub repository to `/tmp/forge-repos/{projectId}/`. Idempotent:
 * if the path already exists and looks like a git repo, returns it without
 * re-cloning. Uses GITHUB_PAT for auth (injected into the URL, never logged).
 */
export async function cloneRepo(projectId: string, githubUrl: string): Promise<string> {
  const repoPath = getRepoPath(projectId);
  await ensureDir(path.dirname(repoPath));

  // Idempotency: if the repo dir exists and has a .git dir, skip the clone.
  if (await pathExists(path.join(repoPath, ".git"))) {
    return repoPath;
  }
  // If a stale dir exists but isn't a git repo, remove it.
  if (await pathExists(repoPath)) {
    await rm(repoPath, { recursive: true, force: true });
  }

  const authedUrl = injectPat(githubUrl);

  // Clone with --origin=origin (default). Don't log the authed URL.
  await git(["clone", "--origin", "origin", "--", authedUrl, repoPath], {
    cwd: path.dirname(repoPath),
  });

  // Set per-repo author config so commits don't depend on global git config.
  await git(["config", "user.name", DEFAULT_AUTHOR_NAME], { cwd: repoPath });
  await git(["config", "user.email", DEFAULT_AUTHOR_EMAIL], { cwd: repoPath });

  return repoPath;
}

/**
 * Initialise a new local repository (no GitHub). Creates a `main` branch with
 * an initial commit (README + .gitignore). Returns the repo path.
 */
export async function initRepo(projectId: string, name: string): Promise<string> {
  const repoPath = getRepoPath(projectId);
  await ensureDir(path.dirname(repoPath));

  if (await pathExists(path.join(repoPath, ".git"))) {
    return repoPath;
  }
  if (await pathExists(repoPath)) {
    await rm(repoPath, { recursive: true, force: true });
  }

  await ensureDir(repoPath);

  // `git init -b main` requires git >= 2.28. We have 2.47, so this is safe.
  await git(["init", "--initial-branch=main", repoPath], {
    cwd: path.dirname(repoPath),
  });

  // Per-repo author config.
  await git(["config", "user.name", DEFAULT_AUTHOR_NAME], { cwd: repoPath });
  await git(["config", "user.email", DEFAULT_AUTHOR_EMAIL], { cwd: repoPath });

  // Seed README + .gitignore so HEAD is non-empty.
  await writeFile(
    path.join(repoPath, "README.md"),
    `# ${name}\n\nGenerated by Forge — autonomous multi-agent software factory.\n`,
    "utf8",
  );
  await writeFile(
    path.join(repoPath, ".gitignore"),
    "node_modules/\n.env\n.env.local\ndist/\nbuild/\n*.log\n.DS_Store\n",
    "utf8",
  );

  await git(["add", "-A"], { cwd: repoPath });
  await git(
    ["commit", "-m", "chore: initialize repository", "--author", `${DEFAULT_AUTHOR_NAME} <${DEFAULT_AUTHOR_EMAIL}>`],
    { cwd: repoPath },
  );

  return repoPath;
}

// ---------------------------------------------------------------------------
// Worktree management
// ---------------------------------------------------------------------------

/**
 * Create a git worktree for a task branch at
 * `/tmp/forge-repos/{projectId}/worktrees/{branchName}/`. Returns the
 * worktree path.
 *
 * - If the worktree already exists (path is a valid worktree), returns it
 *   idempotently (so retry-safe).
 * - If the branch already exists (e.g. from a previous attempt), the worktree
 *   is checked out from the existing branch tip.
 * - If the branch does not exist, it's created from `baseBranch` (default
 *   `main`) and the worktree checks it out.
 */
export async function createWorktree(
  projectId: string,
  branchName: string,
  baseBranch?: string,
): Promise<string> {
  const repoPath = getRepoPath(projectId);
  const wtPath = getWorktreePath(projectId, branchName);

  if (!(await pathExists(path.join(repoPath, ".git")))) {
    throw new GitEngineError({
      message: `Cannot create worktree: repository at ${repoPath} does not exist. Call cloneRepo() or initRepo() first.`,
      cwd: repoPath,
    });
  }

  // Idempotency: if the worktree path is already a real worktree, return it.
  if (await pathExists(path.join(wtPath, ".git"))) {
    return wtPath;
  }
  // Stale non-worktree dir? Remove so worktree add can succeed.
  if (await pathExists(wtPath)) {
    await rm(wtPath, { recursive: true, force: true });
  }
  await ensureDir(path.dirname(wtPath));

  // Does the branch already exist (local or remote-tracking)?
  const branchCheck = await git(
    ["rev-parse", "--verify", "--quiet", branchName],
    { cwd: repoPath, allowFailure: true },
  );
  const branchExists = branchCheck.code === 0;

  if (branchExists) {
    // Check out the existing branch into the worktree.
    await git(["worktree", "add", "--force", wtPath, branchName], { cwd: repoPath });
  } else {
    // Create a new branch from the base branch and check it out.
    const base = baseBranch ?? "main";
    // Verify the base branch exists.
    const baseCheck = await git(["rev-parse", "--verify", "--quiet", base], {
      cwd: repoPath,
      allowFailure: true,
    });
    if (baseCheck.code !== 0) {
      throw new GitEngineError({
        message: `Cannot create worktree for branch '${branchName}': base branch '${base}' does not exist in repository ${repoPath}.`,
        cwd: repoPath,
      });
    }
    await git(["worktree", "add", "--force", "-b", branchName, wtPath, base], {
      cwd: repoPath,
    });
  }

  // Set per-worktree author config (worktrees share the main repo's config
  // but we set it explicitly for safety against missing global config).
  await git(["config", "user.name", DEFAULT_AUTHOR_NAME], { cwd: wtPath });
  await git(["config", "user.email", DEFAULT_AUTHOR_EMAIL], { cwd: wtPath });

  return wtPath;
}

/**
 * Remove a worktree and prune. The branch is left intact so its commits are
 * not lost (the orchestrator can delete the branch explicitly if desired).
 */
export async function removeWorktree(projectId: string, branchName: string): Promise<void> {
  const repoPath = getRepoPath(projectId);
  const wtPath = getWorktreePath(projectId, branchName);

  if (!(await pathExists(repoPath))) return;

  // `git worktree remove --force` is safe: it cleans up the worktree's
  // administrative files. If the worktree is already gone, prune.
  await git(
    ["worktree", "remove", "--force", wtPath],
    { cwd: repoPath, allowFailure: true },
  );
  await git(["worktree", "prune"], { cwd: repoPath, allowFailure: true });

  // Belt-and-braces: ensure the dir is gone from disk.
  if (await pathExists(wtPath)) {
    await rm(wtPath, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// File operations inside a worktree (real filesystem)
// ---------------------------------------------------------------------------

/**
 * Resolve `filePath` against `worktreePath` and verify the resolved path is
 * still inside the worktree (defence against path-traversal).
 */
function resolveInWorktree(worktreePath: string, filePath: string): string {
  const resolved = path.resolve(worktreePath, filePath);
  const normalizedWt = path.resolve(worktreePath);
  if (resolved !== normalizedWt && !resolved.startsWith(normalizedWt + path.sep)) {
    throw new GitEngineError({
      message: `Refusing to write/read outside worktree: '${filePath}' resolves to '${resolved}' (worktree root: ${normalizedWt}).`,
      cwd: normalizedWt,
    });
  }
  return resolved;
}

/** Write a file to a worktree (real filesystem write). Creates parent dirs. */
export async function writeToFile(
  worktreePath: string,
  filePath: string,
  content: string,
): Promise<void> {
  const abs = resolveInWorktree(worktreePath, filePath);
  await ensureDir(path.dirname(abs));
  await writeFile(abs, content, "utf8");
}

/** Read a file from a worktree. Returns null if the file does not exist. */
export async function readFromFile(
  worktreePath: string,
  filePath: string,
): Promise<string | null> {
  const abs = resolveInWorktree(worktreePath, filePath);
  try {
    return await readFile(abs, "utf8");
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * List all tracked files in a worktree. Respects `.gitignore` (uses
 * `git ls-files`).
 */
export async function listFiles(worktreePath: string): Promise<string[]> {
  const { stdout } = await git(["ls-files"], { cwd: worktreePath });
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Commit operations
// ---------------------------------------------------------------------------

/**
 * Stage all changes (`git add -A`) and commit them. Returns the new commit
 * SHA. If there are no changes to commit, returns the current HEAD SHA
 * without creating an empty commit.
 */
export async function commitAll(
  worktreePath: string,
  message: string,
  authorName?: string,
  authorEmail?: string,
): Promise<string> {
  const name = authorName ?? DEFAULT_AUTHOR_NAME;
  const email = authorEmail ?? DEFAULT_AUTHOR_EMAIL;

  // Stage everything.
  await git(["add", "-A"], { cwd: worktreePath });

  // Are there staged changes? `git diff --cached --quiet` exits 0 if clean,
  // non-zero if there are staged changes.
  const diffCheck = await git(["diff", "--cached", "--quiet"], {
    cwd: worktreePath,
    allowFailure: true,
  });
  const hasStagedChanges = diffCheck.code !== 0;

  if (hasStagedChanges) {
    await git(
      ["commit", "-m", message, "--author", `${name} <${email}>`],
      { cwd: worktreePath },
    );
  }
  // Else: no changes to commit — return current HEAD.

  return getHeadSha(worktreePath);
}

/**
 * Get the diff between two refs. Defaults to `git diff main HEAD` (the task
 * branch's accumulated changes against main).
 */
export async function getDiff(
  worktreePath: string,
  base?: string,
  head?: string,
): Promise<string> {
  const args = ["diff"];
  if (base && head) {
    args.push(base, head);
  } else if (base) {
    args.push(base);
  } else {
    // Default: main..HEAD (or HEAD vs working tree if main is unavailable).
    // Try `git diff main HEAD` first; fall back to `git diff HEAD` if main
    // doesn't exist (e.g. brand-new repo with only main checked out).
    const mainCheck = await git(["rev-parse", "--verify", "--quiet", "main"], {
      cwd: worktreePath,
      allowFailure: true,
    });
    if (mainCheck.code === 0) {
      args.push("main", "HEAD");
    } else {
      args.push("HEAD");
    }
  }
  const { stdout } = await git(args, { cwd: worktreePath });
  return stdout;
}

/** Get the list of files changed in a given commit SHA. */
export async function getChangedFiles(
  worktreePath: string,
  sha: string,
): Promise<string[]> {
  const { stdout } = await git(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
    { cwd: worktreePath },
  );
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Push a branch to the GitHub remote (`origin`). Returns a structured result
 * rather than throwing — a failed push (auth error, network error, non-fast-
 * forward) must not crash the orchestrator. The orchestrator records the
 * error as evidence.
 */
export async function pushBranch(
  worktreePath: string,
  branchName: string,
): Promise<{ ok: boolean; error?: string; stderr?: string; exitCode: number | null }> {
  // First verify a remote named `origin` is configured.
  const remoteCheck = await git(["remote", "get-url", "origin"], {
    cwd: worktreePath,
    allowFailure: true,
  });
  if (remoteCheck.code !== 0) {
    return {
      ok: false,
      error: "No 'origin' remote configured on this repository. Cannot push.",
      stderr: remoteCheck.stderr,
      exitCode: remoteCheck.code,
    };
  }

  const result = await git(["push", "-u", "origin", branchName], {
    cwd: worktreePath,
    allowFailure: true,
    // Re-inject the PAT into the env in case the remote URL stored in the
    // repo config doesn't have it (we clone with a PAT-injected URL, so this
    // is normally redundant, but belt-and-braces for repos initialised
    // locally and later connected to a remote).
    env: process.env.GITHUB_PAT
      ? { GIT_ASKPASS: "/bin/true", GIT_TERMINAL_PROMPT: "0" }
      : undefined,
  });

  if (result.code === 0) {
    return { ok: true, exitCode: 0 };
  }

  // Sanitise stderr: strip any embedded tokens (defensive — should never
  // happen since we use URL-embedded auth, but git error messages can
  // sometimes echo the remote URL).
  const safeStderr = redactUrl(result.stderr);
  return {
    ok: false,
    exitCode: result.code,
    stderr: safeStderr,
    error: `git push origin ${branchName} failed (exit ${result.code}): ${truncateForLog(safeStderr)}`,
  };
}

// ---------------------------------------------------------------------------
// Read-only queries
// ---------------------------------------------------------------------------

/** Get the current HEAD SHA of a worktree (or any git dir). */
export async function getHeadSha(worktreePath: string): Promise<string> {
  const { stdout } = await git(["rev-parse", "HEAD"], { cwd: worktreePath });
  return stdout.trim();
}

/**
 * List all local branches. Returns branch names with the leading `*`
 * (current branch marker) stripped.
 */
export async function listBranches(worktreePath: string): Promise<string[]> {
  const { stdout } = await git(["branch", "--list"], { cwd: worktreePath });
  return stdout
    .split("\n")
    .map((l) => l.replace(/^\* /, "  ").trim())
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Directory bootstrap — ensure /tmp/forge-repos exists.
// ---------------------------------------------------------------------------

/** Ensure the forge-repos root directory exists. Called lazily by the
 *  orchestrator before cloneRepo/initRepo, but those also call ensureDir on
 *  their parent, so this is mostly for explicit bootstrapping. */
export async function ensureForgeReposRoot(): Promise<void> {
  await ensureDir(FORGE_REPOS_DIR);
}

// Re-export the existence check for use by the orchestrator and API routes
// (e.g. to render a "worktree exists" badge without creating it).
export { pathExists as worktreeExists };

// Marker so server-only bundlers know this module must not be inlined into
// the client bundle. The actual enforcement is the `node:` imports above;
// this is a defensive comment for tooling.
export const SERVER_ONLY = true as const;
