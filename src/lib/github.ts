// Forge — Real GitHub Adapter (Phase 2 P0-6).
//
// Wraps the GitHub REST API (v3) at https://api.github.com. Every function in
// this module makes a REAL HTTP request — there is no simulation, no mock, no
// cache (except the PAT, which is read once from process.env.GITHUB_PAT and
// memoised for the lifetime of the process).
//
// Clone / push operations are NOT in this module — those are delegated to the
// real git engine in `src/lib/git-engine.ts` (which shells out to the system
// `git` binary). This module provides the `getCloneUrl()` helper that the git
// engine consumes to inject the PAT into the clone URL.
//
// SERVER-SIDE ONLY. The PAT is read from process.env and must NEVER be exposed
// to the client. Do not import this module from a client component or a server
// action that runs in the edge runtime. The presence of `fetch` and
// `process.env` access is intentional and enforced by the `"use server"`-adjacent
// convention used throughout `src/lib`.
//
// Error model
// -----------
//   401 → GitHubAuthError         (bad/expired PAT)
//   403 → GitHubForbiddenError    (rate limit or insufficient scope)
//   404 → null (for get* with nullOn404) or GitHubNotFoundError
//   422 → GitHubValidationError   (e.g. repo already exists, invalid ref)
//   5xx / other → GitHubError     (generic, retriable by caller)
//   network failure → GitHubError (status = 0)
//
// Every error carries: HTTP status, method, API path, and the (truncated)
// response body for debugging.

// ---------------------------------------------------------------------------
// Types — public, returned to callers
// ---------------------------------------------------------------------------

export interface GitHubRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
}

export interface GitHubBranch {
  name: string;
  commit: { sha: string; url: string };
  protected: boolean;
}

export interface GitHubCommit {
  sha: string;
  message: string;
  author: { name: string; email: string; date: string };
  parents: { sha: string }[];
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  htmlUrl: string;
  body: string | null;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export interface GitHubErrorOptions {
  message: string;
  status: number;
  path: string;
  body: string;
  method?: string;
}

/** Base class for every GitHub adapter error. */
export class GitHubError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;
  readonly method: string;

  constructor(opts: GitHubErrorOptions) {
    super(opts.message);
    this.name = "GitHubError";
    this.status = opts.status;
    this.path = opts.path;
    this.body = opts.body;
    this.method = opts.method ?? "GET";
  }
}

/** 401 — bad/expired PAT, or no PAT configured. */
export class GitHubAuthError extends GitHubError {
  constructor(opts: GitHubErrorOptions) {
    super({
      ...opts,
      message: opts.message || `GitHub auth failed (401) for ${opts.method ?? "GET"} ${opts.path}`,
    });
    this.name = "GitHubAuthError";
  }
}

/** 403 — rate limit exhausted or PAT lacks the required scope. */
export class GitHubForbiddenError extends GitHubError {
  constructor(opts: GitHubErrorOptions) {
    super({
      ...opts,
      message:
        opts.message || `GitHub forbidden (403) for ${opts.method ?? "GET"} ${opts.path}`,
    });
    this.name = "GitHubForbiddenError";
  }
}

/** 404 — resource does not exist. */
export class GitHubNotFoundError extends GitHubError {
  constructor(opts: GitHubErrorOptions) {
    super({
      ...opts,
      message:
        opts.message ||
        `GitHub resource not found (404) for ${opts.method ?? "GET"} ${opts.path}`,
    });
    this.name = "GitHubNotFoundError";
  }
}

/** 422 — validation failure (e.g. repo already exists, branch ref invalid). */
export class GitHubValidationError extends GitHubError {
  constructor(opts: GitHubErrorOptions) {
    super({
      ...opts,
      message:
        opts.message ||
        `GitHub validation failed (422) for ${opts.method ?? "GET"} ${opts.path}`,
    });
    this.name = "GitHubValidationError";
  }
}

// ---------------------------------------------------------------------------
// Config — PAT memoisation (the ONLY thing we cache)
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "Forge-Bot";
const RATE_LIMIT_WARN_THRESHOLD = 10;
const ERROR_BODY_MAX = 4096;

// `undefined` = not-yet-read; `null` = env var was empty/missing; string = PAT.
let cachedPat: string | null | undefined;

/**
 * Return the GitHub PAT, reading it from process.env exactly once and caching
 * the result. Throws GitHubError (status = 0) if the PAT is not configured —
 * callers should treat this as a programmer/ops error, not a runtime API error.
 *
 * The PAT is NEVER logged. Any function that needs to embed it (e.g.
 * `getCloneUrl`) constructs the string locally and the git engine redacts it
 * from any log output.
 */
function getPat(): string {
  if (cachedPat === undefined) {
    cachedPat = process.env.GITHUB_PAT ?? null;
  }
  if (!cachedPat) {
    throw new GitHubError({
      message:
        "GITHUB_PAT environment variable is not set. The GitHub adapter cannot authenticate. Set GITHUB_PAT to a valid personal access token with repo, workflow, and (for deleteRepository) delete_repo scopes.",
      status: 0,
      path: "",
      body: "",
      method: "CONFIG",
    });
  }
  return cachedPat;
}

// ---------------------------------------------------------------------------
// Internal request helper
// ---------------------------------------------------------------------------

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  method: HttpMethod;
  /** API path beginning with `/`, e.g. `/repos/owner/name`. */
  path: string;
  /** Optional query-string parameters. `undefined` values are skipped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON-serialisable request body. Omit for GET/DELETE. */
  body?: unknown;
  /**
   * If true, a 404 response resolves to `null` instead of throwing
   * `GitHubNotFoundError`. Use this for "get or null" lookups.
   */
  nullOn404?: boolean;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  if (!query) return GITHUB_API_BASE + path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${GITHUB_API_BASE}${path}?${qs}` : GITHUB_API_BASE + path;
}

/** Truncate a response body for safe inclusion in an error message. */
function truncateBody(body: string, max = ERROR_BODY_MAX): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}…<truncated ${body.length - max} chars>`;
}

/** Pull a human-readable message out of a GitHub error response body. */
function extractErrorMessage(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as {
      message?: string;
      error?: string;
      errors?: Array<{ message?: string; code?: string }>;
    };
    if (parsed.message) return parsed.message;
    if (parsed.error) return parsed.error;
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const first = parsed.errors[0];
      if (first?.message) return first.message;
    }
  } catch {
    // Body isn't JSON — return as-is (truncated by caller).
    return body;
  }
  return "";
}

/** Log rate-limit headers from every GitHub response. Warns when low. */
function logRateLimit(res: Response, path: string): void {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const limit = res.headers.get("x-ratelimit-limit");
  const reset = res.headers.get("x-ratelimit-reset");
  if (remaining === null) return; // No rate-limit headers on this endpoint.

  const remainingNum = Number(remaining);
  if (Number.isNaN(remainingNum)) return;

  const resetDate = reset
    ? new Date(Number(reset) * 1000).toISOString()
    : "unknown";

  // eslint-disable-next-line no-console
  console.log(
    `[forge-github] rate limit: ${remainingNum}/${limit ?? "?"} remaining (resets ${resetDate}) — ${res.status} ${path}`,
  );

  if (remainingNum < RATE_LIMIT_WARN_THRESHOLD) {
    // eslint-disable-next-line no-console
    console.warn(
      `[forge-github] WARNING: rate limit nearly exhausted (${remainingNum}/${limit ?? "?"} remaining; resets ${resetDate}).`,
    );
  }
}

/**
 * Core request function. Returns the parsed JSON body on success, or `null` if
 * `nullOn404` is set and the resource was not found. Throws a typed
 * `GitHubError` subclass on any other non-OK response.
 */
async function request<T>(opts: RequestOptions): Promise<T | null> {
  const pat = getPat();
  const url = buildUrl(opts.path, opts.query);

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers: {
        Authorization: `token ${pat}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      // GitHub rarely redirects, but follow when it does (e.g. API renames).
      redirect: "follow",
      // Default Next.js fetch caching is `no-store` for POST/PUT/DELETE; for
      // GET we want fresh data too (branch lists, PR states, check runs).
      cache: "no-store",
    });
  } catch (err: unknown) {
    // Network failure (DNS, connection refused, TLS error). Wrap so callers
    // always get a structured GitHubError rather than a raw TypeError.
    const e = err as { message?: string };
    throw new GitHubError({
      message: `Network error calling GitHub API ${opts.method} ${opts.path}: ${e?.message ?? "unknown error"}`,
      status: 0,
      path: opts.path,
      body: "",
      method: opts.method,
    });
  }

  logRateLimit(res, opts.path);

  // Read body once. 204 No Content has an empty body.
  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON body (rare). Leave json as null; callers expecting an object
      // will hit the defensive null checks below.
      json = null;
    }
  }

  if (res.ok) {
    return json as T;
  }

  // Non-OK: build a structured error.
  const bodySnippet = truncateBody(text);
  const apiMessage = extractErrorMessage(text);
  const errBase: GitHubErrorOptions = {
    message:
      apiMessage ||
      `GitHub API returned ${res.status} for ${opts.method} ${opts.path}`,
    status: res.status,
    path: opts.path,
    body: bodySnippet,
    method: opts.method,
  };

  if (res.status === 401) throw new GitHubAuthError(errBase);
  if (res.status === 403) throw new GitHubForbiddenError(errBase);
  if (res.status === 404) {
    if (opts.nullOn404) return null;
    throw new GitHubNotFoundError(errBase);
  }
  if (res.status === 422) throw new GitHubValidationError(errBase);

  // 5xx or any other status — generic GitHubError (caller may retry on 5xx).
  throw new GitHubError(errBase);
}

// ---------------------------------------------------------------------------
// Response shape interfaces (GitHub API snake_case) + mappers to our types
// ---------------------------------------------------------------------------

interface ApiRepoResponse {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  clone_url: string;
  html_url: string;
  default_branch: string;
  private: boolean;
}

interface ApiBranchResponse {
  name: string;
  commit: { sha: string; url: string };
  protected: boolean;
}

interface ApiRefResponse {
  ref: string; // "refs/heads/<branch>"
  node_id?: string;
  url: string;
  object: { sha: string; type: string; url: string };
}

interface ApiCommitResponse {
  sha: string;
  node_id?: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
  };
  parents: { sha: string; url?: string }[];
}

interface ApiPullRequestResponse {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  html_url: string;
  body: string | null;
}

interface ApiCheckRunsResponse {
  total_count: number;
  check_runs: Array<{
    id: number;
    name: string;
    status: string; // GitHub may add new states; validate before trusting.
    conclusion: string | null;
    started_at: string | null;
    completed_at: string | null;
    html_url: string;
  }>;
}

function mapRepo(r: ApiRepoResponse): GitHubRepo {
  return {
    id: r.id,
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    htmlUrl: r.html_url,
    defaultBranch: r.default_branch,
    private: r.private,
  };
}

function mapBranch(b: ApiBranchResponse): GitHubBranch {
  return {
    name: b.name,
    commit: { sha: b.commit.sha, url: b.commit.url },
    protected: b.protected,
  };
}

function mapBranchFromRef(r: ApiRefResponse): GitHubBranch {
  const name = r.ref.startsWith("refs/heads/")
    ? r.ref.slice("refs/heads/".length)
    : r.ref;
  return {
    name,
    commit: { sha: r.object.sha, url: r.object.url },
    protected: false, // The refs API does not return protection state.
  };
}

function mapCommit(c: ApiCommitResponse): GitHubCommit {
  return {
    sha: c.sha,
    message: c.commit.message,
    author: c.commit.author,
    parents: c.parents.map((p) => ({ sha: p.sha })),
  };
}

function mapPullRequest(pr: ApiPullRequestResponse): GitHubPullRequest {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: pr.merged,
    head: { ref: pr.head.ref, sha: pr.head.sha },
    base: { ref: pr.base.ref, sha: pr.base.sha },
    htmlUrl: pr.html_url,
    body: pr.body,
  };
}

const VALID_CHECK_STATUSES = new Set(["queued", "in_progress", "completed"]);
const VALID_CHECK_CONCLUSIONS = new Set([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "timed_out",
  "action_required",
]);

function mapCheckRun(cr: ApiCheckRunsResponse["check_runs"][number]): GitHubCheckRun {
  const status = VALID_CHECK_STATUSES.has(cr.status)
    ? (cr.status as GitHubCheckRun["status"])
    : "queued";
  const conclusion =
    cr.conclusion && VALID_CHECK_CONCLUSIONS.has(cr.conclusion)
      ? (cr.conclusion as GitHubCheckRun["conclusion"])
      : null;
  return {
    id: cr.id,
    name: cr.name,
    status,
    conclusion,
    startedAt: cr.started_at,
    completedAt: cr.completed_at,
    htmlUrl: cr.html_url,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the authenticated user (the owner of the PAT). Verifies that the PAT is
 * valid and reveals which account Forge will act as.
 */
export async function getAuthenticatedUser(): Promise<{
  login: string;
  id: number;
  name: string;
}> {
  const user = await request<{ login: string; id: number; name: string | null }>({
    method: "GET",
    path: "/user",
  });
  if (!user) {
    // 200 with empty body should never happen for /user.
    throw new GitHubError({
      message: "GitHub GET /user returned an empty 2xx response.",
      status: 200,
      path: "/user",
      body: "",
      method: "GET",
    });
  }
  return { login: user.login, id: user.id, name: user.name ?? user.login };
}

/**
 * Create a new repository owned by the authenticated user.
 *
 * `auto_init: true` is set so the repo has an initial commit on its default
 * branch — without this, the repo is empty and branch/commit operations would
 * fail (no SHA to branch from).
 *
 * On 422 (repo already exists, name invalid, etc.) throws
 * `GitHubValidationError`.
 */
export async function createRepository(
  name: string,
  description?: string,
  isPrivate?: boolean,
): Promise<GitHubRepo> {
  const repo = await request<ApiRepoResponse>({
    method: "POST",
    path: "/user/repos",
    body: {
      name,
      description: description ?? "",
      private: isPrivate ?? false,
      auto_init: true,
    },
  });
  if (!repo) {
    throw new GitHubError({
      message: "GitHub POST /user/repos returned an empty 2xx response.",
      status: 201,
      path: "/user/repos",
      body: "",
      method: "POST",
    });
  }
  return mapRepo(repo);
}

/**
 * Get an existing repository. Returns `null` if the repo does not exist (404)
 * or the PAT cannot access it.
 */
export async function getRepository(
  owner: string,
  name: string,
): Promise<GitHubRepo | null> {
  const repo = await request<ApiRepoResponse>({
    method: "GET",
    path: `/repos/${owner}/${name}`,
    nullOn404: true,
  });
  return repo ? mapRepo(repo) : null;
}

/**
 * List branches in a repository. Returns up to 100 branches per call
 * (GitHub's max `per_page`). Pagination beyond 100 is the caller's
 * responsibility — most Forge projects have < 100 task branches.
 */
export async function listBranches(
  owner: string,
  name: string,
): Promise<GitHubBranch[]> {
  const branches = await request<ApiBranchResponse[]>({
    method: "GET",
    path: `/repos/${owner}/${name}/branches`,
    query: { per_page: 100 },
  });
  return (branches ?? []).map(mapBranch);
}

/**
 * Create a branch from an existing SHA via the Git Data API (refs endpoint).
 *
 * `fromSha` must be an existing commit SHA in the repo (e.g. the tip of the
 * default branch). The branch is created on the GitHub remote — to materialise
 * it locally, the caller should subsequently `git fetch` or create a worktree
 * pointing at the new branch.
 */
export async function createBranch(
  owner: string,
  name: string,
  branchName: string,
  fromSha: string,
): Promise<GitHubBranch> {
  const ref = await request<ApiRefResponse>({
    method: "POST",
    path: `/repos/${owner}/${name}/git/refs`,
    body: {
      ref: `refs/heads/${branchName}`,
      sha: fromSha,
    },
  });
  if (!ref) {
    throw new GitHubError({
      message: "GitHub POST /git/refs returned an empty 2xx response.",
      status: 201,
      path: `/repos/${owner}/${name}/git/refs`,
      body: "",
      method: "POST",
    });
  }
  return mapBranchFromRef(ref);
}

/**
 * Get a commit by SHA (or by a ref that resolves to a commit, e.g. a branch
 * name or tag). Throws `GitHubNotFoundError` if the commit does not exist.
 */
export async function getCommit(
  owner: string,
  name: string,
  sha: string,
): Promise<GitHubCommit> {
  const commit = await request<ApiCommitResponse>({
    method: "GET",
    path: `/repos/${owner}/${name}/commits/${sha}`,
  });
  if (!commit) {
    throw new GitHubNotFoundError({
      message: `Commit ${sha} not found in ${owner}/${name}.`,
      status: 404,
      path: `/repos/${owner}/${name}/commits/${sha}`,
      body: "",
      method: "GET",
    });
  }
  return mapCommit(commit);
}

/**
 * Create a commit via the Git Data API (commits endpoint). This creates a
 * commit object referencing an existing tree SHA — it does NOT push file
 * changes by itself. Use this when you don't have a local worktree.
 *
 * When you DO have a local worktree, prefer the real git engine:
 *   git-engine.commitAll(worktreePath, message) → git-engine.pushBranch(...)
 *
 * This API path is mainly useful for programmatic commits (e.g. updating a
 * config file via the contents API, then committing the resulting tree).
 */
export async function createCommitViaApi(
  owner: string,
  name: string,
  params: { message: string; tree: string; parents: string[] },
): Promise<GitHubCommit> {
  const commit = await request<ApiCommitResponse>({
    method: "POST",
    path: `/repos/${owner}/${name}/git/commits`,
    body: {
      message: params.message,
      tree: params.tree,
      parents: params.parents,
    },
  });
  if (!commit) {
    throw new GitHubError({
      message: "GitHub POST /git/commits returned an empty 2xx response.",
      status: 201,
      path: `/repos/${owner}/${name}/git/commits`,
      body: "",
      method: "POST",
    });
  }
  return mapCommit(commit);
}

/**
 * Create a pull request. `head` is the source branch, `base` is the target.
 * Both branches must already exist on the GitHub remote.
 *
 * On 422 (e.g. a PR already exists for this head→base pair) throws
 * `GitHubValidationError`.
 */
export async function createPullRequest(
  owner: string,
  name: string,
  params: { title: string; head: string; base: string; body?: string },
): Promise<GitHubPullRequest> {
  const pr = await request<ApiPullRequestResponse>({
    method: "POST",
    path: `/repos/${owner}/${name}/pulls`,
    body: {
      title: params.title,
      head: params.head,
      base: params.base,
      body: params.body ?? "",
    },
  });
  if (!pr) {
    throw new GitHubError({
      message: "GitHub POST /pulls returned an empty 2xx response.",
      status: 201,
      path: `/repos/${owner}/${name}/pulls`,
      body: "",
      method: "POST",
    });
  }
  return mapPullRequest(pr);
}

/**
 * Get a single pull request by number. Throws `GitHubNotFoundError` if the PR
 * does not exist.
 */
export async function getPullRequest(
  owner: string,
  name: string,
  number: number,
): Promise<GitHubPullRequest> {
  const pr = await request<ApiPullRequestResponse>({
    method: "GET",
    path: `/repos/${owner}/${name}/pulls/${number}`,
  });
  if (!pr) {
    throw new GitHubNotFoundError({
      message: `Pull request #${number} not found in ${owner}/${name}.`,
      status: 404,
      path: `/repos/${owner}/${name}/pulls/${number}`,
      body: "",
      method: "GET",
    });
  }
  return mapPullRequest(pr);
}

/**
 * List pull requests. Default state is "open". Sorted by `updated` descending
 * so the most recently active PRs come first.
 */
export async function listPullRequests(
  owner: string,
  name: string,
  state?: "open" | "closed" | "all",
): Promise<GitHubPullRequest[]> {
  const prs = await request<ApiPullRequestResponse[]>({
    method: "GET",
    path: `/repos/${owner}/${name}/pulls`,
    query: {
      state: state ?? "open",
      per_page: 100,
      sort: "updated",
      direction: "desc",
    },
  });
  return (prs ?? []).map(mapPullRequest);
}

/**
 * Merge a pull request. Default method is "merge" (creates a merge commit);
 * "squash" squashes all commits into one; "rebase" rebases the commits onto
 * the base.
 *
 * Returns `{ sha, merged }` on success. On 409 (PR is not mergeable — has
 * conflicts, or is already merged, or is a draft) throws a generic
 * `GitHubError` with the conflict details in `body`.
 */
export async function mergePullRequest(
  owner: string,
  name: string,
  number: number,
  method?: "merge" | "squash" | "rebase",
): Promise<{ sha: string; merged: boolean }> {
  const result = await request<{ sha: string; merged: boolean; message?: string }>({
    method: "PUT",
    path: `/repos/${owner}/${name}/pulls/${number}/merge`,
    body: {
      merge_method: method ?? "merge",
    },
  });
  if (!result) {
    throw new GitHubError({
      message: `GitHub PUT /pulls/${number}/merge returned an empty 2xx response.`,
      status: 200,
      path: `/repos/${owner}/${name}/pulls/${number}/merge`,
      body: "",
      method: "PUT",
    });
  }
  return { sha: result.sha, merged: result.merged };
}

/**
 * Add an issue-style comment to a pull request. (PRs are issues in GitHub's
 * data model, so this uses the issues comments endpoint, not the review
 * comments endpoint — which targets a specific line of diff.)
 */
export async function addPRComment(
  owner: string,
  name: string,
  number: number,
  body: string,
): Promise<void> {
  await request<unknown>({
    method: "POST",
    path: `/repos/${owner}/${name}/issues/${number}/comments`,
    body: { body },
  });
}

/**
 * Create a review on a pull request. `event` selects the review type:
 *   - "APPROVE"          — approve the PR
 *   - "REQUEST_CHANGES"  — request changes (with `body` as the reason)
 *   - "COMMENT"          — leave a comment without approving/rejecting
 */
export async function createReview(
  owner: string,
  name: string,
  number: number,
  params: { event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string },
): Promise<void> {
  await request<unknown>({
    method: "POST",
    path: `/repos/${owner}/${name}/pulls/${number}/reviews`,
    body: {
      event: params.event,
      body: params.body,
    },
  });
}

/**
 * Get check runs (GitHub Actions / CI results) for a ref (branch name or
 * commit SHA). Returns all check runs reported against that ref.
 *
 * Requires the PAT to have the `checks:read` scope (included in the normal
 * `repo` scope for private repos, and available publicly for public repos).
 */
export async function getCheckRuns(
  owner: string,
  name: string,
  ref: string,
): Promise<GitHubCheckRun[]> {
  const result = await request<ApiCheckRunsResponse>({
    method: "GET",
    path: `/repos/${owner}/${name}/commits/${ref}/check-runs`,
    query: { per_page: 100 },
  });
  if (!result) return [];
  return result.check_runs.map(mapCheckRun);
}

/**
 * Get the default branch of a repository (typically "main" or "master").
 * Throws `GitHubNotFoundError` if the repo does not exist.
 */
export async function getDefaultBranch(
  owner: string,
  name: string,
): Promise<string> {
  const repo = await request<{ default_branch: string }>({
    method: "GET",
    path: `/repos/${owner}/${name}`,
  });
  if (!repo) {
    throw new GitHubNotFoundError({
      message: `Repository ${owner}/${name} not found.`,
      status: 404,
      path: `/repos/${owner}/${name}`,
      body: "",
      method: "GET",
    });
  }
  return repo.default_branch;
}

/**
 * Build a clone URL with the PAT embedded, for passing to `git clone`.
 *
 * Returns: `https://x-access-token:{PAT}@github.com/{owner}/{name}.git`
 *
 * SECURITY: The returned string contains the PAT in cleartext. NEVER log this
 * URL, NEVER return it to the client, NEVER store it in the database. The git
 * engine (`src/lib/git-engine.ts`) consumes it and redacts it from any error
 * messages via its `redactUrl` helper.
 *
 * `owner` and `name` are inserted verbatim — GitHub enforces
 * `[a-zA-Z0-9._-]` on both, so no URL-encoding is required and the result
 * matches the documented format exactly.
 */
export function getCloneUrl(owner: string, name: string): string {
  const pat = getPat();
  return `https://x-access-token:${pat}@github.com/${owner}/${name}.git`;
}

/**
 * Delete a repository. Requires the PAT to have the `delete_repo` scope
 * (which is NOT granted by default — the user must explicitly enable it when
 * creating the PAT). Throws `GitHubForbiddenError` (403) if the scope is
 * missing.
 *
 * Used for cleanup when a Forge project is deleted or a test repo needs to be
 * torn down.
 */
export async function deleteRepository(
  owner: string,
  name: string,
): Promise<void> {
  await request<unknown>({
    method: "DELETE",
    path: `/repos/${owner}/${name}`,
  });
}

// Marker so server-only bundlers can detect this module must not be inlined
// into a client bundle. The actual enforcement is the `process.env` access
// above; this is a defensive hint for tooling.
export const SERVER_ONLY = true as const;
