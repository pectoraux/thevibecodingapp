// Forge — domain types and enums
// Central source of truth for project state machine, task states, agent roles.

// ---------------------------------------------------------------------------
// Project lifecycle state machine
// ---------------------------------------------------------------------------

export const ProjectStatus = {
  DRAFT: "DRAFT",
  ARCHITECTING: "ARCHITECTING",
  AWAITING_ARCHITECTURE_APPROVAL: "AWAITING_ARCHITECTURE_APPROVAL",
  ARCHITECTURE_FROZEN: "ARCHITECTURE_FROZEN",
  PREFLIGHT: "PREFLIGHT",
  BUILDING: "BUILDING",
  VERIFYING: "VERIFYING",
  BLOCKED: "BLOCKED",
  HUMAN_REVIEW_REQUIRED: "HUMAN_REVIEW_REQUIRED",
  PRODUCTION_READY: "PRODUCTION_READY",
  DEPLOYED: "DEPLOYED",
  FAILED: "FAILED",
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export const PROJECT_STATUS_ORDER: ProjectStatus[] = [
  ProjectStatus.DRAFT,
  ProjectStatus.ARCHITECTING,
  ProjectStatus.AWAITING_ARCHITECTURE_APPROVAL,
  ProjectStatus.ARCHITECTURE_FROZEN,
  ProjectStatus.PREFLIGHT,
  ProjectStatus.BUILDING,
  ProjectStatus.VERIFYING,
  ProjectStatus.PRODUCTION_READY,
  ProjectStatus.DEPLOYED,
];

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

export const TaskStatus = {
  PLANNED: "PLANNED",
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  REVIEWING: "REVIEWING",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
  COMPLETED: "COMPLETED",
  // P16B: INTEGRATION_PENDING and INTEGRATED are NOT TaskStatus values.
  // They are tracked in Task.integrationState, not Task.status.
  // Task.status represents EXECUTION state only.
  // Task.integrationState represents INTEGRATION state.
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

// ---------------------------------------------------------------------------
// Agent roles
// ---------------------------------------------------------------------------

export const AgentType = {
  ARCHITECT: "ARCHITECT",
  ARCHITECTURE_GUARDIAN: "ARCHITECTURE_GUARDIAN",
  CODE_REVIEWER: "CODE_REVIEWER",
  FRONTEND: "FRONTEND",
  BACKEND: "BACKEND",
  DATABASE: "DATABASE",
  INFRASTRUCTURE: "INFRASTRUCTURE",
  INTEGRATION: "INTEGRATION",
  QA: "QA",
} as const;
export type AgentType = (typeof AgentType)[keyof typeof AgentType];

export const AGENT_META: Record<
  AgentType,
  { label: string; description: string; color: string; permissions: string[] }
> = {
  ARCHITECT: {
    label: "Architect",
    description: "Designs the complete system before implementation begins.",
    color: "violet",
    permissions: ["read:repository", "write:architecture", "no:deployment"],
  },
  ARCHITECTURE_GUARDIAN: {
    label: "Architecture Guardian",
    description: "Prevents architecture drift. Read-only, constrained context.",
    color: "amber",
    permissions: ["read:architecture", "read:diff", "read:tests"],
  },
  CODE_REVIEWER: {
    label: "Code Reviewer",
    description: "Independent, skeptical, adversarial review of implementation.",
    color: "rose",
    permissions: ["read:repository", "read:architecture", "read:tests"],
  },
  FRONTEND: {
    label: "Frontend Agent",
    description: "Web UI, state management, accessibility, frontend tests.",
    color: "emerald",
    permissions: ["write:branch", "run:tests", "no:deployment"],
  },
  BACKEND: {
    label: "Backend Agent",
    description: "Services, APIs, business logic, persistence, auth.",
    color: "cyan",
    permissions: ["write:branch", "run:tests", "no:deployment"],
  },
  DATABASE: {
    label: "Database Agent",
    description: "Schemas, migrations, indexes, data integrity.",
    color: "orange",
    permissions: ["write:branch", "run:migrations", "no:deployment"],
  },
  INFRASTRUCTURE: {
    label: "Infrastructure Agent",
    description: "Docker, CI/CD, deployment, observability, secrets.",
    color: "slate",
    permissions: ["write:branch", "write:infra", "deploy:after_approval"],
  },
  INTEGRATION: {
    label: "Integration Agent",
    description: "Payments, email, SMS, OAuth, webhooks, third-party APIs.",
    color: "fuchsia",
    permissions: ["write:branch", "run:tests", "no:deployment"],
  },
  QA: {
    label: "QA Agent",
    description: "Unit, integration, E2E, regression, production-readiness.",
    color: "blue",
    permissions: ["write:branch", "run:tests", "no:deployment"],
  },
};

// ---------------------------------------------------------------------------
// LLM provider registry (capability-based routing)
// ---------------------------------------------------------------------------

export const ProviderKind = {
  ZAI: "zai",
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  GOOGLE: "google",
  XAI: "xai",
  LOCAL: "local",
} as const;
export type ProviderKind = (typeof ProviderKind)[keyof typeof ProviderKind];

export const MODEL_CAPABILITIES = [
  "coding",
  "reasoning",
  "architecture",
  "long_context",
  "vision",
  "tool_use",
  "speed",
  "cost",
  "context_window",
  "structured_output",
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[keyof typeof MODEL_CAPABILITIES];

// ---------------------------------------------------------------------------
// Architecture Guardian verdicts
// ---------------------------------------------------------------------------

export const GuardianVerdict = {
  PASS: "PASS",
  WARNING: "WARNING",
  VIOLATION: "VIOLATION",
  ARCHITECTURE_CHANGE_REQUIRED: "ARCHITECTURE_CHANGE_REQUIRED",
} as const;
export type GuardianVerdict = (typeof GuardianVerdict)[keyof typeof GuardianVerdict];

// ---------------------------------------------------------------------------
// Readiness gate categories
// ---------------------------------------------------------------------------

export const ReadinessCategory = {
  BUILD: "BUILD",
  STATIC: "STATIC",
  TESTS: "TESTS",
  RUNTIME: "RUNTIME",
  INTEGRATIONS: "INTEGRATIONS",
  DATA: "DATA",
  AUTH: "AUTH",
  ERRORS: "ERRORS",
  OBSERVABILITY: "OBSERVABILITY",
  SECURITY: "SECURITY",
  CONFIG: "CONFIG",
  DEPLOYMENT: "DEPLOYMENT",
} as const;
export type ReadinessCategory =
  (typeof ReadinessCategory)[keyof typeof ReadinessCategory];

// ---------------------------------------------------------------------------
// Build event types (audit log)
// ---------------------------------------------------------------------------

export const BuildEventType = {
  PROJECT_CREATED: "PROJECT_CREATED",
  PROVIDER_CONFIGURED: "PROVIDER_CONFIGURED",
  GITHUB_CONNECTED: "GITHUB_CONNECTED",
  ARCHITECTURE_GENERATED: "ARCHITECTURE_GENERATED",
  ARCHITECTURE_APPROVED: "ARCHITECTURE_APPROVED",
  ARCHITECTURE_FROZEN: "ARCHITECTURE_FROZEN",
  CHANGE_REQUEST_CREATED: "CHANGE_REQUEST_CREATED",
  PREFLIGHT_PASSED: "PREFLIGHT_PASSED",
  PREFLIGHT_FAILED: "PREFLIGHT_FAILED",
  BUILD_STARTED: "BUILD_STARTED",
  TASK_QUEUED: "TASK_QUEUED",
  TASK_STARTED: "TASK_STARTED",
  AGENT_INVOKED: "AGENT_INVOKED",
  FILES_CHANGED: "FILES_CHANGED",
  COMMIT: "COMMIT",
  TESTS_RUN: "TESTS_RUN",
  GUARDIAN_PASS: "GUARDIAN_PASS",
  GUARDIAN_WARNING: "GUARDIAN_WARNING",
  GUARDIAN_VIOLATION: "GUARDIAN_VIOLATION",
  REVIEW_PASSED: "REVIEW_PASSED",
  REVIEW_CHANGES_REQUESTED: "REVIEW_CHANGES_REQUESTED",
  TASK_COMPLETED: "TASK_COMPLETED",
  TASK_FAILED: "TASK_FAILED",
  REPAIR_TASK_CREATED: "REPAIR_TASK_CREATED",
  READINESS_GATE_PASSED: "READINESS_GATE_PASSED",
  READINESS_GATE_FAILED: "READINESS_GATE_FAILED",
  PRODUCTION_READY: "PRODUCTION_READY",
  HUMAN_REVIEW_REQUIRED: "HUMAN_REVIEW_REQUIRED",
  BLOCKED: "BLOCKED",
} as const;
export type BuildEventType =
  (typeof BuildEventType)[keyof typeof BuildEventType];

// ---------------------------------------------------------------------------
// Fake-impl detector patterns
// ---------------------------------------------------------------------------

export const SUSPICIOUS_PATTERNS: { pattern: string; severity: "high" | "medium" | "low"; label: string }[] = [
  { pattern: "TODO", severity: "low", label: "TODO" },
  { pattern: "FIXME", severity: "medium", label: "FIXME" },
  { pattern: "coming soon", severity: "high", label: "coming soon" },
  { pattern: "not implemented", severity: "high", label: "not implemented" },
  { pattern: "placeholder", severity: "medium", label: "placeholder" },
  { pattern: "// mock", severity: "high", label: "mock (commented)" },
  { pattern: "// stub", severity: "high", label: "stub (commented)" },
  { pattern: "// fake", severity: "high", label: "fake (commented)" },
  { pattern: "// dummy", severity: "high", label: "dummy (commented)" },
  { pattern: "temporary", severity: "medium", label: "temporary" },
  { pattern: "hardcoded response", severity: "high", label: "hardcoded response" },
  { pattern: "throw new Error(\"not implemented\")", severity: "high", label: "not implemented throw" },
  { pattern: "throw new Error('not implemented')", severity: "high", label: "not implemented throw" },
];
