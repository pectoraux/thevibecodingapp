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
import type { SandboxAttestation } from "@/lib/substrate-attestation";

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

  /**
   * Phase 18V: Observed substrate attestation from the install/build substrate
   * runs. Bound into the signed ExecutionEvidenceEnvelope. Null when the
   * substrate could not be established (gcc missing, unshare unavailable, etc.)
   * — the production gate fails-closed in that case.
   */
  substrateAttestation: SandboxAttestation | null;
}

// ---------------------------------------------------------------------------
// Plan hashing — for evidence reproducibility
// ---------------------------------------------------------------------------

/**
 * Phase 18B: Recursive canonical serialization for stable plan hashing.
 *
 * Rules:
 *   - Object keys are sorted recursively (at every nesting level).
 *   - Arrays preserve order (step order matters, command order matters).
 *   - Strings, numbers, booleans, null are canonicalized normally.
 *   - undefined values are omitted (not included in hash).
 *
 * This ensures semantically identical plans with different object insertion
 * order hash identically, while preserving the semantic meaning of arrays.
 */
function canonicalSerialize(value: any): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value.toString();
  if (typeof value === "number") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    // Arrays preserve order — each element is recursively canonicalized.
    return "[" + value.map(canonicalSerialize).join(",") + "]";
  }
  if (typeof value === "object") {
    // Objects: sort keys recursively.
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalSerialize(value[k]));
    return "{" + pairs.join(",") + "}";
  }
  return "null"; // Fallback for unexpected types.
}

/**
 * Hash a RuntimeVerificationPlan for evidence reproducibility.
 * The hash is stored in RuntimeEvidence so the exact plan used can be verified.
 *
 * Phase 18B: Uses recursive canonical serialization — object keys are sorted
 * at every nesting level, while array order is preserved.
 */
export function hashRuntimePlan(plan: RuntimeVerificationPlan): string {
  const canonical = canonicalSerialize(plan);
  return createHash("sha256").update(canonical).digest("hex");
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
  /**
   * Phase 18V: Now means "a verified substrate attestation was presented" —
   * NOT a config label. The route sets this to
   * `isSubstrateVerified(envelope.substrateAttestation)`. No attestation =>
   * false => PRODUCTION_READY blocked (fail-closed).
   */
  executionEnvironmentSandboxed: boolean;
  /**
   * Phase 18V: Explicit redundant flag — true iff the substrate attestation
   * was present AND passed `verifySubstrateAttestation`. Same value as
   * `executionEnvironmentSandboxed` (kept as an explicit field for clarity in
   * evidence records).
   */
  substrateAttestationVerified: boolean;
  /**
   * Phase 18Z-A: True iff the artifact manifest was present AND passed
   * `verifyArtifactManifest` (manifestHash matches content, launcher
   * signature valid, required artifact types present, no path traversal,
   * no duplicate ids, size limits respected, executionId bound).
   *
   * Fail-closed: null/missing manifest => false => PRODUCTION_READY blocked.
   * Forge never trusts "build.log exists" — it trusts
   * `sha256(build.log) === <signed manifest hash>`.
   */
  artifactManifestVerified: boolean;
  repositoryHeadVerified: boolean;
}

/**
 * Phase 18: The canonical production readiness predicate.
 *
 * PRODUCTION_READY requires BOTH static AND runtime verification.
 * Static inspection (Phase 17) proves the code looks correct.
 * Runtime verification (Phase 18) proves the application works.
 *
 * Phase 18V: Also requires a VERIFIED substrate attestation — proof that the
 * runtime execution ran inside a real isolation boundary (linux namespace +
 * seccomp + rlimits + cap-drop). No attestation => fail-closed.
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
    evidence.substrateAttestationVerified &&
    evidence.artifactManifestVerified &&
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
  if (!evidence.substrateAttestationVerified) reasons.push("substrateAttestation=NOT_VERIFIED (no verified isolation boundary — PRODUCTION_READY blocked, fail-closed)");
  if (!evidence.artifactManifestVerified) reasons.push("artifactManifest=NOT_VERIFIED (no signed content-addressed manifest — PRODUCTION_READY blocked, fail-closed)");
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

  // Phase 18B: NO DEFAULTS for any runtime values.
  // Every field must be explicitly declared by the frozen architecture.
  // Missing required fields → return null (BLOCKED).

  // startupTimeoutMs — MUST be declared.
  if (typeof deploy.startupTimeoutMs !== "number") {
    return null;
  }
  // teardownTimeoutMs — MUST be declared.
  if (typeof deploy.teardownTimeoutMs !== "number") {
    return null;
  }

  // Derive health checks from testing strategy or deployment model.
  // Phase 18B: If health endpoints are declared, every field must be explicit.
  // No defaults for expectedStatus, timeoutMs, or required.
  const healthChecks: HealthCheckDef[] = [];
  const healthEndpoints = deploy.healthEndpoints || testingStrategy.healthEndpoints || [];
  for (const ep of healthEndpoints) {
    if (typeof ep !== "object" || !ep.path) return null; // Malformed → BLOCKED.
    if (typeof ep.expectedStatus !== "number") return null;
    if (typeof ep.timeoutMs !== "number") return null;
    if (ep.required !== "required" && ep.required !== "optional") return null;
    healthChecks.push({
      name: ep.name || `Health ${ep.path}`, // name is cosmetic, not a runtime default
      path: ep.path,
      expectedStatus: ep.expectedStatus,
      timeoutMs: ep.timeoutMs,
      required: ep.required,
    });
  }

  // Derive API journeys from testing strategy.
  // Phase 18B: Every step field must be explicit. No defaults for method/status.
  const apiJourneys: ApiJourneyDef[] = [];
  const journeyDefs = testingStrategy.apiJourneys || [];
  if (journeyDefs.length > 0) {
    for (const j of journeyDefs) {
      if (!j.name || !Array.isArray(j.steps)) return null; // Malformed → BLOCKED.
      if (j.required !== "required" && j.required !== "optional") return null;
      const steps: ApiJourneyStep[] = [];
      for (const s of j.steps) {
        if (typeof s.method !== "string") return null; // No "GET" default.
        if (typeof s.path !== "string") return null;
        if (typeof s.expectedStatus !== "number") return null; // No 200 default.
        steps.push({
          name: s.name || s.path, // name is cosmetic
          method: s.method,
          path: s.path,
          expectedStatus: s.expectedStatus,
          body: s.body,
          capture: s.capture,
          assertions: Array.isArray(s.assertions) ? s.assertions : [],
        });
      }
      apiJourneys.push({
        name: j.name,
        description: j.description || "", // description is cosmetic
        required: j.required,
        setup: j.setup,
        steps,
        teardown: j.teardown,
      });
    }
  } else if (apiContracts.length > 0) {
    // Phase 18B: API-contract fallback is acceptable ONLY if the architecture
    // explicitly declares API contracts with method + expectedStatus.
    // No inventing missing method/status.
    for (const a of apiContracts.slice(0, 10)) {
      if (!a.path) return null; // Malformed → BLOCKED.
      if (typeof a.method !== "string") return null; // No "GET" default.
      if (typeof a.expectedStatus !== "number") return null; // No 200 default.
      apiJourneys.push({
        name: a.name || a.path,
        description: `API contract: ${a.method} ${a.path}`,
        required: "required",
        steps: [{
          name: a.name || a.path,
          method: a.method,
          path: a.path,
          expectedStatus: a.expectedStatus,
          body: a.body,
          assertions: Array.isArray(a.assertions) ? a.assertions : [],
        }],
      });
    }
  }

  // Derive integration checks from integrations.
  // Phase 18B: verificationMethod MUST be declared. No "connectivity" default.
  const integrationChecks: IntegrationCheckDef[] = [];
  for (const i of integrations) {
    if (!i.name) return null; // Malformed → BLOCKED.
    if (typeof i.verificationMethod !== "string") return null; // No default.
    if (i.required !== "required" && i.required !== "optional") return null;
    integrationChecks.push({
      name: i.name,
      type: i.type || "unknown", // type is descriptive, not a runtime default
      required: i.required,
      verificationMethod: i.verificationMethod,
      verificationConfig: i.verificationConfig ? JSON.stringify(i.verificationConfig) : undefined,
    });
  }

  // Derive background job checks from testing strategy.
  // Phase 18B: trigger, observationWindowMs, expectedEffect MUST be declared.
  const backgroundJobChecks: BackgroundJobCheckDef[] = [];
  const bgJobs = testingStrategy.backgroundJobs || [];
  for (const j of bgJobs) {
    if (!j.name) return null; // Malformed → BLOCKED.
    if (typeof j.trigger !== "string") return null; // No "manual" default.
    if (typeof j.observationWindowMs !== "number") return null; // No 5000 default.
    if (typeof j.expectedEffect !== "string") return null;
    if (j.required !== "required" && j.required !== "optional") return null;
    backgroundJobChecks.push({
      name: j.name,
      type: j.type || "unknown",
      required: j.required,
      trigger: j.trigger,
      observationWindowMs: j.observationWindowMs,
      expectedEffect: j.expectedEffect,
    });
  }

  // Derive browser journeys from testing strategy.
  // Phase 18B: required, timeoutMs MUST be declared. No defaults.
  const browserJourneys: BrowserJourneyDef[] = [];
  const browserJourneysDefs = testingStrategy.browserJourneys || [];
  for (const b of browserJourneysDefs) {
    if (!b.name || !b.url) return null; // Malformed → BLOCKED.
    if (b.required !== "required" && b.required !== "optional") return null; // No "optional" default.
    if (typeof b.timeoutMs !== "number") return null; // No 30000 default.
    browserJourneys.push({
      name: b.name,
      url: b.url,
      required: b.required,
      steps: Array.isArray(b.steps) ? b.steps : [],
      assertions: Array.isArray(b.assertions) ? b.assertions : [],
      timeoutMs: b.timeoutMs,
    });
  }

  return {
    repositoryHeadSha: project.canonicalHeadSha,
    githubRepo: project.githubRepo,
    githubDefaultBranch: project.githubDefaultBranch || "main", // branch is config, not runtime
    installCommands: deploy.installCommands,
    buildCommands: deploy.buildCommands,
    startCommand: deploy.startCommand,
    expectedPort: deploy.port,
    startupTimeoutMs: deploy.startupTimeoutMs, // No default — required above.
    healthChecks,
    apiJourneys,
    integrationChecks,
    backgroundJobChecks,
    browserJourneys,
    teardownTimeoutMs: deploy.teardownTimeoutMs, // No default — required above.
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
