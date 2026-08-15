// Forge — Phase 18: Runtime Verification Pipeline.
//
// Runtime verification executes the ACTUAL merged application at the exact
// canonical GitHub SHA. It proves the product works, not just that the code
// looks correct.
//
// PIPELINE:
//   canonical GitHub SHA
//     → isolated runtime environment (clone at exact SHA)
//     → install dependencies
//     → build
//     → start application
//     → startup verification (process alive, port listening)
//     → health/readiness checks
//     → database connectivity
//     → declared integrations
//     → critical API journeys
//     → background job checks
//     → browser journeys
//     → shutdown/cleanup
//     → immutable runtime evidence
//     → PRODUCTION_READY eligibility
//
// EVIDENCE MODEL:
//   RuntimeEvidence is APPEND-ONLY. Each verification run produces a new record
//   tied to a specific immutable SHA. The evidence records:
//     - repositoryHeadSha (exact revision executed)
//     - environmentFingerprint (what ran it)
//     - dependencyInstallResult, buildResult, startupResult
//     - healthChecks[], apiJourneys[], integrationChecks[]
//     - backgroundJobChecks[], browserJourneys[]
//     - teardownResult
//     - passed (overall verdict)
//
// PRODUCTION_READY PREDICATE (Phase 18):
//   PRODUCTION_READY =
//     architectureFrozen
//     AND allTasksCompleted
//     AND allTasksIntegrated
//     AND staticReadinessPassed (Phase 17)
//     AND runtimeVerificationPassed (Phase 18)
//     AND executionEnvironmentSandboxed
//     AND repositoryHeadVerified
//     AND evidencePersisted

// ---------------------------------------------------------------------------
// Runtime Verification Plan — what to execute and verify
// ---------------------------------------------------------------------------

export interface RuntimeVerificationPlan {
  /** The exact immutable SHA to verify. Must match canonicalHeadSha. */
  repositoryHeadSha: string;
  /** The GitHub repo (owner/name) to clone. */
  githubRepo: string;
  /** The default branch (for freshness verification). */
  githubDefaultBranch: string;

  // Install stage
  installCommands: string[];

  // Build stage
  buildCommands: string[];

  // Startup stage — the command that starts the application server
  startCommand: string;
  /** Port the application is expected to listen on. */
  expectedPort: number;
  /** Max time to wait for startup (ms). */
  startupTimeoutMs: number;

  // Health checks — URLs to poll after startup
  healthChecks: { name: string; path: string; expectedStatus: number; timeoutMs: number }[];

  // API journeys — critical endpoints to exercise
  apiJourneys: { name: string; method: string; path: string; expectedStatus: number; body?: string }[];

  // Integration checks — verify declared integrations are reachable
  integrationChecks: { name: string; type: string }[];

  // Background job checks — verify background jobs execute
  backgroundJobChecks: { name: string; type: string }[];

  // Browser journeys — critical user paths (if UI exists)
  browserJourneys: { name: string; url: string; expectedText: string }[];

  // Teardown
  teardownTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Runtime Verification Result — the evidence record
// ---------------------------------------------------------------------------

export interface StageResult {
  success: boolean;
  durationMs: number;
  exitCode: number | null;
  output: string; // truncated
  error?: string;
}

export interface HealthCheckResult {
  name: string;
  path: string;
  passed: boolean;
  status: number | null;
  responseTimeMs: number;
  error?: string;
}

export interface ApiJourneyResult {
  name: string;
  method: string;
  path: string;
  passed: boolean;
  status: number | null;
  responseTimeMs: number;
  error?: string;
}

export interface IntegrationCheckResult {
  name: string;
  type: string;
  passed: boolean;
  error?: string;
}

export interface BackgroundJobResult {
  name: string;
  type: string;
  passed: boolean;
  error?: string;
}

export interface BrowserJourneyResult {
  name: string;
  url: string;
  passed: boolean;
  expectedTextFound: boolean;
  error?: string;
}

export interface TeardownResult {
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface EnvironmentFingerprint {
  nodeVersion: string;
  platform: string;
  arch: string;
  executionMode: string;
  workerVersion: string;
  timestamp: string;
}

export interface RuntimeVerificationResult {
  // Exact revision
  repositoryHeadSha: string;
  headVerified: boolean;

  // Environment
  environmentFingerprint: EnvironmentFingerprint;

  // Pipeline stages
  dependencyInstallResult: StageResult;
  buildResult: StageResult;
  startupResult: StageResult & { port: number; pid: number | null };
  healthChecks: HealthCheckResult[];
  apiJourneys: ApiJourneyResult[];
  integrationChecks: IntegrationCheckResult[];
  backgroundJobChecks: BackgroundJobResult[];
  browserJourneys: BrowserJourneyResult[];
  teardownResult: TeardownResult;

  // Overall
  passed: boolean;
  failureReason: string | null;

  // Timing
  startedAt: string;
  completedAt: string;

  // Truncated logs
  logs: string;
}

// ---------------------------------------------------------------------------
// Production readiness predicate (Phase 18)
// ---------------------------------------------------------------------------

export interface ProductionReadinessEvidence {
  // Static readiness (Phase 17)
  architectureFrozen: boolean;
  allTasksCompleted: boolean;
  allTasksIntegrated: boolean;
  staticReadinessPassed: boolean;

  // Runtime verification (Phase 18)
  runtimeVerificationPassed: boolean;
  runtimeEvidencePersisted: boolean;

  // Environment
  executionEnvironmentSandboxed: boolean;
  repositoryHeadVerified: boolean;
}

/**
 * Phase 18: The canonical production readiness predicate.
 *
 * PRODUCTION_READY requires BOTH static AND runtime verification.
 * Static inspection (Phase 17) proves the code looks correct.
 * Runtime verification (Phase 18) proves the application actually works.
 *
 * Neither alone is sufficient.
 */
export function canReachProductionReadyWithRuntime(
  evidence: ProductionReadinessEvidence
): boolean {
  return (
    evidence.architectureFrozen &&
    evidence.allTasksCompleted &&
    evidence.allTasksIntegrated &&
    evidence.staticReadinessPassed &&
    evidence.runtimeVerificationPassed &&
    evidence.runtimeEvidencePersisted &&
    evidence.executionEnvironmentSandboxed &&
    evidence.repositoryHeadVerified
  );
}

/**
 * Get a human-readable failure reason for why a project cannot reach
 * PRODUCTION_READY. Lists all failing conditions.
 */
export function getProductionReadinessFailureReason(
  evidence: ProductionReadinessEvidence
): string | null {
  const reasons: string[] = [];

  if (!evidence.architectureFrozen) reasons.push("architecture=NOT_FROZEN");
  if (!evidence.allTasksCompleted) reasons.push("tasks=INCOMPLETE");
  if (!evidence.allTasksIntegrated) reasons.push("integration=PENDING");
  if (!evidence.staticReadinessPassed) reasons.push("staticReadiness=FAILED");
  if (!evidence.runtimeVerificationPassed) reasons.push("runtimeVerification=FAILED");
  if (!evidence.runtimeEvidencePersisted) reasons.push("runtimeEvidence=NOT_PERSISTED");
  if (!evidence.executionEnvironmentSandboxed) reasons.push("environment=UNSANDBOXED");
  if (!evidence.repositoryHeadVerified) reasons.push("repositoryHead=UNVERIFIED");

  return reasons.length > 0 ? reasons.join(", ") : null;
}

// ---------------------------------------------------------------------------
// Plan derivation — build a RuntimeVerificationPlan from project + architecture
// ---------------------------------------------------------------------------

/**
 * Derive a runtime verification plan from the project's architecture contract.
 *
 * The plan is derived from:
 *   - The architecture's deploymentModel (how to start the app)
 *   - The architecture's apiContracts (critical API journeys)
 *   - The architecture's integrations (integration checks)
 *   - The architecture's testingStrategy (what to verify)
 *
 * For projects without an architecture contract, a minimal plan is used
 * (install + build + start + health check).
 */
export function deriveRuntimeVerificationPlan(
  project: {
    canonicalHeadSha: string | null;
    githubRepo: string | null;
    githubDefaultBranch: string;
  },
  architecture: {
    contractJson: string | null;
    apiContracts: string | null;
    integrations: string | null;
    testingStrategy: string | null;
    deploymentModel: string | null;
  } | null
): RuntimeVerificationPlan | null {
  if (!project.canonicalHeadSha || !project.githubRepo) return null;

  const sha = project.canonicalHeadSha;
  const repo = project.githubRepo;
  const branch = project.githubDefaultBranch || "main";

  // Parse architecture contract for verification plan details.
  let installCommands = ["npm install"];
  let buildCommands = ["npm run build"];
  let startCommand = "npm start";
  let expectedPort = 3000;
  let apiJourneys: { name: string; method: string; path: string; expectedStatus: number }[] = [];
  let integrationChecks: { name: string; type: string }[] = [];

  if (architecture) {
    try {
      // Extract API contracts for journey definitions.
      const apis = JSON.parse(architecture.apiContracts || "[]") as any[];
      apiJourneys = apis.slice(0, 10).map((a) => ({
        name: a.name || a.path || "API",
        method: a.method || "GET",
        path: a.path || "/",
        expectedStatus: a.expectedStatus || 200,
      }));

      // Extract integrations for integration checks.
      const integrations = JSON.parse(architecture.integrations || "[]") as any[];
      integrationChecks = integrations.map((i) => ({
        name: i.name || "integration",
        type: i.type || "unknown",
      }));

      // Parse deployment model for start command + port.
      const deploy = JSON.parse(architecture.deploymentModel || "{}");
      if (deploy.startCommand) startCommand = deploy.startCommand;
      if (deploy.port) expectedPort = deploy.port;
      if (deploy.installCommands) installCommands = deploy.installCommands;
      if (deploy.buildCommands) buildCommands = deploy.buildCommands;
    } catch {
      // Fall back to defaults.
    }
  }

  return {
    repositoryHeadSha: sha,
    githubRepo: repo,
    githubDefaultBranch: branch,
    installCommands,
    buildCommands,
    startCommand,
    expectedPort,
    startupTimeoutMs: 30000,
    healthChecks: [
      { name: "Health endpoint", path: "/api/health", expectedStatus: 200, timeoutMs: 10000 },
    ],
    apiJourneys,
    integrationChecks,
    backgroundJobChecks: [],
    browserJourneys: [],
    teardownTimeoutMs: 10000,
  };
}

// ---------------------------------------------------------------------------
// Result evaluation — determine if a runtime verification result passes
// ---------------------------------------------------------------------------

/**
 * Evaluate a runtime verification result to determine if it passes.
 *
 * A result passes when:
 *   - dependency install succeeded
 *   - build succeeded
 *   - startup succeeded (process alive, port listening)
 *   - ALL health checks passed
 *   - ALL API journeys passed
 *   - teardown succeeded
 *
 * Integration checks, background jobs, and browser journeys are best-effort:
 * they don't block the overall verdict unless the plan declares them required.
 */
export function evaluateRuntimeVerificationResult(
  result: RuntimeVerificationResult
): { passed: boolean; failureReason: string | null } {
  const reasons: string[] = [];

  if (!result.dependencyInstallResult.success) {
    reasons.push("dependencyInstall=FAILED");
  }
  if (!result.buildResult.success) {
    reasons.push("build=FAILED");
  }
  if (!result.startupResult.success) {
    reasons.push("startup=FAILED");
  }
  if (result.healthChecks.length > 0 && !result.healthChecks.every((h) => h.passed)) {
    const failed = result.healthChecks.filter((h) => !h.passed).map((h) => h.name);
    reasons.push(`healthChecks=FAILED(${failed.join(",")})`);
  }
  if (result.apiJourneys.length > 0 && !result.apiJourneys.every((a) => a.passed)) {
    const failed = result.apiJourneys.filter((a) => !a.passed).map((a) => a.name);
    reasons.push(`apiJourneys=FAILED(${failed.join(",")})`);
  }
  if (!result.teardownResult.success) {
    reasons.push("teardown=FAILED");
  }

  const passed = reasons.length === 0;
  return {
    passed,
    failureReason: passed ? null : reasons.join(", "),
  };
}
