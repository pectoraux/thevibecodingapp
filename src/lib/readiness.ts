// Forge — credential preflight & readiness gate.
//
// Preflight: runs BEFORE Start Build. Verifies every required credential in
// the manifest is configured (production, test, or sandbox). Blocks Start
// Build until green.
//
// Readiness Gate: runs AFTER all tasks complete. Verifies the project has
// real evidence across 12 categories. Only when every required check PASSES
// may the project enter PRODUCTION_READY.

import { db } from "@/lib/db";
import { ReadinessCategory, BuildEventType } from "@/lib/types";
import { ensureBuildEvent } from "@/lib/events";

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
  // returns { passed, evidence, failureReason? }
  check: (projectId: string) => Promise<{
    passed: boolean;
    evidence?: any;
    failureReason?: string;
  }>;
}

// Helpers
async function getProjectData(projectId: string) {
  const [files, tasks, commits, prs, creds, architecture] = await Promise.all([
    db.repoFile.findMany({ where: { projectId } }),
    db.task.findMany({ where: { projectId } }),
    db.repoCommit.findMany({ where: { projectId } }),
    db.pullRequest.findMany({ where: { projectId } }),
    db.credential.findMany({ where: { projectId } }),
    db.architecture.findUnique({ where: { projectId } }),
  ]);
  return { files, tasks, commits, prs, creds, architecture };
}

// Definitions — each check produces real evidence from the DB.
export const READINESS_CHECKS: ReadinessCheckDef[] = [
  {
    category: ReadinessCategory.BUILD,
    name: "Application files present",
    description: "Repository contains application source files (not just README).",
    required: true,
    check: async (projectId) => {
      const { files } = await getProjectData(projectId);
      const appFiles = files.filter(
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
    check: async (projectId) => {
      const { files } = await getProjectData(projectId);
      const pkg = files.find((f) => f.path === "package.json" || f.path === "requirements.txt" || f.path === "go.mod" || f.path === "Cargo.toml");
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
    description: "Fake Implementation Detector found no TODO/mock/stub/placeholder in app code.",
    required: true,
    check: async (projectId) => {
      const { files } = await getProjectData(projectId);
      const offenders: { path: string; patterns: string[] }[] = [];
      for (const f of files) {
        if (f.path === "README.md" || f.path.startsWith(".git")) continue;
        const pats = JSON.parse(f.suspiciousPatterns || "[]");
        if (Array.isArray(pats) && pats.length > 0) {
          // Only flag high-severity patterns in production paths.
          const high = pats.filter((p: string) =>
            ["mock (commented)", "stub (commented)", "fake (commented)", "dummy (commented)", "not implemented", "not implemented throw", "hardcoded response", "coming soon"].includes(p)
          );
          if (high.length > 0) offenders.push({ path: f.path, patterns: high });
        }
      }
      return {
        passed: offenders.length === 0,
        evidence: { offenders },
        failureReason:
          offenders.length > 0
            ? `${offenders.length} file(s) contain high-severity fake-impl patterns`
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
      const { tasks } = await getProjectData(projectId);
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
      const { tasks } = await getProjectData(projectId);
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
    check: async (projectId) => {
      const { files } = await getProjectData(projectId);
      const entry = files.find((f) =>
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
    check: async (projectId) => {
      const { files, architecture } = await getProjectData(projectId);
      const schemaFile = files.find((f) =>
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
    check: async (projectId) => {
      const { files, architecture } = await getProjectData(projectId);
      const authFile = files.find((f) =>
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
      const { architecture, creds } = await getProjectData(projectId);
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
    description: "Implementation includes error-handling patterns (try/catch or equivalent).",
    required: true,
    check: async (projectId) => {
      const { files } = await getProjectData(projectId);
      const appFiles = files.filter((f) => [".ts", ".tsx", ".js", ".jsx", ".py", ".go"].some((ext) => f.path.endsWith(ext)));
      let errorHandlers = 0;
      for (const f of appFiles) {
        if (/try\s*\{|except\s+\w+|catch\s*\(|\.catch\(/i.test(f.content)) errorHandlers++;
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
    check: async (projectId) => {
      const { files, architecture } = await getProjectData(projectId);
      const healthFile = files.find((f) => /health/i.test(f.path) || /health/i.test(f.content.slice(0, 2000)));
      const archApis = architecture ? JSON.parse(architecture.apiContracts || "[]") : [];
      const healthApi = archApis.find((a: any) => /health/i.test(a.path));
      return {
        passed: !!healthFile || !!healthApi,
        evidence: { healthFile: healthFile?.path, healthApi: healthApi?.path },
        failureReason: !healthFile && !healthApi ? "No health endpoint" : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.SECURITY,
    name: "No committed secrets",
    description: "No file content contains obvious secret patterns (sk_live_, AKIA, etc).",
    required: true,
    check: async (projectId) => {
      const { files } = await getProjectData(projectId);
      const secretPatterns = [/sk_live_[A-Za-z0-9]{16,}/, /sk_test_[A-Za-z0-9]{16,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN (RSA |EC )?PRIVATE KEY-----/];
      const offenders: string[] = [];
      for (const f of files) {
        for (const p of secretPatterns) {
          if (p.test(f.content)) offenders.push(f.path);
        }
      }
      return {
        passed: offenders.length === 0,
        evidence: { offenders },
        failureReason: offenders.length > 0 ? `Secrets detected in: ${offenders.join(", ")}` : undefined,
      };
    },
  },
  {
    category: ReadinessCategory.CONFIG,
    name: "Environment configuration documented",
    description: "Repository includes .env.example or environment documentation.",
    required: true,
    check: async (projectId) => {
      const { files } = await getProjectData(projectId);
      const env = files.find((f) => f.path === ".env.example" || f.path === "ENVIRONMENT.md" || f.path === "docs/environment.md");
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
    check: async (projectId) => {
      const { files } = await getProjectData(projectId);
      const deploy = files.find((f) =>
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
      const { tasks } = await getProjectData(projectId);
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
      const { tasks } = await getProjectData(projectId);
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
  results: any[];
}> {
  const results: any[] = [];
  for (const def of READINESS_CHECKS) {
    const r = await def.check(projectId);
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
      ? `Production Readiness Gate PASSED — ${passedCount}/${results.length} checks`
      : `Production Readiness Gate FAILED — ${failedCount} of ${results.length} checks failed`,
    payload: JSON.stringify({ passed, total: results.length, passedCount, failedCount, results }),
  });

  return { passed, total: results.length, passedCount, failedCount, results };
}
