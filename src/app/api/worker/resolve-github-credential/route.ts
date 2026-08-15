import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";

// POST /api/worker/resolve-github-credential
//
// Phase 11B: Returns the GitHub PAT for authenticated clone/push.
// The worker must be authenticated with an execution token.
// The token is NEVER sent to the LLM or browser — only to the authenticated worker.
// After clone/push, the worker removes the credential from .git/config.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req);
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    if (!token.executionId) {
      return NextResponse.json({ error: "Execution token required" }, { status: 403 });
    }

    // The GitHub PAT is from the environment (GITHUB_PAT).
    // In a production system, this would be a per-user/project scoped credential
    // stored in the secret store and resolved here.
    // For now, we use the platform-level GITHUB_PAT.
    const githubPat = process.env.GITHUB_PAT;

    if (!githubPat) {
      return NextResponse.json({ error: "No GitHub credential configured" }, { status: 404 });
    }

    return NextResponse.json({ token: githubPat });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
