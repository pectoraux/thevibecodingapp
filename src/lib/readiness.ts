// Forge — credential preflight & readiness gate.
//
// Phase 17A: The readiness gate now:
//   1. Uses the canonical repository-reader (tarball-based, COMPLETE content).
//   2. Uses the repository-scanner (secrets, suspicious patterns, binary detection).
//   3. Verifies canonical HEAD freshness — blocks on CANONICAL_HEAD_STALE.
//   4. Detects tree truncation — blocks when tree is incomplete.
//   5. Records the exact immutable SHA in every readiness result.
//   6. Explicitly blocks LOCAL_ONLY from reaching PRODUCTION_READY.
//   7. Marks files too large to scan as UNVERIFIED — fails (never silently skips).
//
// Preflight: runs BEFORE Start Build. Verifies every required credential.
// Readiness Gate: runs AFTER all tasks complete. Verifies the project has
// real evidence across 12 categories.

import { db } from "@/lib/db";
import { ReadinessCategory, BuildEventType } from "@/lib/types";
import { ensureBuildEvent } from "@/lib/events";
import {
  getRepositorySnapshot,
  type RepoSnapshot,
  type ProjectMode,
  getProjectMode,
} from "@/lib/repository-reader";
import {
  scanRepository,
  summarizeScan,
  hasErrorHandling,
  getHighSeverityPatterns,
  type ScannedFile,
  type ScanSummary,
} from "@/lib/repository-scanner";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface PreflightResult {
  passed: boolean;
  total: number;
  configured: number;
  missing: { name: string; purpose: string; whenRequired: string }[];
}

export async function runPreflight(projectId: string): Promise<PreflightResult> {
  const creds = await db.credential.findMany({ where: { projectId } });
  const required = creds.filter((c) => c.required);
  const missing = required.filter((c) => !c.configured);
  const result: PreflightResult = {
    passed: missing.length === 0,
    total: required.length,
    configured: required.length - missing.length,
    missing: missing.map((c) => ({
      name: c.name,
      purpose: c.purpose,
      whenRequired: c.whenRequired || "",
    })),
  };
  await ensureBuildEvent({
    projectId,
    type: result.passed ? BuildEventType.PREFLIGHT_PASSED : BuildEventType.PREFLIGHT_FAILED,
    level: result.passed ? "success" : "warn",
    message: result.passed
      ? `Preflight passed — all ${result.total} required credential(s) configured`
      : `Preflight failed — ${missing.length} required credential(s) missing`,
    payload: JSON.stringify(result),
  });
  return result;
}

// ---------------------------------------------------------------------------
// Readiness gate — 12 categories
// ---------------------------------------------------------------------------

export interface ReadinessCheckDef {
  category: typeof ReadinessCategory[keyof typeof ReadinessCategory];
  name: string;
  description: string;
  required: boolean;
  check: (projectId: string, repo: RepoSnapshot, scan: ScanSummary, scannedFiles: ScannedFile[]) => Promise<{
    passed: boolean;
    evidence?: any;
    failureReason?: string;
  }>;
}

// Load DB-only project data (tasks, creds, architecture).
async function getProjectDbData(projectId: string): Promise<{
  tasks: any[];
  creds: any[];
  architecture: any;
}> {
  const [tasks, creds, architecture] = await Promise.all([
    db.task.findMany({ where: { projectId } }),
    db.credential.findMany({ where: { projectId } }),
    db.architecture.findUnique({ where: { projectId } }),
  ]);
  return { tasks, creds, architecture };
}

// Definitions — each check produces real evidence from canonical sources.
export const READINESS_CHECKS: ReadinessCheckDef[] = [
  // ======================================================================
  // PHASE 17A: Structural gate checks (run before content checks)
  // ======================================================================

  {
    category: ReadinessCategory.BUILD,
    name: "Repository is GitHub-backed (not LOCAL_ONLY)",
    description: "LOCAL_ONLY projects cannot reach PRODUCTION_READY — the worker's /tmp checkout is ephemeral and content is not persisted.",
    required: true,
    check: async (_projectId, repo) => {
      return {
        passed: repo.mode === "GITHUB_BACKED",
        evidence: { mode: repo.mode },
        failureReason: repo.mode === "LOCAL_ONLY"
          ? "LOCAL_ONLY projects cannot reach PRODUCTION_READY — connect a GitHub repository"
          : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.BUILD,
    name: "Canonical HEAD is fresh (matches GitHub branch HEAD)",
    description: "The cached canonicalHeadSha must equal the actual GitHub integration branch HEAD. This is the repositoryRevisionVerified check — distinct from snapshot extraction completeness.",
    required: true,
    check: async (_projectId, repo) => {
      if (repo.mode !== "GITHUB_BACKED") {
        return { passed: false, evidence: { mode: repo.mode }, failureReason: "Not GitHub-backed" };
      }
      return {
        passed: repo.headVerified,
        evidence: {
          repositoryHeadSha: repo.head,
          headVerified: repo.headVerified,
          headVerificationNote: repo.headVerificationNote,
          // Phase 17D: Explicit terminology — this checks canonical-revision authority,
          // NOT extraction completeness (which is checked separately as snapshotComplete).
          authorityType: "REPOSITORY_REVISION_VERIFIED",
        },
        failureReason: !repo.headVerified
          ? repo.headVerificationNote ?? "Canonical HEAD verification failed"
          : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.BUILD,
    name: "Repository snapshot is complete and verified",
    description: "The readiness gate must scan a complete repository snapshot at an exact immutable SHA with no unreadable files, no symlink escapes, and no extraction errors. This is the snapshotCompleteness check — distinct from canonical-revision authority.",
    required: true,
    check: async (_projectId, repo) => {
      const passed =
        repo.snapshotComplete &&
        repo.unreadableFiles.length === 0 &&
        repo.snapshotError === null;
      return {
        passed,
        evidence: {
          snapshotSource: repo.snapshotSource,
          repositoryHeadSha: repo.head,
          // Phase 17D: Explicit distinction — snapshotComplete = extraction succeeded,
          // NOT canonical-revision authority (which is headVerified, checked separately).
          // Readiness requires BOTH: headVerified AND snapshotComplete.
          complete: repo.snapshotComplete,
          authorityAlsoRequired: "headVerified (checked in Canonical HEAD freshness check)",
          truncated: repo.truncated,
          downloadedBytes: repo.downloadedBytes,
          extractedBytes: repo.extractedBytes,
          extractedFileCount: repo.extractedFileCount,
          unreadableFiles: repo.unreadableFiles,
          snapshotError: repo.snapshotError,
        },
        failureReason: !passed
          ? repo.snapshotError
            ? `REPOSITORY_SNAPSHOT_UNVERIFIED: ${repo.snapshotError}`
            : repo.unreadableFiles.length > 0
            ? `REPOSITORY_SNAPSHOT_UNVERIFIED: ${repo.unreadableFiles.length} unreadable file(s) during extraction`
            : "Repository snapshot is incomplete — readiness cannot verify the complete repository."
          : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.BUILD,
    name: "No unscannable files (too large)",
    description: "Every file in the repository must be scannable. Files exceeding the scan limit are marked UNVERIFIED.",
    required: true,
    check: async (_projectId, _repo, scan) => {
      return {
        passed: scan.unverifiedFiles === 0,
        evidence: {
          unverifiedCount: scan.unverifiedFiles,
          unverifiedFiles: scan.unverifiedFileDetails,
        },
        failureReason: scan.unverifiedFiles > 0
          ? `${scan.unverifiedFiles} file(s) are too large to scan — readiness cannot verify them`
          : undefined,
      };
    },
  },

  // ======================================================================
  // Content-based checks (operate on complete scan results)
  // ======================================================================

  {
    category: ReadinessCategory.BUILD,
    name: "Application files present",
    description: "Repository contains application source files (not just README).",
    required: true,
    check: async (_projectId, repo) => {
      if (repo.unreadable) return { passed: false, evidence: { unreadable: repo.unreadableReason }, failureReason: `Repository unreadable: ${repo.unreadableReason}` };
      const appFiles = repo.files.filter(
        (f) => !f.path.startsWith(".") && f.path !== "README.md" && f.path !== "package.json"
      );
      return {
        passed: appFiles.length >= 3,
        evidence: { appFileCount: appFiles.length, files: appFiles.map((f) => f.path) },
        failureReason:
          appFiles.length < 3 ? "Need at least 3 application source files" : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.BUILD,
    name: "package.json / dependency manifest exists",
    description: "Repository declares its dependencies.",
    required: true,
    check: async (_projectId, repo) => {
      if (repo.unreadable) return { passed: false, evidence: { unreadable: repo.unreadableReason }, failureReason: `Repository unreadable: ${repo.unreadableReason}` };
      const pkg = repo.files.find((f) => f.path === "package.json" || f.path === "requirements.txt" || f.path === "go.mod" || f.path === "Cargo.toml");
      return {
        passed: !!pkg,
        evidence: pkg ? { path: pkg.path } : null,
        failureReason: pkg ? undefined : "No dependency manifest found",
      };
    },
  },
  {
    category: ReadinessCategory.STATIC,
    name: "No high-severity suspicious patterns in production paths",
    description: "Fake Implementation Detector found no TODO/mock/stub/placeholder in app code (complete repository scan).",
    required: true,
    check: async (_projectId, _repo, scan) => {
      return {
        passed: scan.filesWithHighSeverityPatterns.length === 0,
        evidence: { offenders: scan.filesWithHighSeverityPatterns },
        failureReason:
          scan.filesWithHighSeverityPatterns.length > 0
            ? `${scan.filesWithHighSeverityPatterns.length} file(s) contain high-severity fake-impl patterns`
            : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.TESTS,
    name: "All tasks completed",
    description: "Every task in the task graph reached COMPLETED state.",
    required: true,
    check: async (projectId) => {
      const { tasks } = await getProjectDbData(projectId);
      const incomplete = tasks.filter((t) => t.status !== "COMPLETED");
      return {
        passed: tasks.length > 0 && incomplete.length === 0,
        evidence: { total: tasks.length, completed: tasks.length - incomplete.length, incomplete: incomplete.map((t) => t.code) },
        failureReason: incomplete.length > 0 ? `${incomplete.length} task(s) not completed` : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.TESTS,
    name: "Tests executed and passing",
    description: "Tasks recorded test results and they pass.",
    required: true,
    check: async (projectId) => {
      const { tasks } = await getProjectDbData(projectId);
      let total = 0, passing = 0;
      for (const t of tasks) {
        const results = JSON.parse(t.testResultsJson || "[]") as any[];
        for (const r of results) {
          total++;
          if (r.passes) passing++;
        }
      }
      return {
        passed: total > 0 && passing === total,
        evidence: { totalTests: total, passing },
        failureReason: total === 0 ? "No tests recorded" : passing < total ? `${total - passing} test(s) failing` : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.RUNTIME,
    name: "Application entrypoint defined",
    description: "Repository has a runnable entrypoint (server.js / main.py / index.ts / etc).",
    required: true,
    check: async (_projectId, repo) => {
      if (repo.unreadable) return { passed: false, evidence: { unreadable: repo.unreadableReason }, failureReason: `Repository unreadable: ${repo.unreadableReason}` };
      const entry = repo.files.find((f) =>
        ["server.js", "src/index.ts", "src/main.ts", "main.py", "app.py", "cmd/main.go", "src/main.rs"].includes(f.path)
      );
      return {
        passed: !!entry,
        evidence: entry ? { path: entry.path } : null,
        failureReason: entry ? undefined : "No application entrypoint found",
      };
    },
  },
  {
    category: ReadinessCategory.DATA,
    name: "Database schema defined",
    description: "Repository declares its data models / schema.",
    required: true,
    check: async (projectId, repo) => {
      const { architecture } = await getProjectDbData(projectId);
      const schemaFile = repo.files.find((f) =>
        f.path.includes("schema") || f.path.endsWith("prisma") || f.path.endsWith(".sql") || f.path.includes("models/")
      );
      const archDataModels = architecture ? JSON.parse(architecture.dataModels || "[]") : [];
      return {
        passed: !!schemaFile || archDataModels.length > 0,
        evidence: { schemaFile: schemaFile?.path, archDataModelCount: archDataModels.length },
        failureReason: !schemaFile && archDataModels.length === 0 ? "No schema file or data models" : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.AUTH,
    name: "Authentication implemented",
    description: "Repository contains auth implementation (login/session/jwt route).",
    required: true,
    check: async (projectId, repo) => {
      const { architecture } = await getProjectDbData(projectId);
      const authFile = repo.files.find((f) =>
        f.path.toLowerCase().includes("auth") ||
        f.path.toLowerCase().includes("login") ||
        f.path.toLowerCase().includes("session")
      );
      const archApis = architecture ? JSON.parse(architecture.apiContracts || "[]") : [];
      const authApi = archApis.find((a: any) => /auth|login|session|token/i.test(a.path));
      return {
        passed: !!authFile || !!authApi,
        evidence: { authFile: authFile?.path, authApiPath: authApi?.path },
        failureReason: !authFile && !authApi ? "No auth file or auth API" : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.INTEGRATIONS,
    name: "Declared integrations have credentials configured",
    description: "Every integration named in the architecture has its required credential set.",
    required: true,
    check: async (projectId) => {
      const { architecture, creds } = await getProjectDbData(projectId);
      const integrations = architecture ? JSON.parse(architecture.integrations || "[]") : [];
      const missing: string[] = [];
      for (const integ of integrations) {
        const cred = creds.find((c) => c.name === integ.requiredCredential);
        if (integ.requiredCredential && (!cred || !cred.configured)) {
          missing.push(integ.requiredCredential);
        }
      }
      return {
        passed: missing.length === 0,
        evidence: { total: integrations.length, missing },
        failureReason: missing.length > 0 ? `Missing credentials: ${missing.join(", ")}` : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.ERRORS,
    name: "Error handling present",
    description: "Implementation includes error-handling patterns (try/catch or equivalent) in source files.",
    required: true,
    check: async (_projectId, _repo, _scan, scannedFiles) => {
      let errorHandlers = 0;
      for (const f of scannedFiles) {
        if (f.content === null) continue;
        if ([".ts", ".tsx", ".js", ".jsx", ".py", ".go"].some((ext) => f.path.endsWith(ext))) {
          if (hasErrorHandling(f.content)) errorHandlers++;
        }
      }
      return {
        passed: errorHandlers > 0,
        evidence: { filesWithErrors: errorHandlers },
        failureReason: errorHandlers === 0 ? "No error-handling patterns found" : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.OBSERVABILITY,
    name: "Health check endpoint",
    description: "Repository exposes a /health or /healthz endpoint.",
    required: true,
    check: async (projectId, repo, _scan, scannedFiles) => {
      const { architecture } = await getProjectDbData(projectId);
      if (repo.unreadable) return { passed: false, evidence: { unreadable: repo.unreadableReason }, failureReason: `Repository unreadable: ${repo.unreadableReason}` };
      // Check file paths first (fast).
      const healthFile = repo.files.find((f) => /health/i.test(f.path));
      // Then check file contents (complete scan).
      let healthInContent = false;
      if (!healthFile) {
        for (const f of scannedFiles) {
          if (f.content && /health/i.test(f.content.slice(0, 2000))) {
            healthInContent = true;
            break;
          }
        }
      }
      const archApis = architecture ? JSON.parse(architecture.apiContracts || "[]") : [];
      const healthApi = archApis.find((a: any) => /health/i.test(a.path));
      return {
        passed: !!healthFile || healthInContent || !!healthApi,
        evidence: { healthFile: healthFile?.path, healthInContent, healthApiPath: healthApi?.path },
        failureReason: !healthFile && !healthInContent && !healthApi ? "No health endpoint" : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.SECURITY,
    name: "No committed secrets (complete repository scan)",
    description: "No file content contains obvious secret patterns (API keys, private keys, JWTs, etc). Scans ALL text files in the repository.",
    required: true,
    check: async (_projectId, _repo, scan) => {
      return {
        passed: scan.filesWithSecrets.length === 0,
        evidence: {
          offenders: scan.filesWithSecrets,
          findings: scan.filesWithSecretFindings.map((f) => ({ path: f.path, pattern: f.pattern, line: f.line })),
        },
        failureReason: scan.filesWithSecrets.length > 0
          ? `Secrets detected in ${scan.filesWithSecrets.length} file(s): ${scan.filesWithSecrets.join(", ")}`
          : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.CONFIG,
    name: "Environment configuration documented",
    description: "Repository includes .env.example or environment documentation.",
    required: true,
    check: async (_projectId, repo) => {
      if (repo.unreadable) return { passed: false, evidence: { unreadable: repo.unreadableReason }, failureReason: `Repository unreadable: ${repo.unreadableReason}` };
      const env = repo.files.find((f) => f.path === ".env.example" || f.path === "ENVIRONMENT.md" || f.path === "docs/environment.md");
      return {
        passed: !!env,
        evidence: env ? { path: env.path } : null,
        failureReason: env ? undefined : "No .env.example or environment documentation",
      };
    },
  },
  {
    category: ReadinessCategory.DEPLOYMENT,
    name: "Deployment configuration exists",
    description: "Repository has Dockerfile, docker-compose, or equivalent deployment config.",
    required: true,
    check: async (_projectId, repo) => {
      if (repo.unreadable) return { passed: false, evidence: { unreadable: repo.unreadableReason }, failureReason: `Repository unreadable: ${repo.unreadableReason}` };
      const deploy = repo.files.find((f) =>
        ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "vercel.json", "netlify.toml", "fly.toml", "render.yaml", "Procfile"].includes(f.path)
      );
      return {
        passed: !!deploy,
        evidence: deploy ? { path: deploy.path } : null,
        failureReason: deploy ? undefined : "No deployment configuration",
      };
    },
  },
  {
    category: ReadinessCategory.REVIEW,
    name: "Architecture Guardian passed",
    description: "Every task passed Architecture Guardian verification (PASS, not VIOLATION).",
    required: true,
    check: async (projectId) => {
      const { tasks } = await getProjectDbData(projectId);
      const offenders = tasks.filter((t) => t.architectureStatus === "VIOLATION" || t.architectureStatus === "PENDING");
      return {
        passed: offenders.length === 0,
        evidence: { offenders: offenders.map((t) => t.code) },
        failureReason: offenders.length > 0 ? `${offenders.length} task(s) failed or pending Guardian` : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.REVIEW,
    name: "Independent code review passed",
    description: "Every task passed independent code review (PASSED, not FAILED).",
    required: true,
    check: async (projectId) => {
      const { tasks } = await getProjectDbData(projectId);
      const offenders = tasks.filter((t) => t.reviewStatus === "FAILED" || t.reviewStatus === "PENDING");
      return {
        passed: offenders.length === 0,
        evidence: { offenders: offenders.map((t) => t.code) },
        failureReason: offenders.length > 0 ? `${offenders.length} task(s) failed or pending review` : undefined,
      };
    },
  },
];

// Special "REVIEW" pseudo-category for Guardian & code review (mapped to STATIC/TESTS bucket in UI).
const REVIEW_CATEGORY = "REVIEW" as any;

export async function runReadinessGate(projectId: string): Promise<{
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  /** The exact immutable SHA the readiness gate scanned. For reproducibility. */
  repositoryHeadSha: string | null;
  results: any[];
}> {
  // --- Fetch the canonical repository snapshot WITH content + freshness verification ---
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      githubConnected: true,
      githubRepo: true,
      githubDefaultBranch: true,
      canonicalHeadSha: true,
    },
  });

  const repo: RepoSnapshot = project
    ? await getRepositorySnapshot(project, true, true) // withContent=true, verifyFreshness=true
    : {
        mode: "LOCAL_ONLY",
        head: null,
        headVerified: false,
        headVerificationNote: "Project not found",
        branches: [],
        files: [],
        commits: [],
        pullRequests: [],
        unreadable: true,
        unreadableReason: "Project not found",
        snapshotSource: "LOCAL_EVIDENCE",
        snapshotComplete: false,
        truncated: false,
        downloadedBytes: 0,
        extractedBytes: 0,
        extractedFileCount: 0,
        unreadableFiles: [],
        snapshotError: "Project not found",
      };

  // --- Scan the complete repository content ---
  let scannedFiles: ScannedFile[] = [];
  let scanSummary: ScanSummary;
  if (repo.rawFiles && repo.rawFiles.length > 0) {
    scannedFiles = scanRepository(repo.rawFiles);
    scanSummary = summarizeScan(scannedFiles);
  } else {
    // LOCAL_ONLY or unreadable — no raw files to scan.
    scanSummary = {
      totalFiles: 0,
      textFiles: 0,
      binaryFiles: 0,
      unverifiedFiles: 0,
      filesWithSecrets: [],
      filesWithHighSeverityPatterns: [],
      filesWithSecretFindings: [],
      unverifiedFileDetails: [],
    };
  }

  // --- Run all readiness checks ---
  const results: any[] = [];
  for (const def of READINESS_CHECKS) {
    const r = await def.check(projectId, repo, scanSummary, scannedFiles);
    const status = r.passed ? "PASSED" : "FAILED";
    results.push({
      category: def.category,
      name: def.name,
      description: def.description,
      required: def.required,
      status,
      evidence: r.evidence ?? null,
      failureReason: r.failureReason ?? null,
      checkedAt: new Date().toISOString(),
    });
  }

  // --- Record the exact SHA in every result (for reproducibility) ---
  for (const r of results) {
    r.repositoryHeadSha = repo.head;
  }

  // Upsert readiness checks in DB.
  for (const r of results) {
    const existing = await db.readinessCheck.findFirst({
      where: { projectId, name: r.name },
    });
    const data = {
      projectId,
      category: r.category,
      name: r.name,
      description: r.description,
      required: r.required,
      status: r.status,
      evidence: r.evidence ? JSON.stringify(r.evidence) : null,
      failureReason: r.failureReason,
      checkedAt: new Date(),
    };
    if (existing) {
      await db.readinessCheck.update({ where: { id: existing.id }, data });
    } else {
      await db.readinessCheck.create({ data });
    }
  }

  const passedCount = results.filter((r) => r.status === "PASSED").length;
  const failedCount = results.length - passedCount;
  const passed = failedCount === 0;

  await ensureBuildEvent(projectId, {
    type: passed ? BuildEventType.READINESS_GATE_PASSED : BuildEventType.READINESS_GATE_FAILED,
    level: passed ? "success" : "error",
    message: passed
      ? `Production Readiness Gate PASSED — ${passedCount}/${results.length} checks (SHA: ${repo.head?.slice(0, 7) ?? "none"})`
      : `Production Readiness Gate FAILED — ${failedCount} of ${results.length} checks failed (SHA: ${repo.head?.slice(0, 7) ?? "none"})`,
    payload: JSON.stringify({
      passed,
      total: results.length,
      passedCount,
      failedCount,
      repositoryHeadSha: repo.head,
      headVerified: repo.headVerified,
      snapshotSource: repo.snapshotSource,
      snapshotComplete: repo.snapshotComplete,
      snapshotError: repo.snapshotError,
      downloadedBytes: repo.downloadedBytes,
      extractedBytes: repo.extractedBytes,
      extractedFileCount: repo.extractedFileCount,
      unreadableFiles: repo.unreadableFiles,
      truncated: repo.truncated,
      scanSummary: {
        totalFiles: scanSummary.totalFiles,
        textFiles: scanSummary.textFiles,
        binaryFiles: scanSummary.binaryFiles,
        unverifiedFiles: scanSummary.unverifiedFiles,
        filesWithSecrets: scanSummary.filesWithSecrets,
        filesWithHighSeverityPatterns: scanSummary.filesWithHighSeverityPatterns,
      },
      results,
    }),
  });

  return {
    passed,
    total: results.length,
    passedCount,
    failedCount,
    repositoryHeadSha: repo.head,
    results,
  };
}
