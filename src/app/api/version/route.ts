// Forge — version endpoint.
//
// Returns the exact code revision running on this deployment, so we can
// always answer: "Which exact code revision is actually running?"
//
// This is the canonical source of truth for deployment verification.

import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FORGE_EXECUTION_MODE, isExecutionSandboxed } from "@/lib/execution-mode";

function getGitSha(): string {
  // 1. Try VERCEL_GIT_COMMIT_SHA (set by Vercel on deployment).
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12);
  }
  // 2. Try reading .git-sha (written at build time).
  try {
    const sha = readFileSync(join(process.cwd(), ".git-sha"), "utf-8").trim();
    if (sha) return sha.slice(0, 12);
  } catch {}
  // 3. Fallback.
  return "unknown";
}

function getBuildTime(): string {
  return process.env.VERCEL_BUILD_TIMESTAMP || new Date().toISOString();
}

export async function GET() {
  return NextResponse.json({
    gitSha: getGitSha(),
    buildTime: getBuildTime(),
    environment: process.env.NODE_ENV || "development",
    executionMode: FORGE_EXECUTION_MODE,
    sandboxed: isExecutionSandboxed(),
    version: "phase13",
    vercelUrl: process.env.VERCEL_URL || null,
    vercelRegion: process.env.VERCEL_REGION || null,
  });
}
