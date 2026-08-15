// Forge — Evidence Ledger.
//
// Records REAL execution evidence for every task attempt: changed files,
// commands executed, test runs, runtime checks, guardian verdicts, review
// verdicts, integration checks. One TaskEvidence row per attempt (a task may
// have many — one per retry).
//
// CRITICAL INVARIANT: the ledger is IMMUTABLE. Once an evidence record is
// written it MUST NOT be updated. Use `recordEvidence` (which calls
// `db.taskEvidence.create`) only. There is no `updateEvidence` function on
// purpose — exposing one would invite mutation, which would undermine the
// audit trail.
//
// A task may be marked COMPLETED only when its most recent evidence record
// passes `hasSufficientEvidence()` — i.e. real commit, real passing tests,
// no Guardian violation, review approved. The orchestrator should consult
// `summarizeEvidence()` before transitioning a task to COMPLETED.
//
// The evidence payloads are stored as JSON strings (Prisma SQLite does not
// support arrays natively). This module owns the encoding/decoding so callers
// work with native objects.

import { db } from "@/lib/db";
import type { TaskEvidence } from "@prisma/client";

// ---------------------------------------------------------------------------
// Input shapes (caller-friendly)
// ---------------------------------------------------------------------------

export interface CommandExecuted {
  command: string;
  exitCode: number | null;
  durationMs?: number;
  stdoutTail?: string; // last N chars (truncated to keep payload small)
  stderrTail?: string;
  cwd?: string;
}

export interface TestRunResult {
  name: string;
  type?: "unit" | "integration" | "e2e" | "api" | "runtime";
  target?: string;
  passes: boolean;
  durationMs?: number;
  evidence?: string; // human-readable evidence (stdout snippet, assertion, etc.)
  error?: string;
}

export interface RuntimeCheckResult {
  name: string;
  passed: boolean;
  durationMs?: number;
  evidence?: string;
  error?: string;
}

export interface IntegrationCheckResult {
  name: string;
  passed: boolean;
  provider?: string;
  evidence?: string;
  error?: string;
}

export interface GuardianEvidencePayload {
  deterministic?: {
    verdict?: string; // PASS | WARNING | VIOLATION
    violations?: any[];
    warnings?: any[];
    checks?: { name: string; passed: boolean; details: string }[];
    summary?: string;
    architectureVersion?: string;
    architectureHash?: string;
    checkedAt?: string;
    filesAnalyzed?: number;
  };
  llm?: {
    verdict?: string;
    violations?: any[];
    warnings?: any[];
    summary?: string;
    model?: string;
    tokensInput?: number;
    tokensOutput?: number;
    durationMs?: number;
  };
  // Aggregate verdict across both layers (worst-case wins).
  combinedVerdict?: string;
}

export interface ReviewEvidencePayload {
  verdict?: string; // APPROVED | CHANGES_REQUESTED | REJECTED
  findings?: any[];
  summary?: string;
  model?: string;
  tokensInput?: number;
  tokensOutput?: number;
  durationMs?: number;
  reviewedFileCount?: number;
}

export interface RecordEvidenceInput {
  architectureVersion: string;
  architectureHash: string;
  commitSha?: string | null;
  changedFiles?: string[];
  commandsExecuted?: CommandExecuted[];
  testRuns?: TestRunResult[];
  runtimeChecks?: RuntimeCheckResult[];
  guardianResults?: GuardianEvidencePayload | null;
  reviewResults?: ReviewEvidencePayload | null;
  integrationChecks?: IntegrationCheckResult[];
  // P15B: Git evidence metadata
  executionId?: string | null;
  workerId?: string | null;
  branchName?: string | null;
  baseCommitSha?: string | null;
  pushedToRemote?: boolean;
  remoteCommitVerified?: boolean;
}

export interface EvidenceSummary {
  totalAttempts: number;
  hasCommit: boolean;
  hasPassingTests: boolean;
  guardianPassed: boolean;
  reviewPassed: boolean;
  canComplete: boolean;
  lastAttemptAt?: Date;
  totalChecks?: number;
  passedChecks?: number;
  failedChecks?: number;
}

// ---------------------------------------------------------------------------
// Encoding helpers — all array/object fields are stored as JSON strings.
// Defensive: never throw on bad input. Empty arrays/objects are stored as
// their canonical "[]" / "{}" form, never NULL.
// ---------------------------------------------------------------------------

function encodeArray<T>(value: T[] | undefined | null): string {
  if (!value) return "[]";
  try {
    return JSON.stringify(value);
  } catch {
    return "[]";
  }
}

function encodeObject<T>(value: T | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function decodeArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function decodeObject<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Check counter — derive totalChecks / passedChecks / failedChecks from the
// evidence payloads so the dashboard can show "9 of 10 checks passed" without
// re-parsing every JSON blob.
// ---------------------------------------------------------------------------

function computeCheckCounts(input: RecordEvidenceInput): {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
} {
  let total = 0;
  let passed = 0;
  let failed = 0;

  const bump = (ok: boolean) => {
    total += 1;
    if (ok) passed += 1;
    else failed += 1;
  };

  // Commit presence.
  bump(!!input.commitSha);

  // Each test run.
  for (const t of input.testRuns || []) bump(!!t.passes);

  // Each runtime check.
  for (const r of input.runtimeChecks || []) bump(!!r.passed);

  // Each integration check.
  for (const i of input.integrationChecks || []) bump(!!i.passed);

  // Guardian verdict (combined worst-case).
  const gv = input.guardianResults?.combinedVerdict ||
    input.guardianResults?.deterministic?.verdict ||
    input.guardianResults?.llm?.verdict;
  if (gv) bump(gv === "PASS" || gv === "WARNING");

  // Review verdict.
  const rv = input.reviewResults?.verdict;
  if (rv) bump(rv === "APPROVED");

  return { totalChecks: total, passedChecks: passed, failedChecks: failed };
}

// ---------------------------------------------------------------------------
// recordEvidence — the ONLY writer. Calls db.taskEvidence.create. Never
// updates an existing record.
// ---------------------------------------------------------------------------

export async function recordEvidence(
  taskId: string,
  projectId: string,
  evidence: RecordEvidenceInput,
): Promise<TaskEvidence> {
  const counts = computeCheckCounts(evidence);

  // Defensive: never trust the caller's encoding. Always re-encode here.
  const row = await db.taskEvidence.create({
    data: {
      taskId,
      projectId,
      architectureVersion: evidence.architectureVersion,
      architectureHash: evidence.architectureHash,
      commitSha: evidence.commitSha ?? null,
      // P15B: Git evidence metadata
      executionId: evidence.executionId ?? null,
      workerId: evidence.workerId ?? null,
      branchName: evidence.branchName ?? null,
      baseCommitSha: evidence.baseCommitSha ?? null,
      pushedToRemote: evidence.pushedToRemote ?? false,
      remoteCommitVerified: evidence.remoteCommitVerified ?? false,
      changedFiles: encodeArray(evidence.changedFiles),
      commandsExecuted: encodeArray(evidence.commandsExecuted),
      testRuns: encodeArray(evidence.testRuns),
      runtimeChecks: encodeArray(evidence.runtimeChecks),
      guardianResults: encodeObject(evidence.guardianResults),
      reviewResults: encodeObject(evidence.reviewResults),
      integrationChecks: encodeArray(evidence.integrationChecks),
      totalChecks: counts.totalChecks,
      passedChecks: counts.passedChecks,
      failedChecks: counts.failedChecks,
    },
  });

  return row;
}

// ---------------------------------------------------------------------------
// getTaskEvidence — retrieve all evidence records for a task, ordered
// oldest-first (so callers can iterate chronologically). Includes the task
// relation for convenience.
// ---------------------------------------------------------------------------

export async function getTaskEvidence(taskId: string): Promise<TaskEvidence[]> {
  return db.taskEvidence.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
  });
}

export async function getLatestEvidence(taskId: string): Promise<TaskEvidence | null> {
  const rows = await db.taskEvidence.findMany({
    where: { taskId },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  return rows[0] ?? null;
}

export async function getProjectEvidence(projectId: string): Promise<TaskEvidence[]> {
  return db.taskEvidence.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
// P15D: hasSufficientEvidence now takes an optional mode parameter.
// If mode is provided, it uses the ACTUAL project mode (GITHUB_BACKED or LOCAL_ONLY).
// If mode is not provided, it defaults to LOCAL_ONLY for backward compatibility.
// The submit-evidence endpoint always passes the correct mode.
// ---------------------------------------------------------------------------

export function hasSufficientEvidence(evidence: TaskEvidence, mode?: "LOCAL_ONLY" | "GITHUB_BACKED"): boolean {
  const { canCompleteTask } = require("@/lib/completion-policy") as typeof import("@/lib/completion-policy");

  const tests = decodeArray<TestRunResult>(evidence.testRuns);
  const testsPassed = tests.length > 0 && tests.every((t) => t && t.passes === true);

  const guardian = decodeObject<GuardianEvidencePayload>(evidence.guardianResults);
  const guardianVerdict = guardian?.combinedVerdict || guardian?.deterministic?.verdict || "UNVERIFIED";

  const review = decodeObject<ReviewEvidencePayload>(evidence.reviewResults);
  const reviewVerdict = review?.verdict || "REJECTED";

  // P15D: Use the provided mode, or default to LOCAL_ONLY.
  const projectMode = mode || "LOCAL_ONLY";

  return canCompleteTask({
    commitSha: evidence.commitSha,
    pushedToRemote: evidence.pushedToRemote,
    remoteCommitVerified: evidence.remoteCommitVerified,
    baseCommitSha: evidence.baseCommitSha,
    guardianVerdict,
    reviewVerdict,
    testsPassed,
    evidencePersisted: true,
  }, projectMode);
}

// ---------------------------------------------------------------------------
// summarizeEvidence — aggregate view across all of a task's attempts.
// Used by the dashboard and the orchestrator's completion gate.
// ---------------------------------------------------------------------------

export function summarizeEvidence(evidence: TaskEvidence[], mode?: "LOCAL_ONLY" | "GITHUB_BACKED"): EvidenceSummary {
  const totalAttempts = evidence.length;
  if (totalAttempts === 0) {
    return {
      totalAttempts: 0,
      hasCommit: false,
      hasPassingTests: false,
      guardianPassed: false,
      reviewPassed: false,
      canComplete: false,
    };
  }

  // Sort by createdAt descending so "latest" is index 0.
  const sorted = [...evidence].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const latest = sorted[0];

  // Aggregate: any attempt ever had a commit / passing tests / etc.
  const hasCommit = evidence.some((e) => !!e.commitSha && e.commitSha.trim().length > 0);

  const hasPassingTests = evidence.some((e) => {
    const tests = decodeArray<TestRunResult>(e.testRuns);
    return tests.some((t) => t && t.passes === true);
  });

  const guardianPassed = evidence.some((e) => {
    const g = decodeObject<GuardianEvidencePayload>(e.guardianResults);
    if (!g) return false;
    const det = g.deterministic?.verdict;
    const llm = g.llm?.verdict;
    const combined = g.combinedVerdict;
    if (det === "VIOLATION" || llm === "VIOLATION" || combined === "VIOLATION") {
      return false;
    }
    const verdicts = [det, llm, combined].filter(Boolean) as string[];
    if (verdicts.length === 0) return false;
    return verdicts.every((v) => v === "PASS" || v === "WARNING");
  });

  const reviewPassed = evidence.some((e) => {
    const r = decodeObject<ReviewEvidencePayload>(e.reviewResults);
    return r?.verdict === "APPROVED";
  });

  // canComplete is true ONLY if the LATEST attempt has sufficient evidence.
  // (We don't want a stale-good evidence from attempt 1 to mask a broken
  // attempt 2 that introduced a Guardian violation.)
  const canComplete = hasSufficientEvidence(latest, mode);

  // Sum totals across all attempts (informational).
  const totalChecks = evidence.reduce((sum, e) => sum + (e.totalChecks || 0), 0);
  const passedChecks = evidence.reduce((sum, e) => sum + (e.passedChecks || 0), 0);
  const failedChecks = evidence.reduce((sum, e) => sum + (e.failedChecks || 0), 0);

  return {
    totalAttempts,
    hasCommit,
    hasPassingTests,
    guardianPassed,
    reviewPassed,
    canComplete,
    lastAttemptAt: latest.createdAt,
    totalChecks,
    passedChecks,
    failedChecks,
  };
}

// ---------------------------------------------------------------------------
// Decoded view — convenience helper that returns an evidence record with all
// JSON fields parsed into native objects. Useful for API routes / UI.
// ---------------------------------------------------------------------------

export interface DecodedEvidence {
  id: string;
  taskId: string;
  projectId: string;
  architectureVersion: string;
  architectureHash: string;
  commitSha: string | null;
  changedFiles: string[];
  commandsExecuted: CommandExecuted[];
  testRuns: TestRunResult[];
  runtimeChecks: RuntimeCheckResult[];
  guardianResults: GuardianEvidencePayload | null;
  reviewResults: ReviewEvidencePayload | null;
  integrationChecks: IntegrationCheckResult[];
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  createdAt: Date;
  sufficient: boolean;
}

export function decodeEvidence(row: TaskEvidence): DecodedEvidence {
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    architectureVersion: row.architectureVersion,
    architectureHash: row.architectureHash,
    commitSha: row.commitSha,
    changedFiles: decodeArray<string>(row.changedFiles),
    commandsExecuted: decodeArray<CommandExecuted>(row.commandsExecuted),
    testRuns: decodeArray<TestRunResult>(row.testRuns),
    runtimeChecks: decodeArray<RuntimeCheckResult>(row.runtimeChecks),
    guardianResults: decodeObject<GuardianEvidencePayload>(row.guardianResults),
    reviewResults: decodeObject<ReviewEvidencePayload>(row.reviewResults),
    integrationChecks: decodeArray<IntegrationCheckResult>(row.integrationChecks),
    totalChecks: row.totalChecks,
    passedChecks: row.passedChecks,
    failedChecks: row.failedChecks,
    createdAt: row.createdAt,
    sufficient: hasSufficientEvidence(row),
  };
}

// ---------------------------------------------------------------------------
// SERVER-ONLY marker — this module touches the database and must never be
// imported into a client component.
// ---------------------------------------------------------------------------

export const SERVER_ONLY = true as const;
