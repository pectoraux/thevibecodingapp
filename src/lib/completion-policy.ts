// Forge — Phase 15: Canonical completion policy.
//
// ONE function used by worker, submit-evidence, scheduler, and UI.
// For GITHUB_BACKED: push + remote verification required.
// For LOCAL_ONLY: push not required.

export interface TaskEvidence {
  commitSha: string | null;
  pushedToRemote: boolean;
  remoteCommitVerified: boolean;
  baseCommitSha: string | null;
  guardianVerdict: string;
  reviewVerdict: string;
  testsPassed: boolean;
  evidencePersisted: boolean;
}

export type ProjectMode = "LOCAL_ONLY" | "GITHUB_BACKED";

const BLOCK_VERDICTS = ["VIOLATION", "UNVERIFIED", "ARCHITECTURE_CHANGE_REQUIRED"];

export function canCompleteTask(evidence: TaskEvidence, mode: ProjectMode): boolean {
  const hasRealCommit = !!evidence.commitSha && evidence.commitSha !== "null" && evidence.commitSha.length >= 7;
  const guardianPassed = !BLOCK_VERDICTS.includes(evidence.guardianVerdict);
  const reviewApproved = evidence.reviewVerdict === "APPROVED";
  const testsOk = evidence.testsPassed;
  const evidenceOk = evidence.evidencePersisted;

  // Common requirements for both modes.
  const common = hasRealCommit && guardianPassed && reviewApproved && testsOk && evidenceOk;

  if (mode === "GITHUB_BACKED") {
    // P15: GitHub-backed completion requires push + remote verification.
    return common && evidence.pushedToRemote && evidence.remoteCommitVerified;
  }

  // LOCAL_ONLY: push not required.
  return common;
}

export function getFailureReason(evidence: TaskEvidence, mode: ProjectMode): string {
  const reasons: string[] = [];

  if (!evidence.commitSha || evidence.commitSha.length < 7) reasons.push("commit=MISSING");
  if (BLOCK_VERDICTS.includes(evidence.guardianVerdict)) reasons.push(`guardian=${evidence.guardianVerdict}`);
  if (evidence.reviewVerdict !== "APPROVED") reasons.push(`review=${evidence.reviewVerdict}`);
  if (!evidence.testsPassed) reasons.push("tests=FAIL");
  if (!evidence.evidencePersisted) reasons.push("evidence=NOT_PERSISTED");

  if (mode === "GITHUB_BACKED") {
    if (!evidence.pushedToRemote) reasons.push("push=FAILED");
    if (!evidence.remoteCommitVerified) reasons.push("remote=UNVERIFIED");
  }

  return reasons.join(", ");
}
