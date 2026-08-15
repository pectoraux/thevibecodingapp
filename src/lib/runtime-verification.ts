// Forge — Phase 18A: Runtime Verification Policy Layer.
//
// HARDENED POLICY (Phase 18A):
//   1. NO RUNTIME DEFAULTS — the plan MUST come from the frozen architecture.
//      If required runtime info is missing, return null (BLOCKED). Never guess
//      npm, ports, commands, or endpoints.
//   2. REQUIRED VS OPTIONAL — each check type has explicit required/optional
//      policy. Required + missing = UNVERIFIED. Required + fail = FAILED.
//      Optional + missing = SKIPPED.
//   3. SERVER-AUTHORITATIVE SHA — the control plane derives expectedSha from
//      project.canonicalHeadSha and independently verifies it against GitHub.
//      The worker may not choose the revision being certified.
//   4. JOURNEYS, NOT JUST ENDPOINTS — API journeys support multi-step sequences
//      with setup, assertions, and teardown.
//   5. EXECUTABLE INTEGRATION CHECKS — each integration has a verification
//      operation (connectivity, test-mode reachability, etc.).
//
// PRODUCTION_READY PREDICATE:
//   Runtime verification produces RUNTIME_VERIFIED only.
//   PRODUCTION_READY is emitted ONLY by the complete canonical predicate:
//     architectureFrozen AND allTasksCompleted AND allTasksIntegrated
//     AND staticReadinessPassed AND runtimeVerificationPassed
//     AND runtimeEvidencePersisted AND executionEnvironmentSandboxed
//     AND repositoryHeadVerified

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Required vs Optional check policy
// ---------------------------------------------------------------------------

export type CheckRequirement = "required" | "optional";

// ---------------------------------------------------------------------------
// Runtime Verification Plan — what to execute and verify (NO DEFAULTS)
// ---------------------------------------------------------------------------

export interface HealthCheckDef {
  name: string;
  path: string;
  expectedStatus: number;
  timeoutMs: number;
  required: CheckRequirement;
}

export interface ApiJourneyStep {
  name: string;
  method: string;
  path: string;
  expectedStatus: number;
  body?: string;
  /** Capture a value from the response for use in subsequent steps. */
  capture?: string;
  /** Assert a value exists in the response. */
  assertions?: string[];
}

export interface ApiJourneyDef {
  name: string;
  description: string;
  required: CheckRequirement;
  setup?: string;
  steps: ApiJourneyStep[];
  teardown?: string;
}

export interface IntegrationCheckDef {
  name: string;
  type: string;
  required: CheckRequirement;
  /** How to verify: 'connectivity' | 'test-mode' | 'object-operation' | 'custom' */
  verificationMethod: string;
  /** Configuration for the verification (e.g., connection string key, test endpoint). */
  verificationConfig?: string;
}

export interface BackgroundJobCheckDef {
  name: string;
  type: string;
  required: CheckRequirement;
  /** How to trigger the job. */
  trigger: string;
  /** Observation window in ms. */
  observationWindowMs: number;
  /** Expected effect to observe. */
  expectedEffect: string;
}

export interface BrowserJourneyDef {
  name: string;
  url: string;
  required: CheckRequirement;
  steps: string[];
  assertions: string[];
  timeoutMs: number;
}

export interface RuntimeVerificationPlan {
  /** The exact immutable SHA to verify. Must match canonicalHeadSha. */
  repositoryHeadSha: string;
  /** The GitHub repo (owner/name) to clone. */
  githubRepo: string;
  /** The default branch (for freshness verification). */
  githubDefaultBranch: string;

  // Install stage — NO DEFAULTS. Must come from architecture.
  installCommands: string[];

  // Build stage — NO DEFAULTS.
  buildCommands: string[];

  // Startup stage — NO DEFAULTS.
  startCommand: string;
  expectedPort: number;
  startupTimeoutMs: number;

  // Health checks — each has required/optional policy.
  healthChecks: HealthCheckDef[];

  // API journeys — multi-step sequences with assertions.
  apiJourneys: ApiJourneyDef[];

  // Integration checks — executable verification operations.
  integrationChecks: IntegrationCheckDef[];

  // Background job checks — trigger + observation + assertion.
  backgroundJobChecks: BackgroundJobCheckDef[];

  // Browser journeys — steps + assertions.
  browserJourneys: BrowserJourneyDef[];

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
  required: CheckRequirement;
  error?: string;
}

export interface ApiJourneyResult {
  name: string;
  passed: boolean;
  required: CheckRequirement;
  stepsCompleted: number;
  stepsTotal: number;
  error?: string;
}

export interface IntegrationCheckResult {
  name: string;
  type: string;
  passed: boolean;
  required: CheckRequirement;
  verificationMethod: string;
  error?: string;
}

export interface BackgroundJobResult {
  name: string;
  type: string;
  passed: boolean;
  required: CheckRequirement;
  error?: string;
}

export interface BrowserJourneyResult {
  name: string;
  url: string;
  passed: boolean;
  required: CheckRequirement;
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
  // Exact revision (worker-reported — server will verify against canonicalHeadSha)
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
// Plan hashing — for evidence reproducibility
// ---------------------------------------------------------------------------

/**
 * Hash a RuntimeVerificationPlan for evidence reproducibility.
 * The hash is stored in RuntimeEvidence so the exact plan used can be verified.
 */
export function hashRuntimePlan(plan: RuntimeVerificationPlan): string {
  // Canonical JSON representation (sorted keys) for stable hashing.
  const canonical = JSON.stringify(plan, Object.keys(plan).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
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
 * Runtime verification (Phase 18) proves the application works.
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
// Plan derivation — NO DEFAULTS. Returns null if architecture is missing.
// ---------------------------------------------------------------------------

/**
 * Phase 18A: Derive a runtime verification plan from the architecture contract.
 *
 * NO DEFAULTS. If required runtime information is missing or cannot be parsed,
 * returns null (BLOCKED). Never guesses npm, ports, commands, or endpoints.
 *
 * The plan is derived from:
 *   - The architecture's deploymentModel (install/build/start commands + port)
 *   - The architecture's apiContracts (API journeys)
 *   - The architecture's integrations (integration checks)
 *   - The architecture's testingStrategy (what to verify)
 *
 * If the architecture doesn't declare runtime verification details, the project
 * cannot be runtime-verified.
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
    hash?: string | null;
    frozen?: boolean;
  } | null
): RuntimeVerificationPlan | null {
  // Phase 18A: No project SHA or repo → BLOCKED.
  if (!project.canonicalHeadSha || !project.githubRepo) return null;

  // Phase 18A: No architecture → BLOCKED (no defaults).
  if (!architecture) return null;

  // Phase 18A: Architecture must be frozen (no runtime verification on draft architecture).
  if (architecture.frozen === false) return null;

  let deploy: any = {};
  let apiContracts: any[] = [];
  let integrations: any[] = [];
  let testingStrategy: any = {};

  try {
    deploy = JSON.parse(architecture.deploymentModel || "{}");
    apiContracts = JSON.parse(architecture.apiContracts || "[]");
    integrations = JSON.parse(architecture.integrations || "[]");
    testingStrategy = JSON.parse(architecture.testingStrategy || "{}");
  } catch {
    // Phase 18A: Malformed architecture JSON → BLOCKED (no defaults).
    return null;
  }

  // Phase 18A: Deployment model MUST declare install/build/start commands + port.
  // No defaults. If missing → BLOCKED.
  if (!deploy.installCommands || !Array.isArray(deploy.installCommands) || deploy.installCommands.length === 0) {
    return null;
  }
  if (!deploy.buildCommands || !Array.isArray(deploy.buildCommands) || deploy.buildCommands.length === 0) {
    return null;
  }
  if (!deploy.startCommand || typeof deploy.startCommand !== "string") {
    return null;
  }
  if (!deploy.port || typeof deploy.port !== "number") {
    return null;
  }

  // Derive health checks from testing strategy or deployment model.
  const healthChecks: HealthCheckDef[] = [];
  const healthEndpoints = deploy.healthEndpoints || testingStrategy.healthEndpoints || [];
  for (const ep of healthEndpoints) {
    if (typeof ep === "object" && ep.path) {
      healthChecks.push({
        name: ep.name || `Health ${ep.path}`,
        path: ep.path,
        expectedStatus: ep.expectedStatus || 200,
        timeoutMs: ep.timeoutMs || 10000,
        required: ep.required || "required",
      });
    }
  }
  // If no health endpoints declared, that's acceptable — health checks are optional.
  // But if declared, they must have the right shape.

  // Derive API journeys from apiContracts.
  // Phase 18A: Each journey is a multi-step sequence.
  const apiJourneys: ApiJourneyDef[] = [];
  const journeyDefs = testingStrategy.apiJourneys || [];
  if (journeyDefs.length > 0) {
    for (const j of journeyDefs) {
      if (j.name && Array.isArray(j.steps)) {
        apiJourneys.push({
          name: j.name,
          description: j.description || "",
          required: j.required || "required",
          setup: j.setup,
          steps: j.steps.map((s: any) => ({
            name: s.name || s.path || "step",
            method: s.method || "GET",
            path: s.path,
            expectedStatus: s.expectedStatus || 200,
            body: s.body,
            capture: s.capture,
            assertions: s.assertions || [],
          })),
          teardown: j.teardown,
        });
      }
    }
  } else if (apiContracts.length > 0) {
    // Fall back to single-step journeys from API contracts.
    for (const a of apiContracts.slice(0, 10)) {
      if (a.path) {
        apiJourneys.push({
          name: a.name || a.path,
          description: `API contract: ${a.method || "GET"} ${a.path}`,
          required: "required",
          steps: [{
            name: a.name || a.path,
            method: a.method || "GET",
            path: a.path,
            expectedStatus: a.expectedStatus || 200,
            body: a.body,
            assertions: a.assertions || [],
          }],
        });
      }
    }
  }

  // Derive integration checks from integrations.
  const integrationChecks: IntegrationCheckDef[] = [];
  for (const i of integrations) {
    if (i.name) {
      integrationChecks.push({
        name: i.name,
        type: i.type || "unknown",
        required: i.required || "required",
        verificationMethod: i.verificationMethod || "connectivity",
        verificationConfig: i.verificationConfig ? JSON.stringify(i.verificationConfig) : undefined,
      });
    }
  }

  // Derive background job checks from testing strategy.
  const backgroundJobChecks: BackgroundJobCheckDef[] = [];
  const bgJobs = testingStrategy.backgroundJobs || [];
  for (const j of bgJobs) {
    if (j.name) {
      backgroundJobChecks.push({
        name: j.name,
        type: j.type || "unknown",
        required: j.required || "required",
        trigger: j.trigger || "manual",
        observationWindowMs: j.observationWindowMs || 5000,
        expectedEffect: j.expectedEffect || "",
      });
    }
  }

  // Derive browser journeys from testing strategy.
  const browserJourneys: BrowserJourneyDef[] = [];
  const browserJourneysDefs = testingStrategy.browserJourneys || [];
  for (const b of browserJourneysDefs) {
    if (b.name && b.url) {
      browserJourneys.push({
        name: b.name,
        url: b.url,
        required: b.required || "optional",
        steps: b.steps || [],
        assertions: b.assertions || [],
        timeoutMs: b.timeoutMs || 30000,
      });
    }
  }

  return {
    repositoryHeadSha: project.canonicalHeadSha,
    githubRepo: project.githubRepo,
    githubDefaultBranch: project.githubDefaultBranch || "main",
    installCommands: deploy.installCommands,
    buildCommands: deploy.buildCommands,
    startCommand: deploy.startCommand,
    expectedPort: deploy.port,
    startupTimeoutMs: deploy.startupTimeoutMs || 30000,
    healthChecks,
    apiJourneys,
    integrationChecks,
    backgroundJobChecks,
    browserJourneys,
    teardownTimeoutMs: 10000,
  };
}

// ---------------------------------------------------------------------------
// Result evaluation — plan-aware, required vs optional
// ---------------------------------------------------------------------------

export interface EvaluationResult {
  passed: boolean;
  failureReason: string | null;
  /** Detailed per-check breakdown for evidence. */
  breakdown: {
    requiredPassed: number;
    requiredFailed: number;
    requiredMissing: number;
    optionalPassed: number;
    optionalSkipped: number;
  };
}

/**
 * Phase 18A: Evaluate a runtime verification result against its plan.
 *
 * The evaluator receives BOTH the plan and the result so it can enforce
 * required vs optional checks.
 *
 * Evaluation rules:
 *   required + missing → UNVERIFIED (fail)
 *   required + fail → FAILED (fail)
 *   required + pass → PASS
 *   optional + missing → SKIPPED (ok)
 *   optional + fail → doesn't block
 *
 * Core stages (install, build, startup, teardown) are ALWAYS required.
 */
export function evaluateRuntimeVerificationResult(
  result: RuntimeVerificationResult,
  plan: RuntimeVerificationPlan
): EvaluationResult {
  const reasons: string[] = [];
  let requiredPassed = 0;
  let requiredFailed = 0;
  let requiredMissing = 0;
  let optionalPassed = 0;
  let optionalSkipped = 0;

  // Core stages are always required.
  if (!result.dependencyInstallResult.success) {
    reasons.push("dependencyInstall=FAILED");
  } else {
    requiredPassed++;
  }
  if (!result.buildResult.success) {
    reasons.push("build=FAILED");
  } else {
    requiredPassed++;
  }
  if (!result.startupResult.success) {
    reasons.push("startup=FAILED");
  } else {
    requiredPassed++;
  }

  // Health checks — required vs optional.
  for (const planCheck of plan.healthChecks) {
    const resultCheck = result.healthChecks.find((h) => h.name === planCheck.name);
    if (!resultCheck) {
      if (planCheck.required === "required") {
        reasons.push(`healthCheck=${planCheck.name}:MISSING`);
        requiredMissing++;
      } else {
        optionalSkipped++;
      }
    } else if (!resultCheck.passed) {
      if (planCheck.required === "required") {
        reasons.push(`healthCheck=${planCheck.name}:FAILED`);
        requiredFailed++;
      }
    } else {
      if (planCheck.required === "required") {
        requiredPassed++;
      } else {
        optionalPassed++;
      }
    }
  }

  // API journeys — required vs optional.
  for (const planJourney of plan.apiJourneys) {
    const resultJourney = result.apiJourneys.find((a) => a.name === planJourney.name);
    if (!resultJourney) {
      if (planJourney.required === "required") {
        reasons.push(`apiJourney=${planJourney.name}:MISSING`);
        requiredMissing++;
      } else {
        optionalSkipped++;
      }
    } else if (!resultJourney.passed) {
      if (planJourney.required === "required") {
        reasons.push(`apiJourney=${planJourney.name}:FAILED`);
        requiredFailed++;
      }
    } else {
      if (planJourney.required === "required") {
        requiredPassed++;
      } else {
        optionalPassed++;
      }
    }
  }

  // Integration checks — required vs optional.
  for (const planCheck of plan.integrationChecks) {
    const resultCheck = result.integrationChecks.find((i) => i.name === planCheck.name);
    if (!resultCheck) {
      if (planCheck.required === "required") {
        reasons.push(`integration=${planCheck.name}:MISSING`);
        requiredMissing++;
      } else {
        optionalSkipped++;
      }
    } else if (!resultCheck.passed) {
      if (planCheck.required === "required") {
        reasons.push(`integration=${planCheck.name}:FAILED`);
        requiredFailed++;
      }
    } else {
      if (planCheck.required === "required") {
        requiredPassed++;
      } else {
        optionalPassed++;
      }
    }
  }

  // Background job checks — required vs optional.
  for (const planCheck of plan.backgroundJobChecks) {
    const resultCheck = result.backgroundJobChecks.find((b) => b.name === planCheck.name);
    if (!resultCheck) {
      if (planCheck.required === "required") {
        reasons.push(`backgroundJob=${planCheck.name}:MISSING`);
        requiredMissing++;
      } else {
        optionalSkipped++;
      }
    } else if (!resultCheck.passed) {
      if (planCheck.required === "required") {
        reasons.push(`backgroundJob=${planCheck.name}:FAILED`);
        requiredFailed++;
      }
    } else {
      if (planCheck.required === "required") {
        requiredPassed++;
      } else {
        optionalPassed++;
      }
    }
  }

  // Browser journeys — required vs optional.
  for (const planJourney of plan.browserJourneys) {
    const resultJourney = result.browserJourneys.find((b) => b.name === planJourney.name);
    if (!resultJourney) {
      if (planJourney.required === "required") {
        reasons.push(`browserJourney=${planJourney.name}:MISSING`);
        requiredMissing++;
      } else {
        optionalSkipped++;
      }
    } else if (!resultJourney.passed) {
      if (planJourney.required === "required") {
        reasons.push(`browserJourney=${planJourney.name}:FAILED`);
        requiredFailed++;
      }
    } else {
      if (planJourney.required === "required") {
        requiredPassed++;
      } else {
        optionalPassed++;
      }
    }
  }

  // Teardown is always required.
  if (!result.teardownResult.success) {
    reasons.push("teardown=FAILED");
  } else {
    requiredPassed++;
  }

  const passed = reasons.length === 0;
  return {
    passed,
    failureReason: passed ? null : reasons.join(", "),
    breakdown: {
      requiredPassed,
      requiredFailed,
      requiredMissing,
      optionalPassed,
      optionalSkipped,
    },
  };
}

// ---------------------------------------------------------------------------
// Build event type for runtime verification (NOT PRODUCTION_READY)
// ---------------------------------------------------------------------------

/**
 * Phase 18A: Runtime verification produces RUNTIME_VERIFIED, not PRODUCTION_READY.
 * PRODUCTION_READY is only emitted by the complete canonical predicate.
 */
export const RUNTIME_VERIFIED_EVENT = "RUNTIME_VERIFIED" as const;
export const RUNTIME_VERIFICATION_FAILED_EVENT = "RUNTIME_VERIFICATION_FAILED" as const;
