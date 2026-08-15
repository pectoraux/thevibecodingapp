// Git module — safe argument-array operations, no shell interpolation.
// All git commands use execFileSync with argument arrays.

import { execFileSync } from "node:child_process";

export function gitExec(repoPath: string, args: string[], timeoutMs = 10000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd: repoPath,
      timeout: timeoutMs,
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout: stdout.toString().trim(), stderr: "" };
  } catch (err: any) {
    return { ok: false, stdout: "", stderr: (err.stderr || err.message || "").toString().trim() };
  }
}

export function gitInit(repoPath: string): void {
  gitExec(repoPath, ["init"]);
  gitExec(repoPath, ["config", "user.email", "forge-worker@local"]);
  gitExec(repoPath, ["config", "user.name", "Forge Worker"]);
}

export function gitClone(repoUrl: string, targetPath: string): boolean {
  const result = gitExec("/tmp", ["clone", repoUrl, targetPath], 60000);
  if (!result.ok) {
    console.log(`[git] clone failed: ${result.stderr}`);
    return false;
  }
  gitExec(targetPath, ["config", "user.email", "forge-worker@local"]);
  gitExec(targetPath, ["config", "user.name", "Forge Worker"]);
  return true;
}

export function gitFetch(repoPath: string): boolean {
  const result = gitExec(repoPath, ["fetch", "origin"], 30000);
  return result.ok;
}

export function gitCheckoutBranch(repoPath: string, branchName: string, baseCommit?: string): boolean {
  const args = baseCommit
    ? ["checkout", "-b", branchName, baseCommit]
    : ["checkout", "-b", branchName];
  const result = gitExec(repoPath, args);
  if (!result.ok) {
    console.log(`[git] checkout -b failed: ${result.stderr}`);
    return false;
  }
  return true;
}

export function gitCheckout(repoPath: string, ref: string): boolean {
  const result = gitExec(repoPath, ["checkout", ref]);
  return result.ok;
}

export function gitRevParse(repoPath: string, ref: string): string | null {
  const result = gitExec(repoPath, ["rev-parse", ref]);
  return result.ok ? result.stdout : null;
}

export function gitAddAndCommit(repoPath: string, message: string): string | null {
  const addResult = gitExec(repoPath, ["add", "-A"]);
  if (!addResult.ok) return null;
  const commitResult = gitExec(repoPath, ["commit", "-m", message]);
  if (!commitResult.ok) return null;
  return gitRevParse(repoPath, "HEAD");
}

export function gitDiff(repoPath: string, baseCommit?: string): string {
  const args = baseCommit
    ? ["diff", `${baseCommit}...HEAD`]
    : ["diff", "HEAD~1"];
  const result = gitExec(repoPath, args, 10000);
  if (result.ok) return result.stdout;
  const cached = gitExec(repoPath, ["diff", "--cached"]);
  return cached.ok ? cached.stdout : "";
}

export function gitDiffStat(repoPath: string, baseCommit?: string): string {
  const args = baseCommit
    ? ["diff", "--stat", `${baseCommit}...HEAD`]
    : ["diff", "--stat", "HEAD~1"];
  const result = gitExec(repoPath, args);
  if (result.ok) return result.stdout;
  const cached = gitExec(repoPath, ["diff", "--cached", "--stat"]);
  return cached.ok ? cached.stdout : "";
}

export function gitPush(repoPath: string, branchName: string, remoteUrl?: string): boolean {
  if (remoteUrl) {
    gitExec(repoPath, ["remote", "set-url", "origin", remoteUrl]);
  }
  const result = gitExec(repoPath, ["push", "origin", branchName], 30000);
  return result.ok;
}

export function gitLog(repoPath: string): string {
  const result = gitExec(repoPath, ["log", "--oneline", "-5"]);
  return result.ok ? result.stdout : "";
}
