import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { db } from "@/lib/db";

// POST /api/supervisor/resolve-repo-credential
//
// Phase 18Z-PRE — Repository Execution Boundary.
//
// Called by the substrate supervisor AFTER it has verified + consumed the
// ExecutionCapability. The supervisor passes the capability's repositoryUrl;
// the control plane resolves the matching GitHub credential for the
// execution's project and returns an AUTHENTICATED cloneUrl the supervisor
// can pass to `git clone`.
//
// WHY THIS ENDPOINT EXISTS (Phase 18Z-PRE):
//   Before 18Z-PRE, the worker supplied a `repoPath` (host-side path to a
//   clone the worker had already done). The supervisor trusted that path for
//   `git -C repoPath rev-parse HEAD` + `git status --porcelain`. A malicious
//   worker could point the supervisor at a different repo with the same SHA
//   but attacker-controlled ignored files / hooks / submodule state — the
//   supervisor would have run the attacker's chosen tree. `git status
//   --porcelain` does NOT report ignored files.
//
//   Phase 18Z-PRE closes this by making the SUPERVISOR own the clone:
//     - The worker supplies ONLY { capability } — no repoPath.
//     - The capability carries repositoryUrl (signed — tampering breaks the
//       signature).
//     - The supervisor calls THIS endpoint to get the authenticated cloneUrl
//       (the worker never sees the credential).
//     - The supervisor clones into a per-execution workspace it controls.
//     - The supervisor verifies the cloned HEAD === cap.repositoryHeadSha.
//
// REQUEST:
//   Headers: Authorization: Bearer <FORGE_SUPERVISOR_SECRET>
//   Body:    { executionId, repositoryUrl }
//
// RESPONSE:
//   200 — { cloneUrl, credentialType }
//   401 — missing or wrong supervisor secret.
//   403 — repositoryUrl does not match the project's githubRepo (a worker
//         can't substitute a different repo URL — the supervisor only gets
//         credentials for the capability's repo).
//   404 — job / project not found, or project not GitHub-connected.
//   500 — internal error (e.g., DB unavailable).
//
// SECURITY:
//   - The supervisor secret is checked with a constant-time compare.
//   - The repositoryUrl is verified to MATCH the project's githubRepo
//     (the supervisor can't be tricked into cloning a different repo).
//   - The returned cloneUrl is the AUTHENTICATED URL — the supervisor does
//     NOT need to embed a token itself (it couldn't, since it doesn't have
//     the GitHub PAT).
//   - The cloneUrl is returned ONLY to the supervisor (the worker never
//     sees it — the worker POSTs { capability } to the supervisor, the
//     supervisor calls THIS endpoint server-to-server).

interface ResolveRequestBody {
  executionId?: unknown;
  repositoryUrl?: unknown;
}

interface ResolveErrorBody {
  error: string;
  reason?: string;
}

function unauthorized(error: string): NextResponse {
  return NextResponse.json({ error } satisfies ResolveErrorBody, { status: 401 });
}

function forbidden(error: string, reason?: string): NextResponse {
  return NextResponse.json(
    { error, reason } satisfies ResolveErrorBody,
    { status: 403 }
  );
}

function notFound(error: string): NextResponse {
  return NextResponse.json({ error } satisfies ResolveErrorBody, { status: 404 });
}

/**
 * Constant-time string compare. Returns true iff a === b (same length and
 * bytes).
 */
function safeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify that the presented repositoryUrl matches the project's githubRepo.
 *
 * The control plane constructs the canonical repositoryUrl as
 * `https://github.com/${project.githubRepo}.git` (see job-spec route). The
 * supervisor passes the capability's repositoryUrl here. They MUST match
 * exactly — a worker can't substitute a different repo URL (the capability
 * is signed, so tampering with repositoryUrl breaks the signature; this
 * check is defense-in-depth against a misconfigured supervisor that accepts
 * a worker-supplied URL).
 *
 * For file:// URLs (used in tests), we accept any URL — the test harness
 * creates a local repo and signs a capability pointing at it.
 */
function repositoryUrlMatchesProject(
  repositoryUrl: string,
  githubRepo: string
): boolean {
  // file:// URLs are for local-test repos. We accept any file:// URL —
  // the supervisor will clone it directly. (In production, capabilities
  // always carry https://github.com/... URLs.)
  if (repositoryUrl.startsWith("file://")) {
    return true;
  }
  // https://github.com/<owner>/<repo>.git
  const expected = `https://github.com/${githubRepo}.git`;
  return safeEqualString(repositoryUrl, expected);
}

export async function POST(req: Request) {
  // =========================================================================
  // 1. Authenticate the supervisor (shared secret).
  // =========================================================================
  // Same shared secret as /api/supervisor/consume-capability. The supervisor
  // must present it to prove its identity — otherwise any unauthenticated
  // caller could resolve GitHub credentials (credential exfiltration risk).
  const SUPERVISOR_SECRET = process.env.FORGE_SUPERVISOR_SECRET ?? "";
  if (!SUPERVISOR_SECRET) {
    return unauthorized(
      "FORGE_SUPERVISOR_SECRET is not set on the control plane — cannot authenticate the supervisor"
    );
  }
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return unauthorized("Missing Bearer token");
  }
  const presentedSecret = authHeader.slice(7);
  if (!presentedSecret || !safeEqualString(presentedSecret, SUPERVISOR_SECRET)) {
    return unauthorized("Invalid supervisor secret");
  }

  // =========================================================================
  // 2. Parse + validate the request body.
  // =========================================================================
  let body: ResolveRequestBody;
  try {
    body = (await req.json()) as ResolveRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Request body is not valid JSON" } satisfies ResolveErrorBody,
      { status: 400 }
    );
  }

  const executionId =
    typeof body.executionId === "string" ? body.executionId : "";
  const repositoryUrl =
    typeof body.repositoryUrl === "string" ? body.repositoryUrl : "";

  if (!executionId) {
    return NextResponse.json(
      { error: "executionId is required" } satisfies ResolveErrorBody,
      { status: 400 }
    );
  }
  if (!repositoryUrl) {
    return NextResponse.json(
      { error: "repositoryUrl is required" } satisfies ResolveErrorBody,
      { status: 400 }
    );
  }

  // =========================================================================
  // 3. Load the ExecutionJob → Project.
  // =========================================================================
  type ResolveJob = {
    id: string;
    executionId: string;
    projectId: string;
  };
  let job: ResolveJob | null = null;
  try {
    const found = await db.executionJob.findUnique({
      where: { executionId },
      select: { id: true, executionId: true, projectId: true },
    });
    job = found as ResolveJob | null;
  } catch (err: any) {
    console.error(
      `[resolve-repo-credential] DB error loading job ${executionId}: ${err?.message ?? String(err)}`
    );
    return NextResponse.json(
      {
        error: "DB unavailable — cannot resolve repo credential",
        reason: err?.message ?? String(err),
      } satisfies ResolveErrorBody,
      { status: 500 }
    );
  }

  if (!job) {
    return notFound(`ExecutionJob not found for executionId ${executionId}`);
  }

  // Load the project to get githubRepo + verify githubConnected.
  type ResolveProject = {
    id: string;
    githubConnected: boolean;
    githubRepo: string | null;
    githubDefaultBranch: string;
  };
  let project: ResolveProject | null = null;
  try {
    const found = await db.project.findUnique({
      where: { id: job.projectId },
      select: {
        id: true,
        githubConnected: true,
        githubRepo: true,
        githubDefaultBranch: true,
      },
    });
    project = found as ResolveProject | null;
  } catch (err: any) {
    console.error(
      `[resolve-repo-credential] DB error loading project for job ${executionId}: ${err?.message ?? String(err)}`
    );
    return NextResponse.json(
      {
        error: "DB unavailable — cannot resolve repo credential",
        reason: err?.message ?? String(err),
      } satisfies ResolveErrorBody,
      { status: 500 }
    );
  }

  if (!project) {
    return notFound(`Project not found for executionId ${executionId}`);
  }
  if (!project.githubConnected || !project.githubRepo) {
    return notFound(
      `Project ${job.projectId} is not GitHub-connected — cannot resolve a clone credential`
    );
  }

  // =========================================================================
  // 4. Verify the repositoryUrl matches the project's githubRepo.
  // =========================================================================
  // Defense-in-depth: the capability's repositoryUrl is SIGNED, so a worker
  // can't tamper with it without breaking the signature. But we verify AGAIN
  // here in case the supervisor was tricked into passing a different URL
  // (it shouldn't — it reads repositoryUrl from the verified capability).
  if (!repositoryUrlMatchesProject(repositoryUrl, project.githubRepo)) {
    return forbidden(
      `repositoryUrl does not match the project's githubRepo (${project.githubRepo})`,
      "REPO_URL_MISMATCH"
    );
  }

  // =========================================================================
  // 5. Resolve the GitHub credential.
  // =========================================================================
  // Same logic as /api/worker/resolve-github-credential: in production, this
  // would use a GitHub App installation token or a user-scoped OAuth token
  // stored in the secret store. For now, we use the platform GITHUB_PAT.
  //
  // The credential is NEVER returned to the worker — only the supervisor
  // gets the authenticated cloneUrl, and only AFTER it has verified +
  // consumed the capability.
  //
  // For file:// URLs (used in tests), no credential is needed — return the
  // URL as-is.
  if (repositoryUrl.startsWith("file://")) {
    return NextResponse.json({
      cloneUrl: repositoryUrl,
      credentialType: "none" as const,
    });
  }

  const githubPat = process.env.GITHUB_PAT;
  if (!githubPat) {
    return NextResponse.json(
      {
        error: "BLOCKED: No GitHub credential configured for this project (GITHUB_PAT not set)",
      } satisfies ResolveErrorBody,
      { status: 403 }
    );
  }

  // Construct the authenticated cloneUrl. The supervisor passes this to
  // `git clone <cloneUrl> <workspace>/repo`. The token is embedded in the
  // URL — git stores it in .git/config (the supervisor should remove it
  // after cloning, but in the per-execution workspace, this is acceptable
  // — the workspace is owned by the supervisor and cleaned up after the
  // execution).
  const cloneUrl = `https://x-access-token:${githubPat}@github.com/${project.githubRepo}.git`;

  return NextResponse.json({
    cloneUrl,
    credentialType: "pat" as const,
  });
}
